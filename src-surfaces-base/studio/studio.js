// @version 2.5.7
"use strict";

const W = window; // used by 0D3e studioHost bridge

const MSG_ARCHIVE = "h2o-ext-archive:v1";
const LIST_ROW_OPS = ["listWorkbenchRows"];
const CHAT_ID_OPS = ["listAllChatIds", "listChatIds"];
const FOLDER_LIST_OPS = ["getFoldersList"];
const FOLDER_BINDING_OPS = ["resolveFolderBindings"];
const FOLDER_SET_OPS = ["setFolderBinding"];
const LABEL_CATALOG_OPS = ["getLabelsCatalog"];
const CATEGORY_CATALOG_OPS = ["getCategoriesCatalog"];
const CATEGORY_SET_OPS = ["setSnapshotCategory"];
const CATEGORY_RECLASSIFY_OPS = ["reclassifySnapshotCategory"];
const STUDIO_ARCHIVE_TIMEOUT_MS = 4500;
const STUDIO_BOOT_AUX_TIMEOUT_MS = 2500;
const FOLDER_FILTER_NONE = "__none__";
const FOLDER_SIDEBAR_UI_STATE = {
  showFolderCountPills: false,
};
const UI_PREFS_KEY = "h2o:archiveWorkbench:ui:vNext";
const EDIT_OVERRIDES_KEY = "h2o:archiveWorkbench:editOverrides:v1";
const CHAT_TITLE_STATE_KEY_PREFIX = "h2o:prm:cgx:library:chat-title:state:v1:";
const CHAT_TITLE_BOOT_KEY_PREFIX = "h2o:prm:cgx:library:chat-title:boot-cache:v1:";
const LEGACY_CHAT_TITLE_BOOT_KEY_PREFIX = "h2o:chat-title:boot-cache:v1:";
const INTERFACE_META_MIRROR_KEY_PREFIX = "h2o:prm:cgx:library:interface-meta:v1:";
const INTERFACE_META_KEY = "ho:chat-meta-v1";
const HEAT_OVERRIDE_KEY_PREFIX = "ho:chat-heat-override:";
const PIN_KEY_PREFIX = "ho:chat-pin:";
const ROW_TINT_KEY_PREFIX = "ho:chat-row-idx:";
const LIBRARY_SYNC_BROADCAST_KEY = "h2o:library:cross-surface:broadcast:v1";
const FOLDER_STATE_DATA_KEY = "h2o:prm:cgx:fldrs:state:data:v1";
const FOLDER_CLEANUP_AUDIT_KEY = "h2o:studio:folder-cleanup-audit:v1";
const FOLDER_MIRROR_REFRESH_AUDIT_KEY = "h2o:studio:folder-mirror-refresh-audit:v1";
const FOLDER_CLEANUP_CONFIRM_TEXT = "DELETE EMPTY CHROME FOLDERS";
const FOLDER_DUPLICATE_CLEANUP_CONFIRM_TEXT = "DELETE EMPTY DUPLICATE FOLDERS";
const FOLDER_DESKTOP_CLEANUP_CONFIRM_TEXT = "DELETE EMPTY DESKTOP FOLDERS";
const FOLDER_DESKTOP_MIRROR_REFRESH_CONFIRM_TEXT = "REFRESH DESKTOP FOLDER MIRROR";
const FOLDER_CLEANUP_DRY_RUN_FRESHNESS_MS = 5 * 60 * 1000;
const FOLDER_CLEANUP_APPLY_PREVIEW_CONFIRM_TEXT = "PREVIEW ONLY - NO CLEANUP";
const FOLDER_DESKTOP_ORPHAN_BINDING_CHAT_ID = "f5d1-test-chat-001";
const FOLDER_DESKTOP_ORPHAN_BINDING_FOLDER_ID = "f5d1-test-folder-b";
const FOLDER_DESKTOP_FINAL_F5D_FOLDER_ID = "f5d1-test-folder-b";
const FOLDER_DESKTOP_ORPHAN_BINDING_CONFIRM_TEXT = "REMOVE ORPHAN DESKTOP BINDING";
const FOLDER_LOCAL_REVIEW_OPERATOR_MODE_KEY = "h2o:studio:folder-local-review:operator-mode:v1";
const FOLDER_OPERATOR_MODE_CONFIRM_TEXT = "Operator Mode exposes folder review and cleanup tools. Use only for diagnostics.";
const FOLDER_LOCAL_REVIEW_EXPLANATION = "These folders exist locally but are not in your native ChatGPT folder catalog. Read-only — no cleanup performed.";
const FOLDER_LOCAL_REVIEW_BADGE_ORDER = ["extra", "test", "conflict", "desktop-only", "chrome-only", "review-required"];
const FOLDER_DESKTOP_MIRROR_CANONICAL_ROWS = Object.freeze([
  Object.freeze({ folderId: "f_7050f49d3f341819dba53d547", name: "Study" }),
  Object.freeze({ folderId: "f_5d9431084707f19dba53d548", name: "Case" }),
  Object.freeze({ folderId: "f_0606ea698948f19dba53d548", name: "Dev" }),
  Object.freeze({ folderId: "f_e301f3506938c19dbac0e304", name: "Code" }),
  Object.freeze({ folderId: "f_3bf15f43b835d19dbac0fb13", name: "Tech" }),
  Object.freeze({ folderId: "f_2bb1037f88b2719dbac10c22", name: "English" }),
]);
const FOLDER_DESKTOP_MIRROR_CANONICAL_COLORS = Object.freeze({
  f_7050f49d3f341819dba53d547: "#F472B6",
  f_5d9431084707f19dba53d548: "#3B82F6",
  f_0606ea698948f19dba53d548: "#22C55E",
  f_e301f3506938c19dbac0e304: "#A855F7",
  f_3bf15f43b835d19dbac0fb13: "#14B8A6",
  f_2bb1037f88b2719dbac10c22: "#FF914D",
});
const FOLDER_DESKTOP_MIRROR_REFRESH_STATE = {
  path: "",
  pastedJson: "",
  confirmation: "",
  preview: null,
  status: "",
};
const FOLDER_PARITY_SETTINGS_UI_STATE = {
  activeTab: "overview",
  cleanupSubtab: "overview",
  statuses: Object.create(null),
  sectionTabs: Object.create(null),
  cleanupDryRunPlan: null,
  cleanupApplyPreview: null,
};
const FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE = {
  selected: false,
  confirmation: "",
  preview: null,
  status: "",
};
const HEAT_LEVELS = new Set(["auto", "hot", "warm", "off"]);
const INTERFACE_COLORS = [
  { name: "gold", value: "rgba(212,175,55,1)" },
  { name: "red", value: "rgba(179,58,58,1)" },
  { name: "blue", value: "rgba(70,100,200,1)" },
  { name: "green", value: "rgba(60,150,90,1)" },
];

function studioTimeoutError(label, timeoutMs){
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.code = "timeout";
  return error;
}

function promiseWithTimeout(promise, timeoutMs, label){
  const ms = Math.max(1, Number(timeoutMs) || 1);
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(studioTimeoutError(label || "operation", ms)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function promiseWithTimeoutFallback(promise, timeoutMs, label, fallback){
  try {
    return await promiseWithTimeout(promise, timeoutMs, label);
  } catch (error) {
    try { console.warn("[H2O.Studio] " + String(label || "operation") + " unavailable", error); } catch {}
    return fallback;
  }
}

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  rowsCache: null,
  folderCatalog: [],
  folderLocalReview: [],
  labelCatalog: [],
  categoryCatalog: [],
  folderBindingsByChat: {},
  selectedSnapshotId: "",
  selectedChatId: "",
  lastView: "saved",
  lastFolderId: "",
  lastFetchDiag: null,
  currentReaderSnapshot: null,
  activeRoute: "list",
  sidebarExpanded: true,
  density: "cozy",
  layout: "focused",
  lastTagFilter: "",
  renderToken: 0,
  currentReaderEditOverrides: null,
  /* S4C: the currently mounted Reader render's { root, semanticIndex } (read-only bridge; cleared on unmount). */
  currentReaderRender: null,
  titleStateByChat: {},
  interfaceMetaByChat: {},
};

let activeRailPopoverButton = null;

// D2 blocker: expose a read-only accessor for the current reader chat
// context so the Studio Dock shell (dock-shell.studio.js) can route
// per-chat Dock tabs to the correct data buckets. Returns empty strings
// when no reader is open. Safe to call any time. Never mutates state.
//
// D3.2.2: getDockContext() generalizes eligibility beyond the reader
// route. A saved chat/editor can be shown in the #viewReader pane while
// body.dataset.route is still "list" (inline editor / linked placeholder
// under #/saved, or a route-timing window). Dock eligibility therefore
// keys off the reader PANE being visible (or an active reader snapshot),
// NOT off body.dataset.route. Read-only; never invents ids; returns
// empty ids + eligible:false when only the saved list is shown.
(function () {
  const H2O = W.H2O = W.H2O || {};
  H2O.Studio = H2O.Studio || {};

  H2O.Studio.getReaderContext = function () {
    const snap = state.currentReaderSnapshot;
    return {
      snapshotId: snap && snap.snapshotId ? String(snap.snapshotId) : "",
      chatId:     snap && snap.chatId     ? String(snap.chatId)     : "",
    };
  };

  H2O.Studio.getDockContext = function () {
    const snap = state.currentReaderSnapshot;
    if (snap) {
      return {
        snapshotId: snap.snapshotId ? String(snap.snapshotId) : "",
        chatId:     snap.chatId     ? String(snap.chatId)     : "",
        source: "reader",
        eligible: true,
      };
    }
    // No reader snapshot — check whether the reader/editor PANE is
    // showing a chat (inline editor / linked placeholder under any
    // route). The plain saved list keeps #viewReader hidden.
    let readerVisible = false;
    try {
      const reader = document.getElementById("viewReader");
      readerVisible = !!(reader && reader.hidden === false);
    } catch (_) { readerVisible = false; }
    if (readerVisible) {
      return {
        snapshotId: state.selectedSnapshotId ? String(state.selectedSnapshotId) : "",
        chatId:     state.selectedChatId     ? String(state.selectedChatId)     : "",
        source: "saved-editor",
        eligible: true,
      };
    }
    return { snapshotId: "", chatId: "", source: "none", eligible: false };
  };

  // M03 S4C: read-only bridge to the CURRENT Reader render's Semantic Index
  // for compatibility consumers (Reader & Notes). See getReaderSemanticIndex.
  H2O.Studio.getReaderSemanticIndex = getReaderSemanticIndex;
})();

function esc(s){
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function localReviewBadgeValues(item = {}){
  const values = new Set((Array.isArray(item.badges) ? item.badges : [])
    .map((badge) => String(badge || "").trim().toLowerCase())
    .filter(Boolean));
  if (item.isExtra) values.add("extra");
  if (item.isTestCandidate) values.add("test");
  if (item.isConflict) values.add("conflict");
  const bucket = String(item.reviewBucket || "").trim().toLowerCase();
  if (bucket) values.add(bucket);
  values.add("review-required");
  return FOLDER_LOCAL_REVIEW_BADGE_ORDER.filter((badge) => values.has(badge));
}

function localReviewBadgesHtml(item = {}){
  const badges = localReviewBadgeValues(item);
  if (!badges.length) return "";
  return `<span class="wbFolderLocalReviewBadges" style="display:flex;flex-wrap:wrap;gap:3px;margin-top:3px;min-width:0">${badges.map((badge) => (
    `<span class="wbFolderLocalReviewBadge wbFolderLocalReviewBadge--${esc(badge)}" title="${esc(badge)}" style="display:inline-flex;align-items:center;max-width:100%;border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:1px 5px;font-size:9.5px;line-height:1.25;color:rgba(255,255,255,.68);background:rgba(255,255,255,.045);text-transform:none;letter-spacing:0">${esc(badge)}</span>`
  )).join("")}</span>`;
}

function folderOperatorModeEnabled(){
  try {
    const explicit = W.H2O?.Studio?.folderLocalReviewOperatorMode;
    if (explicit === true) return true;
    if (explicit === false) return false;
  } catch {}
  try {
    const raw = W.localStorage?.getItem?.(FOLDER_LOCAL_REVIEW_OPERATOR_MODE_KEY);
    return raw === "1" || raw === "true";
  } catch {}
  return false;
}

function folderLocalReviewAppearanceAllowed(){
  try {
    const appearance = W.H2O?.Studio?.appearance;
    if (appearance && typeof appearance.get === "function") return appearance.get("showLocalReview") !== false;
  } catch {}
  return true;
}

function folderLocalReviewUiEnabled(){
  return folderOperatorModeEnabled() && folderLocalReviewAppearanceAllowed();
}

function applyFolderOperatorModeMarker(){
  try {
    document.documentElement.setAttribute("data-h2o-folder-operator-mode", folderOperatorModeEnabled() ? "on" : "off");
  } catch {}
}

function rerenderFolderOperatorModeSurfaces(){
  try { renderFolderSidebar(state.rowsCache || [], state.lastView, state.lastFolderId); } catch {}
  try {
    if (isVisibleStudioFoldersRoute()) renderVisibleStudioFoldersPageBody({ force: false }).catch(console.warn);
  } catch {}
}

function setFolderOperatorModeEnabled(enabled){
  const next = enabled === true;
  try { W.localStorage?.setItem?.(FOLDER_LOCAL_REVIEW_OPERATOR_MODE_KEY, next ? "1" : "0"); } catch {}
  try {
    W.H2O = W.H2O || {};
    W.H2O.Studio = W.H2O.Studio || {};
    W.H2O.Studio.folderLocalReviewOperatorMode = next;
  } catch {}
  applyFolderOperatorModeMarker();
  syncFolderOperatorModeDiagnosticsUi(document);
  try { W.dispatchEvent(new CustomEvent("evt:h2o:studio:folder-operator-mode-changed", { detail: { enabled: next } })); } catch {}
  rerenderFolderOperatorModeSurfaces();
  rerenderSettingsFolderOperatorModeRoute();
  return next;
}

function installFolderOperatorModeApi(){
  try {
    W.H2O = W.H2O || {};
    W.H2O.Studio = W.H2O.Studio || {};
    W.H2O.Studio.folderOperatorMode = {
      storageKey: FOLDER_LOCAL_REVIEW_OPERATOR_MODE_KEY,
      isEnabled: folderOperatorModeEnabled,
      setEnabled: setFolderOperatorModeEnabled,
      localReviewVisible: folderLocalReviewUiEnabled,
    };
  } catch {}
  applyFolderOperatorModeMarker();
}

installFolderOperatorModeApi();

function studioHostUnmount(reason = "studio:unmount") {
  state.currentReaderEditOverrides = null;
  state.currentReaderRender = null;
  try { W.H2O?.studioHost?.unmount?.(reason); } catch {}
}

/* M03 P4 S4C T8 (slice A) — current-render Semantic Index bridge.
 *
 * buildReaderDOM binds the Renderer result's read-only Semantic Index to the
 * Renderer root it describes; studioHostUnmount clears the binding, so every
 * Reader discard path (route leave, replace, missing, error) drops it with the
 * DOM. The accessor answers only for the current render: an unmatched root
 * yields null, nothing is searched in the DOM, and no index is ever created
 * or mutated here. This is Reader-owned current-render integration state -
 * never persisted, never a process-wide singleton, never a durable identity.
 * Nothing else of the render result (decoration lifecycle, navigation,
 * scrolling, Reader internals) is exposed. */
function bindReaderSemanticIndex(rendererResult){
  const root = rendererResult?.root;
  const semanticIndex = rendererResult?.semanticIndex;
  state.currentReaderRender = root && semanticIndex && typeof semanticIndex === "object"
    ? Object.freeze({ root, semanticIndex })
    : null;
}

function getReaderSemanticIndex(root){
  const current = state.currentReaderRender;
  if (!current) return null;
  if (root !== undefined && root !== current.root) return null;
  return current.semanticIndex;
}

function studioHostUnmountPreservingRouteHash(reason = "studio:route-leave") {
  const requestedHash = String(W.location?.hash || "");
  studioHostUnmount(reason);
  const readerEl = document.getElementById("viewReader");
  try {
    if (typeof readerEl?.replaceChildren === "function") readerEl.replaceChildren();
    else if (readerEl) readerEl.innerHTML = "";
  } catch {}
  if (!requestedHash || String(W.location?.hash || "") === requestedHash) return;

  // S0D3e restores the Studio URL that preceded its ChatGPT-compatible route
  // projection. Preserve the route transition that triggered this unmount so
  // leaving Reader cannot silently restore the obsolete read hash.
  try {
    const nextUrl = `${W.location.pathname}${W.location.search}${requestedHash}`;
    W.history.replaceState(
      Object.assign({}, W.history.state || {}, { h2oStudioReader: false }),
      "",
      nextUrl
    );
  } catch {
    try { W.location.hash = requestedHash; } catch {}
  }
}

function getStudioChatRenderer(){
  const renderer = W.H2O?.Studio?.chatRenderer;
  if (
    !renderer
    || typeof renderer.normalizeInput !== "function"
    || typeof renderer.isRenderEquivalent !== "function"
    || typeof renderer.render !== "function"
  ){
    throw new Error("Studio Chat Renderer is unavailable");
  }
  return renderer;
}

function isCurrentReaderRoot(root, snap){
  if (!root?.isConnected) return false;
  const readerEl = $("#viewReader");
  if (!readerEl || typeof readerEl.contains !== "function" || !readerEl.contains(root)) return false;

  const currentSnapshotId = String(state.currentReaderSnapshot?.snapshotId || "");
  const expectedSnapshotId = String(snap?.snapshotId || "");
  if (!currentSnapshotId || currentSnapshotId !== expectedSnapshotId) return false;

  const getHostRoot = W.H2O?.studioHost?.getReaderRoot;
  if (typeof getHostRoot === "function" && getHostRoot() !== root) return false;
  return true;
}

function getReusableReaderMount(snap){
  const snapshotId = String(snap?.snapshotId || "").trim();
  const currentSnapshotId = String(state.currentReaderSnapshot?.snapshotId || "").trim();
  if (!snapshotId || snapshotId !== currentSnapshotId) return null;

  const host = W.H2O?.studioHost;
  if (
    typeof host?.getReaderRoot !== "function"
    || typeof host?.getTurnsRoot !== "function"
    || typeof host?.getScrollRoot !== "function"
    || typeof host?.updateSnapshot !== "function"
  ) return null;

  const root = host.getReaderRoot();
  const turnsEl = host.getTurnsRoot();
  const scrollEl = host.getScrollRoot();
  const readerEl = $("#viewReader");
  if (!root?.isConnected || !turnsEl?.isConnected || !scrollEl?.isConnected) return null;
  if (!readerEl || typeof readerEl.contains !== "function" || !readerEl.contains(root)) return null;
  if (typeof root.contains !== "function" || !root.contains(turnsEl) || !root.contains(scrollEl)) return null;
  const selectors = W.H2O?.Studio?.SELECTORS || {};
  const testIdAttr = selectors.ATTR?.TESTID || "data-testid";
  const turnsTestId = selectors.TESTIDS?.CONVERSATION_TURNS || "conversation-turns";
  if (root.getAttribute?.("data-h2o-studio-reader") !== "1") return null;
  if (turnsEl.getAttribute?.(testIdAttr) !== turnsTestId) return null;
  if (scrollEl.getAttribute?.("data-scroll-root") !== "1") return null;
  return { root, turnsEl, scrollEl };
}

function isReusableReaderMountCurrent(mount, snap){
  if (!mount) return false;
  const current = getReusableReaderMount(snap);
  return !!(
    current
    && current.root === mount.root
    && current.turnsEl === mount.turnsEl
    && current.scrollEl === mount.scrollEl
  );
}

function collectRendererEditOverrides(rendererInput){
  const snapshotId = String(rendererInput?.snapshotId || "").trim();
  const richTurns = Array.isArray(rendererInput?.richTurns) ? rendererInput.richTurns : [];
  const messages = Array.isArray(rendererInput?.messages) ? rendererInput.messages : [];
  const hasCompleteRichCoverage = !!richTurns.length && (!messages.length || richTurns.length === messages.length);
  if (!snapshotId || !hasCompleteRichCoverage) return [];
  return richTurns.map((turn) => {
    const role = String(turn?.role || "");
    if (role && role !== "assistant") return null;
    return getEditOverride(snapshotId, turn?.turnIdx);
  });
}

function haveEquivalentRendererEditOverrides(leftRaw, rightRaw){
  const left = Array.isArray(leftRaw) ? leftRaw : [];
  const right = Array.isArray(rightRaw) ? rightRaw : [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1){
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function canReuseReaderDOM(options){
  options = options && typeof options === "object" ? options : {};
  const renderer = getStudioChatRenderer();
  return !!(
    options.mount
    && options.token === state.renderToken
    && state.activeRoute === "reader"
    && state.currentReaderSnapshot === options.previousSnapshot
    && isReusableReaderMountCurrent(options.mount, options.previousSnapshot)
    && renderer.isRenderEquivalent(options.previousSnapshot, options.rendererInput)
    && haveEquivalentRendererEditOverrides(options.previousEditOverrides, options.nextEditOverrides)
  );
}

// ─── Edit-override persistence ────────────────────────────────────────────────
// Stores user edits keyed by `${snapshotId}:${turnIdx}` in localStorage.
// Extension-page localStorage is isolated to the extension origin, so these
// overrides persist across Studio sessions but never leak to chatgpt.com.

function editOverrideKey(snapshotId, turnIdx){
  return `${EDIT_OVERRIDES_KEY}:${snapshotId}:${String(turnIdx)}`;
}

function getEditOverride(snapshotId, turnIdx){
  try { return localStorage.getItem(editOverrideKey(snapshotId, turnIdx)) ?? null; } catch { return null; }
}

function setEditOverride(snapshotId, turnIdx, text){
  try { localStorage.setItem(editOverrideKey(snapshotId, turnIdx), String(text)); return true; } catch { return false; }
}

function deleteEditOverridesForSnapshot(snapshotId){
  try {
    const prefix = `${EDIT_OVERRIDES_KEY}:${snapshotId}:`;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++){
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) keys.push(k);
    }
    keys.forEach((k) => { try { localStorage.removeItem(k); } catch {} });
  } catch {}
}

// Persists an edit into the extension-stored snapshot so exported bundles
// reflect what the user sees. Fire-and-forget; localStorage override remains
// the authoritative source for the current Studio session.
function persistEditToExtensionSnapshot(snapshotId, turnIdx, newText){
  const snap = state.currentReaderSnapshot;
  if (!snap || String(snap.snapshotId || "") !== String(snapshotId || "")) return;
  const messages = Array.isArray(snap.messages) ? snap.messages : [];
  const targetOrder = Number(turnIdx) - 1; // turnIdx is 1-based over all turns
  const nowStr = new Date().toISOString();
  const editedMessages = messages.map((msg) => {
    if (Number(msg.order) !== targetOrder) return { ...msg };
    const originalText = msg.originalText !== undefined ? msg.originalText : String(msg.text || "");
    return { ...msg, text: newText, editedAt: nowStr, originalText };
  });
  // Keep in-memory snapshot current so subsequent edits in this session build on the
  // correct state (each edit would otherwise use the original captured text as base).
  state.currentReaderSnapshot = { ...snap, messages: editedMessages };
  const meta = {
    ...(snap.meta && typeof snap.meta === "object" ? snap.meta : {}),
    updatedAt: nowStr,
  };
  callArchive("captureSnapshot", {
    chatId: String(snap.chatId || ""),
    messages: editedMessages,
    meta,
  }).catch(() => {});
}

// ─── Delete-confirm state ─────────────────────────────────────────────────────
// Two-click pattern: first click arms the icon, second click within the
// timeout executes the delete.

const DELETE_ICON_HTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4h12M5 4V2.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V4M6 7v5M10 7v5M3 4l.8 9.1a.6.6 0 0 0 .6.9h7.2a.6.6 0 0 0 .6-.9L13 4"/></svg>`;
const INFO_ICON_HTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.8"/><path d="M8 7.3v3.6M8 5.1h.01"/></svg>`;
const PIN_ICON_HTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.7 1.9 4.4 4.4-1.6 1.6-2.1-.6-2.5 2.5.4 2.5-1 1-2.6-2.6-2.8 2.8-.7-.7 2.8-2.8-2.6-2.6 1-1 2.5.4 2.5-2.5-.6-2.1 1.6-1.6Z"/></svg>`;

const deleteConfirm = {
  chatId: "",
  snapshotId: "",
  articleEl: null,
  timer: null,
};

let titlePaletteEl = null;

function armDeleteConfirm(chatId, snapshotId, articleEl, btnEl){
  clearDeleteConfirm();
  deleteConfirm.chatId = chatId;
  deleteConfirm.snapshotId = snapshotId;
  deleteConfirm.articleEl = articleEl;
  articleEl.classList.add("wbHistoryRow--deleting");
  btnEl.innerHTML = DELETE_ICON_HTML;
  btnEl.setAttribute("aria-label", "Click again to delete this chat from Studio");
  btnEl.setAttribute("title", "Click again to delete");
  btnEl.classList.add("wbDeleteBtn--armed");
  deleteConfirm.timer = setTimeout(() => clearDeleteConfirm(), 3000);
}

function clearDeleteConfirm(){
  clearTimeout(deleteConfirm.timer);
  const el = deleteConfirm.articleEl;
  if (el){
    el.classList.remove("wbHistoryRow--deleting");
    const btn = el.querySelector(".wbDeleteBtn");
    if (btn){
      btn.innerHTML = DELETE_ICON_HTML;
      btn.classList.remove("wbDeleteBtn--armed");
      btn.setAttribute("aria-label", "Delete this chat from Studio");
      btn.setAttribute("title", "Delete from Studio");
    }
  }
  deleteConfirm.chatId = "";
  deleteConfirm.snapshotId = "";
  deleteConfirm.articleEl = null;
  deleteConfirm.timer = null;
}

async function executeDeleteChat(chatId, snapshotId, articleEl){
  clearDeleteConfirm();
  articleEl.classList.add("wbHistoryRow--removing");

  try {
    // Attempt canonical deleteAllSnapshots op first, fall back to deleteSnapshot.
    let deleted = false;
    try {
      await callArchive("deleteAllSnapshots", { chatId });
      deleted = true;
    } catch {
      try { await callArchive("deleteSnapshot", { snapshotId, chatId }); deleted = true; } catch {}
    }

    // Always remove edit overrides for this snapshot locally
    deleteEditOverridesForSnapshot(snapshotId);

    // Remove from rows cache
    if (Array.isArray(state.rowsCache)){
      state.rowsCache = state.rowsCache.filter((r) => r.chatId !== chatId);
    }

    // Animate out then remove the DOM row
    await new Promise((res) => setTimeout(res, 260));
    articleEl.remove();

    // If the deleted chat was open in the reader, navigate back to list
    if (state.selectedChatId === chatId || state.currentReaderSnapshot?.chatId === chatId){
      state.selectedSnapshotId = "";
      state.selectedChatId = "";
      state.currentReaderSnapshot = null;
      location.hash = "#/saved";
    } else {
      // Refresh counts in sidebar
      const route = parseHash();
      renderFolderSidebar(state.rowsCache || [], state.lastView, state.lastFolderId);
      renderSidebarChatList(state.rowsCache || [], route.view, state.lastFolderId);
      syncSelectionControls();
    }
  } catch (err){
    articleEl.classList.remove("wbHistoryRow--removing");
    console.warn("[Studio] Delete failed:", err);
  }
}

// ─── Turn edit UI ─────────────────────────────────────────────────────────────

function extractTurnPlaintext(frameEl){
  // Walk the frame element and extract readable text, preserving code blocks
  // with newlines so the edit textarea is usable.
  try {
    const clone = frameEl.cloneNode(true);
    // Replace code blocks with fenced markdown so edits round-trip sensibly
    clone.querySelectorAll("pre code, pre").forEach((pre) => {
      const lang = pre.className?.match(/language-(\S+)/)?.[1] || "";
      const text = pre.textContent || "";
      const placeholder = document.createTextNode(`\n\`\`\`${lang}\n${text}\n\`\`\`\n`);
      pre.replaceWith(placeholder);
    });
    return (clone.textContent || "").trim();
  } catch {
    return (frameEl.textContent || "").trim();
  }
}

function mountEditTextarea(hostEl, snapshotId, turnIdx, originalText, onSave, onCancel, opts){
  hostEl.innerHTML = "";
  hostEl.classList.add("wbTurn--editing");

  /* Phase 7b repair — the wrap is a .cgMsgBody so the textarea
   * inherits the same font/size/line-height/color as the rendered
   * message body. The outer .wbEditWrap is just for actions row
   * structure; visual identity comes from the .wbTurn--editing host
   * shadow (see studio.css). */
  const wrap = document.createElement("div");
  wrap.className = "cgMsgBody wbEditWrap";

  const textarea = document.createElement("textarea");
  textarea.className = "wbEditTextarea";
  textarea.value = originalText;
  textarea.rows = Math.min(Math.max(originalText.split("\n").length + 2, 4), 28);
  textarea.setAttribute("spellcheck", "true");
  textarea.setAttribute("autocomplete", "off");

  const actions = document.createElement("div");
  actions.className = "wbEditActions";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "wbBtn wbBtnPrimary wbEditSaveBtn";
  saveBtn.textContent = "Save edit";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "wbBtn wbEditCancelBtn";
  cancelBtn.textContent = "Cancel";

  actions.append(saveBtn, cancelBtn);
  wrap.append(textarea, actions);
  hostEl.appendChild(wrap);
  /* Phase 7b repair — focus + caret on next frame so the focus survives
   * any synchronous mutations triggered by the click path that mounted
   * us (the selection handler runs first, then this mount). */
  try {
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
  } catch (_) { /* swallow */ }
  setTimeout(function () {
    try {
      if (document.activeElement !== textarea) textarea.focus();
    } catch (_) { /* swallow */ }
  }, 0);

  /* Phase 7b — Two save paths. Default (legacy pencil): writes the
   * localStorage edit-override + mutates the in-memory snapshot via
   * persistEditToExtensionSnapshot. Overlay path (Edit-Mode button):
   * opts.persistViaOverlay === true → skip BOTH legacy writes; instead
   * call opts.applyOverlayOp(newText) which is expected to dispatch a
   * `text-replace` overlay op via RibbonBridge.applyOverlayOp. onSave
   * still fires with newText so the caller can repaint via
   * applyEditedMessageBody. */
  const persistViaOverlay = !!(opts && opts.persistViaOverlay);
  const applyOverlayOp = opts && typeof opts.applyOverlayOp === 'function'
    ? opts.applyOverlayOp
    : null;

  saveBtn.addEventListener("click", (ev) => {
    /* Phase 7b repair — stop propagation so the click never reaches the
     * reader's selection handler, which would re-process the click
     * and potentially re-mount the editor or move the selection ring
     * out of the editing turn. */
    try { ev.stopPropagation(); } catch (_) {}
    try { ev.preventDefault(); } catch (_) {}
    const newText = textarea.value;
    if (persistViaOverlay) {
      /* Phase 7b — overlay path. Do NOT touch localStorage override,
       * do NOT mutate snapshot.messages. Dispatch the text-replace op
       * via the supplied callback; onSave repaints the reader. */
      try {
        if (applyOverlayOp) applyOverlayOp(newText);
      } catch (_) { /* swallow — caller's responsibility to surface */ }
      onSave(newText);
      return;
    }
    /* Legacy path (pencil). Untouched until Phase 7e removes it. */
    setEditOverride(snapshotId, turnIdx, newText);
    persistEditToExtensionSnapshot(snapshotId, turnIdx, newText);
    onSave(newText);
  });
  cancelBtn.addEventListener("click", (ev) => {
    try { ev.stopPropagation(); } catch (_) {}
    try { ev.preventDefault(); } catch (_) {}
    onCancel();
  });

  // Ctrl/Cmd+Enter saves
  textarea.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter"){
      ev.preventDefault();
      saveBtn.click();
    }
    if (ev.key === "Escape"){
      ev.preventDefault();
      cancelBtn.click();
    }
  });

  return { textarea, saveBtn, cancelBtn };
}

/* Phase 7b — mount the overlay-dispatched editor on a turn. Called by the
 * reader click handler when the user clicks an already-selected turn while
 * the Format-tab Edit Mode toggle is on. Repaints edited content through the
 * canonical Renderer API; Save dispatches a `text-replace` overlay op via
 * RibbonBridge.applyOverlayOp without mutating snapshot.messages. */
function __mountOverlayEditorOnTurn(turnEl, snap, turnIdx) {
  try {
    if (!(turnEl instanceof Element) || !snap) return;
    if (turnEl.classList.contains('wbTurn--editing')) return;
    const messageEl = turnEl.querySelector('[data-message-author-role]');
    if (!messageEl) return;
    const role = String(messageEl.getAttribute('data-message-author-role') || '');
    if (!role) return;
    const messageId = String(turnEl.getAttribute('data-message-id') || '');
    /* Phase 7b repair 6 — IN-PLACE editing via contentEditable on the
     * existing rendered text. The textarea-in-a-box approach was the
     * wrong UX: the editor changed the message shape, added Save/Cancel
     * controls under the text, and required a separate visual shell.
     * The user wants the rendered text itself to become editable while
     * preserving its exact layout/typography/width/wrapping, with no
     * separate controls. contentEditable on the message body is the
     * only DOM surface that achieves this — a textarea cannot reproduce
     * the rendered markdown structure (paragraph margins, lists, code
     * blocks). We use contentEditable strictly as an editing surface;
     * persistence still flows through the text-replace overlay op
     * (NEVER the snapshot). Auto-save fires on blur OR click-outside;
     * revert is handled by the existing Ribbon Undo/Redo (Phase 2d
     * active-set machinery). No Save/Cancel buttons. */
    /* Phase 7b repair 7 — restrict the editable target to the actual
     * message body. NEVER editable: title bars, timestamps, "Thought
     * for ..." annotations, page dividers, or any sibling metadata
     * that lives on the turn or messageEl but outside the body. For
     * canonical messages, .cgMsgBody is the body wrapper applyEdited
     * MessageBody / buildCanonicalTurn always creates. For rich
     * ChatGPT DOM messages (mountRichTurns), the body wrapper may not
     * exist — we flatten to canonical-body structure so editing always
     * targets a known clean wrapper. Save preserves text via the
     * text-replace overlay op; cancel-without-change restores the
     * original HTML below. */
    const originalHTML = messageEl.innerHTML;
    const originalText = extractTurnPlaintext(messageEl);
    let editable = messageEl.querySelector('.cgMsgBody');
    let flattenedFromRich = false;
    if (!editable) {
      try {
        getStudioChatRenderer().applyEditedMessageBody(messageEl, role, originalText);
        editable = messageEl.querySelector('.cgMsgBody');
        flattenedFromRich = true;
      } catch (_) { /* swallow — fall through to no-edit */ }
      if (!editable) return;
    }
    let committed = false;
    function commitAndExit(opts) {
      if (committed) return;
      committed = true;
      const dispatch = !!(opts && opts.dispatch);
      try { editable.removeEventListener('blur', onBlur, true); } catch (_) {}
      try { editable.removeEventListener('keydown', onKeyDown, true); } catch (_) {}
      try { document.removeEventListener('mousedown', onDocMouseDown, true); } catch (_) {}
      try { editable.removeAttribute('contenteditable'); } catch (_) {}
      try { editable.removeAttribute('spellcheck'); } catch (_) {}
      try { turnEl.classList.remove('wbTurn--editing'); } catch (_) {}
      try { messageEl.classList.remove('wbTurn--editing'); } catch (_) {}
      if (!dispatch) {
        /* Cancel — if we flattened a rich message just to mount the
         * editor, restore its original HTML so the user doesn't lose
         * rich formatting on a cancel-without-edit. */
        if (flattenedFromRich) {
          try { messageEl.innerHTML = originalHTML; } catch (_) {}
        }
        return;
      }
      const newText = String((editable.textContent || '')).replace(/\s+$/g, '');
      if (newText === originalText) {
        /* Auto-save fired but text unchanged. Same restore as cancel. */
        if (flattenedFromRich) {
          try { messageEl.innerHTML = originalHTML; } catch (_) {}
        }
        return;
      }
      try {
        const bridge = W.H2O && W.H2O.Studio && W.H2O.Studio.RibbonBridge;
        if (bridge && typeof bridge.applyOverlayOp === 'function') {
          bridge.applyOverlayOp({
            type: 'text-replace',
            target: { kind: 'message', turnIdx: Number(turnIdx) || 0, messageId: messageId || null },
            payload: { text: newText },
          });
        }
      } catch (_) { /* swallow — overlay store unavailable; in-DOM edit still visible until next render */ }
    }
    function onBlur() { commitAndExit({ dispatch: true }); }
    function onKeyDown(ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        commitAndExit({ dispatch: true });
      }
    }
    function onDocMouseDown(ev) {
      try {
        if (!turnEl.contains(ev.target)) commitAndExit({ dispatch: true });
      } catch (_) { commitAndExit({ dispatch: true }); }
    }
    /* Mark editing + make editable */
    try { turnEl.classList.add('wbTurn--editing'); } catch (_) {}
    try { editable.setAttribute('contenteditable', 'true'); } catch (_) {}
    try { editable.setAttribute('spellcheck', 'true'); } catch (_) {}
    /* Wire listeners. Capture-phase so we run before any other
     * focusing logic in the reader/ribbon. */
    try { editable.addEventListener('blur', onBlur, true); } catch (_) {}
    try { editable.addEventListener('keydown', onKeyDown, true); } catch (_) {}
    try { document.addEventListener('mousedown', onDocMouseDown, true); } catch (_) {}
    /* Focus + caret at end on next tick (avoid the selection click
     * that mounted us stealing focus back). */
    setTimeout(function () {
      try {
        editable.focus();
        const r = document.createRange();
        r.selectNodeContents(editable);
        r.collapse(false);
        const sel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null;
        if (sel) { sel.removeAllRanges(); sel.addRange(r); }
      } catch (_) { /* swallow */ }
    }, 0);
  } catch (_) { /* swallow — editor mount must never break the reader */ }
}

function normalizeText(s){
  return String(s || "").replace(/\s+/g, " ").trim();
}


let readerTopOffsetRaf = 0;

function syncReaderTopOffset(){
  if (readerTopOffsetRaf) cancelAnimationFrame(readerTopOffsetRaf);
  readerTopOffsetRaf = requestAnimationFrame(() => {
    readerTopOffsetRaf = 0;
    try {
      const visibleBottoms = [document.querySelector(".wbRibbon:not([hidden])"), document.querySelector(".wbTop")]
        .filter((el) => el instanceof Element)
        .map((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden" || r.height <= 0) return 0;
          return Math.ceil(r.bottom);
        });
      const bottom = Math.max(0, ...visibleBottoms);
      const offset = Math.max(72, bottom + 12);
      document.documentElement.style.setProperty("--wb-reader-top-offset", `${offset}px`);
    } catch {}
  });
}

try {
  window.addEventListener("resize", syncReaderTopOffset, { passive: true });
  window.addEventListener("evt:h2o:studio:ribbon:context-changed", syncReaderTopOffset, { passive: true });
  window.addEventListener("evt:h2o:studio:ribbon:tab-changed", syncReaderTopOffset, { passive: true });
  window.addEventListener("evt:h2o:studio:ribbon:collapsed-changed", syncReaderTopOffset, { passive: true });
} catch {}


function normalizeArchiveView(raw){
  const view = String(raw || "").trim().toLowerCase();
  if (view === "pinned") return "pinned";
  if (view === "archive") return "archive";
  /* Phase K-1 — Linked Chats view. Records with state.isLinked && !state.isSaved
   * (registered via Add-to-Library but never captured as a snapshot) carry
   * view: 'linked' end-to-end through Library Index, the row normalizers,
   * filterRows, and renderRow. The visible tab pill is the responsibility
   * of a separate Library Insights touch — studio.js owns only the hash
   * route + list + reader placeholder for #/linked. */
  if (view === "linked") return "linked";
  return "saved";
}

function normalizeFolderFilter(raw){
  return String(raw || "").trim();
}

function normalizeDensity(raw){
  return String(raw || "").trim().toLowerCase() === "compact" ? "compact" : "cozy";
}

function normalizeLayout(raw){
  return String(raw || "").trim().toLowerCase() === "wide" ? "wide" : "focused";
}

function uniqStrings(arr){
  return [...new Set((Array.isArray(arr) ? arr : []).map((v) => String(v || "").trim()).filter(Boolean))];
}

function countAssistantTurns(messages){
  const normalizeRendererRole = getStudioChatRenderer().normalizeRole;
  return (Array.isArray(messages) ? messages : []).reduce(
    (n, row) => n + (normalizeRendererRole(row?.role) === "assistant" ? 1 : 0),
    0
  );
}

function pluralize(count, singular, plural = `${singular}s`){
  return `${count} ${count === 1 ? singular : plural}`;
}

function fmtDate(iso){
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(String(iso)));
  } catch {
    return "";
  }
}

function fmtDateCompact(iso){
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(new Date(String(iso)));
  } catch {
    return "";
  }
}

function toTimestampMs(value){
  if (value == null || value === "") return 0;
  if (value instanceof Date) {
    const n = value.getTime();
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000 ? Math.round(numeric * 1000) : Math.round(numeric);
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function timestampToIso(value){
  const ms = toTimestampMs(value);
  if (!ms) return "";
  try { return new Date(ms).toISOString(); } catch { return ""; }
}

function firstTimestamp(...values){
  for (const value of values){
    const iso = timestampToIso(value);
    if (iso) return iso;
  }
  return "";
}

function fmtDateMeta(value){
  const ms = toTimestampMs(value);
  if (!ms) return "";
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, "0");
  const mon = d.toLocaleString(undefined, { month: "short" });
  const yy = d.getFullYear();
  return `${dd} ${mon} ${yy}`;
}

function toWholeCount(value, fallback = 0){
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

function toRowTintIndex(value, fallback = -1){
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const idx = Math.floor(n);
  return idx >= 0 && idx < INTERFACE_COLORS.length ? idx : -1;
}

function normalizeHeatLevel(value){
  const level = String(value || "").trim().toLowerCase();
  return HEAT_LEVELS.has(level) ? level : "auto";
}

function readLocalJson(key, fallback = null){
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function decodeSharedRecord(value){
  if (value == null) return null;
  if (typeof value === "object") return value;
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("\x00LZb64:")) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function hasChromeStorage(){
  try {
    return !!(W.chrome && W.chrome.storage && W.chrome.storage.local && typeof W.chrome.storage.local.get === "function");
  } catch {
    return false;
  }
}

// Persisted across sessions so the toolbar icon (background's openOrFocusStudio)
// can restore the user to their last route. Distinct from LAST_LIST_HASH_KEY,
// which is sessionStorage-scoped and tracks the most recent non-reader hash for
// the topbar Close button within a single tab.
const STUDIO_LAST_HASH_KEY = "h2o:studio:lastHash";

function persistStudioLastHash(hash){
  try {
    if (!hasChromeStorage() || !W.chrome?.storage?.local?.set) return;
    const value = String(hash || "").trim();
    if (!value || !value.startsWith("#")) return;
    W.chrome.storage.local.set({ [STUDIO_LAST_HASH_KEY]: value }, () => {
      void W.chrome.runtime?.lastError;
    });
  } catch {}
}

// Presence heartbeat — written on boot, hashchange, visibilitychange, and once
// every 10s while the tab exists. The background SW reads this on
// chrome.runtime.onInstalled / onStartup to decide whether to auto-restore
// the Studio tab after the user reloads the extension from chrome://extensions
// (which invalidates the page context). A fresh lastSeenAt within ~3 min is
// the signal "Studio was alive recently — bring it back".
//
// The presence record is intentionally small: open + lastHash + lastSeenAt +
// runtimeId. We never write open:false on unload (page-teardown can't run
// async chrome.storage reliably); staleness of lastSeenAt is the safer
// freshness signal.
const STUDIO_PRESENCE_KEY = "h2o:studio:presence:v1";
const STUDIO_PRESENCE_HEARTBEAT_MS = 10 * 1000;

function persistStudioPresence(){
  try {
    if (!hasChromeStorage() || !W.chrome?.storage?.local?.set) return;
    const rec = {
      open: true,
      lastHash: String(location.hash || "#/saved"),
      lastSeenAt: Date.now(),
      runtimeId: (W.chrome && W.chrome.runtime && W.chrome.runtime.id) || "",
    };
    W.chrome.storage.local.set({ [STUDIO_PRESENCE_KEY]: rec }, () => {
      void W.chrome.runtime?.lastError;
    });
  } catch {}
}

function chromeStorageGet(keys){
  if (!hasChromeStorage()) return Promise.resolve({});
  return new Promise((resolve) => {
    try {
      W.chrome.storage.local.get(keys, (result) => resolve(result || {}));
    } catch {
      resolve({});
    }
  });
}

function chromeStorageSet(obj){
  if (!hasChromeStorage()) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      W.chrome.storage.local.set(obj || {}, () => resolve(true));
    } catch {
      resolve(false);
    }
  });
}

function chromeStorageRemove(keys){
  if (!hasChromeStorage()) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      W.chrome.storage.local.remove(keys, () => resolve(true));
    } catch {
      resolve(false);
    }
  });
}

async function readSharedRecord(key, chromeValues = null){
  const k = String(key || "");
  if (!k) return null;

  const fromChrome = chromeValues && Object.prototype.hasOwnProperty.call(chromeValues, k)
    ? decodeSharedRecord(chromeValues[k])
    : null;
  if (fromChrome) return fromChrome;

  try {
    const store = W.H2O?.Library?.Store;
    if (store && typeof store.get === "function") {
      const fromStore = decodeSharedRecord(await store.get(k));
      if (fromStore) return fromStore;
    }
  } catch {}

  return decodeSharedRecord(readLocalJson(k, null));
}

async function writeSharedRecord(key, value){
  const k = String(key || "");
  if (!k) return false;
  const record = value && typeof value === "object" ? value : {};
  try { localStorage.setItem(k, JSON.stringify(record)); } catch {}

  const jobs = [chromeStorageSet({ [k]: record })];
  try {
    const store = W.H2O?.Library?.Store;
    if (store && typeof store.set === "function") jobs.push(store.set(k, record).catch(() => false));
  } catch {}
  await Promise.allSettled(jobs);
  return true;
}

function broadcastStudioMeta(reason, payload){
  const body = {
    ts: Date.now(),
    surface: "studio",
    reason: String(reason || "studio-interface-meta"),
    payload: payload && typeof payload === "object" ? payload : null,
  };
  try { W.H2O?.Library?.Sync?.broadcast?.(body.reason, body.payload); } catch {}
  chromeStorageSet({ [LIBRARY_SYNC_BROADCAST_KEY]: body }).catch(() => {});
  try {
    W.dispatchEvent(new CustomEvent("evt:h2o:library:cross-surface-sync", {
      detail: { reasons: [body.reason], t: body.ts, surface: "studio" },
    }));
  } catch {}
}

function normalizeTitleStatePayload(record){
  const src = record && typeof record === "object" && record.state && typeof record.state === "object"
    ? record.state
    : record;
  if (!src || typeof src !== "object") return null;
  const chatId = String(src.chatId || "").trim();
  const baseTitle = String(src.baseTitle || src.title || "").trim();
  const emoji = String(src.emoji || "").trim();
  const displayTitle = String(src.displayTitle || src.documentTitle || "").trim();
  if (!baseTitle && !emoji && !displayTitle) return null;
  return {
    chatId,
    baseTitle,
    emoji,
    displayTitle,
    updatedAt: toTimestampMs(src.updatedAt || src.emojiUpdatedAt || 0),
  };
}

function composeTitleFromState(titleState, fallbackTitle){
  const fallback = String(fallbackTitle || "").trim();
  const stateObj = normalizeTitleStatePayload(titleState);
  if (!stateObj) return fallback;
  const baseTitle = stateObj.baseTitle || fallback;
  const displayTitle = stateObj.displayTitle;
  const emoji = stateObj.emoji;
  if (displayTitle) return displayTitle;
  if (emoji && baseTitle && !baseTitle.startsWith(`${emoji} `)) return `${emoji} ${baseTitle}`;
  return baseTitle || fallback;
}

function emojiList(line){
  return String(line || "").trim().split(/\s+/).filter(Boolean);
}

const STUDIO_EMOJI_GROUPS = Object.freeze([
  Object.freeze({ label: "Smileys & Emotion", emojis: emojiList(`
    😀 😃 😄 😁 😆 😅 😂 🤣 🥲 🥹 ☺️ 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚
    😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖
    😫 😩 🥺 😢 😭 😮‍💨 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🫣
    🤗 🫡 🤔 🫢 🤭 🤫 🤥 😶 😐 😑 😬 🫨 🫠 🙄 😯 😦 😧 😮 😲 🥱
    😴 🤤 😪 😵 😵‍💫 🫥 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👹
    👺 🤡 💩 👻 💀 ☠️ 👽 👾 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾
  `) }),
  Object.freeze({ label: "Work & Objects", emojis: emojiList(`
    💬 🗨️ 🧠 💻 🖥️ ⌨️ 🖱️ ⚙️ 🛠️ 🔧 🧰 💡 📌 📍 🧭 🗺️ 🧩 📦
    📁 📂 🗂️ 📝 📄 📑 📜 🧾 📚 📖 🔖 📎 ✉️ 📧 📤 📥 🔍 🔎 📊
  `) }),
  Object.freeze({ label: "People & Roles", emojis: emojiList(`
    👨‍💻 👩‍💻 🧑‍💻 👨‍🎓 👩‍🎓 🧑‍🎓 👨‍🏫 👩‍🏫 🧑‍🏫 👨‍🔬 👩‍🔬 🧑‍🔬
    👨‍⚕️ 👩‍⚕️ 🧑‍⚕️ 👨‍⚖️ 👩‍⚖️ 🧑‍⚖️ 👨‍🔧 👩‍🔧 🧑‍🔧 👨‍🚀 👩‍🚀 🧑‍🚀
  `) }),
  Object.freeze({ label: "Symbols & Flags", emojis: emojiList(`
    ⭐ ✨ ⚡ 🔥 ✅ ❗ ⚠️ 🔁 🔒 🔓 ❤️ 💙 💚 💛 🧡 💜 🖤 🤍
    🔶 🔷 🔺 🔻 ⬆️ ⬇️ ⬅️ ➡️ 🇵🇸 🇩🇪 🇦🇹 🇪🇺 🇬🇧 🇺🇸 🇨🇦 🇨🇭
  `) }),
]);

const STUDIO_EMOJI_POOL = Object.freeze(Array.from(new Set(STUDIO_EMOJI_GROUPS.flatMap((group) => group.emojis || []))));

function splitTitleEmoji(raw){
  const title = String(raw || "").trim();
  if (!title) return { baseTitle: "", emoji: "" };
  let parts = [];
  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    parts = Array.from(segmenter.segment(title), (entry) => entry.segment);
  } catch {
    parts = Array.from(title);
  }
  const isEmoji = (value) => (
    /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u.test(String(value || "")) ||
    /[\u2600-\u27BF]/u.test(String(value || ""))
  );
  const first = parts[0] || "";
  const last = parts[parts.length - 1] || "";
  const emoji = isEmoji(first) ? first : (isEmoji(last) ? last : "");
  if (!emoji) return { baseTitle: title, emoji: "" };
  if (emoji === first) parts.shift();
  else parts.pop();
  const baseTitle = parts.join("").trim();
  return { baseTitle: baseTitle || title, emoji };
}

function displayTitleWithEmoji(baseTitle, emoji){
  const base = String(baseTitle || "").trim();
  const e = String(emoji || "").trim();
  if (!base) return e;
  if (!e) return base;
  return base.startsWith(`${e} `) ? base : `${e} ${base}`;
}

function messageTimestamp(message){
  return toTimestampMs(
    message?.createdAt ??
    message?.createTime ??
    message?.create_time ??
    message?.timestamp ??
    message?.ts ??
    message?.messageCreateTime ??
    message?.message_create_time
  );
}

function earliestMessageTimestamp(messages){
  let min = 0;
  for (const msg of Array.isArray(messages) ? messages : []){
    const ms = messageTimestamp(msg);
    if (!ms) continue;
    min = min ? Math.min(min, ms) : ms;
  }
  return min;
}

function latestMessageTimestamp(messages){
  let max = 0;
  for (const msg of Array.isArray(messages) ? messages : []){
    const ms = messageTimestamp(msg);
    if (!ms) continue;
    max = Math.max(max, ms);
  }
  return max;
}

function resolveOriginalChatCreatedAt(row, meta, messages){
  const messageFirst = earliestMessageTimestamp(messages);
  return firstTimestamp(
    row?.chatCreatedAt,
    row?.conversationCreatedAt,
    row?.originalCreatedAt,
    row?.originCreatedAt,
    row?.firstMessageCreatedAt,
    row?.createdAtOriginal,
    meta?.chatCreatedAt,
    meta?.conversationCreatedAt,
    meta?.originalCreatedAt,
    meta?.originCreatedAt,
    meta?.firstMessageCreatedAt,
    meta?.createdAt,
    meta?.createTime,
    meta?.create_time,
    messageFirst,
    meta?.updatedAt,
    row?.updatedAt,
    row?.createdAt
  );
}

function resolveLastTurnAt(row, meta, messages){
  const messageLast = latestMessageTimestamp(messages);
  return firstTimestamp(
    row?.lastTurnAt,
    row?.lastTurnCreatedAt,
    row?.lastMessageCreatedAt,
    row?.lastActivityAt,
    row?.conversationUpdatedAt,
    meta?.lastTurnAt,
    meta?.lastTurnCreatedAt,
    meta?.lastMessageCreatedAt,
    meta?.lastActivityAt,
    meta?.conversationUpdatedAt,
    messageLast,
    row?.updatedAt,
    meta?.updatedAt,
    row?.studioAddedAt,
    row?.createdAt
  );
}

function resolveStudioAddedAt(row, meta){
  return firstTimestamp(
    row?.studioAddedAt,
    row?.addedAt,
    row?.capturedAt,
    row?.createdAt,
    meta?.studioAddedAt,
    meta?.addedAt,
    meta?.capturedAt
  );
}

function computeHeatLevel(row){
  const override = normalizeHeatLevel(row?.heatOverride);
  if (override !== "auto") return override;
  const meta = row?.interfaceMeta && typeof row.interfaceMeta === "object" ? row.interfaceMeta : {};
  const lastActivity = Math.max(
    toTimestampMs(meta.updatedAt),
    toTimestampMs(row?.updatedAt),
    toTimestampMs(row?.originalCreatedAt),
    toTimestampMs(row?.studioAddedAt)
  );
  if (!lastActivity) return "off";
  const ageHrs = (Date.now() - lastActivity) / 36e5;
  if (ageHrs <= 24) return "hot";
  if (ageHrs <= 24 * 7) return "warm";
  return "off";
}

function readUiPrefs(){
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    const prefs = raw ? JSON.parse(raw) : {};
    state.sidebarExpanded = prefs?.sidebarExpanded !== false;
    state.density = normalizeDensity(prefs?.density);
    state.layout = normalizeLayout(prefs?.layout);
  } catch {
    state.sidebarExpanded = true;
    state.density = "cozy";
    state.layout = "focused";
  }
}

function writeUiPrefs(){
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({
      sidebarExpanded: state.sidebarExpanded,
      density: state.density,
      layout: state.layout,
    }));
  } catch {}
}

// Phase 2B: adaptive wide-mode for the saved-chat reader. Phase 1 armed the
// CSS variable --wb-thread-wide (54rem) but no JS toggled body[data-layout].
// We respect the existing user-explicit preference (`state.layout`) — toggling
// to "wide" via toggleLayout() always wins everywhere — and ONLY upgrade the
// default "focused" preference to "wide" while the user is on the reader
// route at viewports ≥ 1280px. The original CSS variable mapping is
// preserved: focused → --wb-thread-w (48rem), wide → --wb-thread-wide (54rem).
const ADAPTIVE_READER_LAYOUT_QUERY = "(min-width: 1280px)";
let adaptiveReaderLayoutMq = null;

function computeEffectiveLayout(){
  if (state.layout === "wide") return "wide"; // user-explicit; never undo
  const isReaderRoute = !!state.currentReaderSnapshot;
  if (isReaderRoute && adaptiveReaderLayoutMq && adaptiveReaderLayoutMq.matches) return "wide";
  return state.layout || "focused";
}

function applyAdaptiveReaderLayoutMarker(){
  const effective = computeEffectiveLayout();
  document.body.dataset.layout = effective;
  if (effective === "wide" && state.layout !== "wide") {
    document.body.dataset.readerLayoutAuto = "wide";
  } else if (document.body.dataset.readerLayoutAuto) {
    delete document.body.dataset.readerLayoutAuto;
  }
}

function installAdaptiveReaderLayout(){
  if (state.adaptiveReaderLayoutInstalled) return;
  state.adaptiveReaderLayoutInstalled = true;

  try {
    adaptiveReaderLayoutMq = window.matchMedia(ADAPTIVE_READER_LAYOUT_QUERY);
  } catch { adaptiveReaderLayoutMq = null; }

  const onChange = () => applyAdaptiveReaderLayoutMarker();
  if (adaptiveReaderLayoutMq) {
    if (typeof adaptiveReaderLayoutMq.addEventListener === "function") {
      adaptiveReaderLayoutMq.addEventListener("change", onChange);
    } else if (typeof adaptiveReaderLayoutMq.addListener === "function") {
      // Safari < 14 legacy MediaQueryList API.
      adaptiveReaderLayoutMq.addListener(onChange);
    }
  }
  // Resize covers width changes the matchMedia query crosses-over, plus the
  // gradual changes a user makes by dragging the window edge. Passive so we
  // never block the layout thread.
  window.addEventListener("resize", onChange, { passive: true });
}

function normalizeStudioRouteScope(routeName){
  const key = String(routeName || "").trim().toLowerCase();
  if (key === "reader" || key === "library" || key === "settings" || key === "migrate") return key;
  return "list";
}

function getDesktopChromeEl(){
  try { return document.getElementById("studioDesktopChrome"); }
  catch { return null; }
}

function syncDesktopRibbonHiddenScope(routeScope){
  const chrome = getDesktopChromeEl();
  if (!chrome) return;
  if (routeScope !== "library") chrome.removeAttribute("data-library-ribbon-hidden");
  if (routeScope !== "reader") chrome.removeAttribute("data-reader-ribbon-hidden");
}

function setDesktopReaderRibbonHidden(hidden){
  const chrome = getDesktopChromeEl();
  const H2O = W.H2O = W.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.readerRibbonOpenSession = !hidden;
  if (chrome) {
    if (hidden) chrome.setAttribute("data-reader-ribbon-hidden", "true");
    else chrome.removeAttribute("data-reader-ribbon-hidden");
  }
  try {
    const ribbon = W.H2O?.Studio?.ribbon;
    if (ribbon && typeof ribbon.setCollapsed === "function") ribbon.setCollapsed(true);
  } catch {}
}

function applyDesktopReaderRibbonSession(){
  const open = W.H2O?.Studio?.readerRibbonOpenSession !== false;
  setDesktopReaderRibbonHidden(!open);
}

function setStudioRouteScope(routeName, opts = {}){
  state.activeRoute = normalizeStudioRouteScope(routeName);
  if (opts && opts.clearReader) state.currentReaderSnapshot = null;
  syncDesktopRibbonHiddenScope(state.activeRoute);
  applyUiState();
}

function applyUiState(){
  installAdaptiveReaderLayout();
  document.body.dataset.sidebar = state.sidebarExpanded ? "open" : "closed";
  document.body.dataset.density = state.density;
  applyAdaptiveReaderLayoutMarker();
  const routeScope = state.currentReaderSnapshot ? "reader" : normalizeStudioRouteScope(state.activeRoute);
  document.body.dataset.route = routeScope;

  // D3.2.2: Dock eligibility is broader than the reader route — a saved
  // chat/editor can be shown in the #viewReader pane while the route is
  // still "list". The CSS gates the Dock rail/panel on this marker (plus
  // sidebar-closed), so the Dock appears for any open chat/editor and
  // stays hidden on the plain saved list / library / settings. Read-only
  // marker; never mutates the sidebar preference.
  try {
    const dockCtx = (W.H2O && W.H2O.Studio && typeof W.H2O.Studio.getDockContext === "function")
      ? W.H2O.Studio.getDockContext()
      : null;
    document.body.dataset.dockEligible = (dockCtx && dockCtx.eligible) ? "true" : "false";
  } catch (_) { /* ignore */ }

  const sidebarOpen = !!state.sidebarExpanded;
  const sidebarButtons = ["#sidebarCollapseBtn", "#railSidebarBtn"];
  sidebarButtons.forEach((selector) => {
    const btn = $(selector);
    if (!btn) return;
    btn.setAttribute("aria-expanded", sidebarOpen ? "true" : "false");
  });
  $(".wbRail")?.setAttribute("aria-hidden", sidebarOpen ? "true" : "false");
  $("#studioSidebar")?.setAttribute("aria-hidden", sidebarOpen ? "false" : "true");
  const collapseBtn = $("#sidebarCollapseBtn");
  if (collapseBtn) collapseBtn.tabIndex = sidebarOpen ? 0 : -1;
  const railBtn = $("#railSidebarBtn");
  if (railBtn) railBtn.tabIndex = sidebarOpen ? -1 : 0;

}

function setRouteMeta(eyebrow, title, summary){
  const eyebrowEl = $("#routeEyebrow");
  const titleEl = $("#routeTitle");
  const summaryEl = $("#routeSummary");
  if (eyebrowEl) eyebrowEl.textContent = String(eyebrow || "");
  if (titleEl) titleEl.textContent = String(title || "");
  if (summaryEl) summaryEl.textContent = String(summary || "");
}

// ── Transport seam ──────────────────────────────────────────────────────────
// Archive requests route through H2O.Studio.platform.messaging.send — the
// required boundary for the future Tauri port. The envelope is preserved
// exactly so the service-worker receiver (bg.js) continues to dispatch by
// type unchanged. The 'archive' target is informational today (MV3 routes
// by envelope.type) and becomes the Tauri command name at port time.
// Falls back to direct chrome.runtime.sendMessage if the platform adapter
// is unavailable. See surfaces/studio/STUDIO_PLATFORM_ADAPTER_GUIDE.md.
function getPlatformMessaging(){
  const p = W.H2O && W.H2O.Studio && W.H2O.Studio.platform && W.H2O.Studio.platform.messaging;
  if (!p || typeof p.send !== 'function') return null;
  const env = W.H2O && W.H2O.Studio && W.H2O.Studio.platform && W.H2O.Studio.platform.env;
  if (env && env.adapter === 'fallback') return null;
  return p;
}

// ── Desktop reader (M2a-3i) ─────────────────────────────────────────────────
// On Tauri Studio Desktop, saved snapshots live in the SQLite-backed
// H2O.Studio.store.snapshots. callArchive's "loadSnapshot" op is the single
// funnel renderReader → buildReaderDOM uses; we intercept just that op and
// project SQLite output into the canonical snapshot shape the existing
// reader path already consumes. All other archive ops fall through to the
// MV3 platform-messaging path unchanged — Save-to-Folder / Add-to-Library
// ingestion plumbing is a separate roadmap item (M2b).
function STUDIO_isTauri(){
  try {
    return !!(W.H2O && W.H2O.Studio && W.H2O.Studio.platform
      && W.H2O.Studio.platform.env && W.H2O.Studio.platform.env.isTauri === true);
  } catch { return false; }
}

/* Phase H — Tauri V2 invoke resolver. Mirrors the same probe used by
 * platform.tauri.js and sync/folder-sync.tauri.js so studio.js can call
 * tauri-plugin-dialog directly from the Settings UI without taking a
 * dependency on the platform adapter (which has no MV3 file-picker
 * counterpart). Returns a bound invoke(...) or null when not running
 * inside a Tauri WebView. Probe order matches Tauri V2 → V1 fallback. */
function STUDIO_getTauriInvoke(){
  try {
    const internals = W.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === "function") return internals.invoke.bind(internals);
  } catch (_) { /* ignore */ }
  try {
    const tauri = W.__TAURI__;
    if (tauri && tauri.core && typeof tauri.core.invoke === "function") return tauri.core.invoke.bind(tauri.core);
    if (tauri && typeof tauri.invoke === "function") return tauri.invoke.bind(tauri);
  } catch (_) { /* ignore */ }
  return null;
}

// Pure mapper: { snapshot, turns } from store.snapshots.get → canonical
// snapshot shape produced by S0D3a's canonicalSnapshot. Only includes
// meta.richTurns when at least one turn has non-empty outerHtml, so HTML-less
// captures still fall through to buildCanonicalConversation (text rendering).
// Note: outerHtml → outerHTML (case flip) is the reader's contract.
function projectSqliteSnapshotToCanonical(input){
  if (!input || typeof input !== 'object') return null;
  const snap = input.snapshot;
  const turns = Array.isArray(input.turns) ? input.turns : [];
  if (!snap || typeof snap !== 'object' || !snap.snapshotId) return null;

  const capturedAtMs = (typeof snap.capturedAt === 'number' && snap.capturedAt > 0) ? snap.capturedAt : 0;
  let createdAt = '';
  if (capturedAtMs > 0) {
    try { createdAt = new Date(capturedAtMs).toISOString(); }
    catch { createdAt = ''; }
  }

  const messages = turns.map((t, idx) => {
    const meta = (t && t.meta && typeof t.meta === 'object' && !Array.isArray(t.meta)) ? t.meta : {};
    return {
      role: (t && t.role) || 'assistant',
      text: (t && t.text) || '',
      order: (t && typeof t.turnIdx === 'number') ? t.turnIdx : idx,
      createdAt: capturedAtMs || 0,
      attachments: Array.isArray(meta.attachments) ? meta.attachments : (Array.isArray(t && t.attachments) ? t.attachments : []),
    };
  });

  const richTurns = turns
    .filter((t) => t && typeof t.outerHtml === 'string' && t.outerHtml.length > 0)
    .map((t, idx) => Object.assign(
      { turnIdx: (typeof t.turnIdx === 'number') ? t.turnIdx : idx,
        role: t.role || 'assistant',
        outerHTML: t.outerHtml },
      (t.meta && typeof t.meta === 'object' && !Array.isArray(t.meta)) ? t.meta : {}
    ));

  // Spread snapshot.meta (catch-all) first so any pre-captured fields
  // (folderId, folderName, projectId, originSource, …) survive intact;
  // overlay derived fields on top.
  const metaBase = (snap.meta && typeof snap.meta === 'object' && !Array.isArray(snap.meta)) ? snap.meta : {};
  const meta = Object.assign({}, metaBase);
  if (snap.title && !meta.title) meta.title = snap.title;
  if (richTurns.length > 0) meta.richTurns = richTurns;
  if (typeof snap.messageCount === 'number' && meta.messageCount == null) {
    meta.messageCount = snap.messageCount;
  }

  return {
    snapshotId: snap.snapshotId,
    chatId: snap.chatId || '',
    title: snap.title || meta.title || '',
    createdAt,
    schemaVersion: 1,
    messageCount: Number(snap.messageCount || messages.length || 0),
    digest: snap.digest || '',
    messages,
    meta,
  };
}

async function loadSnapshotFromStoresDesktop(snapshotId){
  const id = String(snapshotId || '').trim();
  if (!id) return null;
  const snapStore = W.H2O && W.H2O.Studio && W.H2O.Studio.store && W.H2O.Studio.store.snapshots;
  if (!snapStore || typeof snapStore.get !== 'function') return null;
  try {
    const raw = await snapStore.get(id);
    if (!raw) return null;
    return projectSqliteSnapshotToCanonical(raw);
  } catch (e) {
    try { console.warn('[H2O.Studio] loadSnapshotFromStoresDesktop failed', e); } catch {}
    return null;
  }
}

async function callArchive(op, payload = {}, nsDisk){
  // Desktop (Tauri): route reader's loadSnapshot op to the SQLite store and
  // project to the canonical shape. The list ops have no archive bridge yet
  // on Desktop V1 — short-circuit them to empty arrays so renderList runs
  // its normal empty-state path instead of throwing "archive unavailable"
  // and leaving the sidebar stuck on the static "Loading folder bindings…"
  // / "Loading chats…" HTML defaults. Future enhancement (M2a-3j) will
  // project actual workbench rows from store.snapshots. Every other op
  // falls through to the MV3 platform-messaging path unchanged.
  if (STUDIO_isTauri()) {
    if (op === 'loadSnapshot') return loadSnapshotFromStoresDesktop(payload && payload.snapshotId);
    if (op === 'listWorkbenchRows') return [];
    if (op === 'listAllChatIds') return [];
    if (op === 'listChatIds') return [];
    // Route full-bundle import/export ops through the Desktop ingestion
    // modules so the existing #/migrate UI works against SQLite without
    // changing Chrome's archive import/export implementation.
    if (op === 'exportFullBundle') {
      const fn = W.H2O?.Studio?.ingestion?.exportFullBundle;
      if (typeof fn !== 'function') {
        return Promise.reject(new Error('Desktop export module not loaded'));
      }
      return fn(payload || {});
    }
    if (op === 'dryRunImportFullBundle') {
      const fn = W.H2O?.Studio?.ingestion?.dryRunImportBundle;
      if (typeof fn !== 'function') {
        return Promise.reject(new Error('Desktop ingestion module not loaded'));
      }
      return fn(payload && payload.bundle);
    }
    if (op === 'importFullBundle') {
      const fn = W.H2O?.Studio?.ingestion?.importBundle;
      if (typeof fn !== 'function') {
        return Promise.reject(new Error('Desktop ingestion module not loaded'));
      }
      return fn(payload && payload.bundle, payload && payload.mode);
    }
  }
  const message = { type: MSG_ARCHIVE, req: { op, payload, nsDisk } };
  const pm = getPlatformMessaging();
  const res = pm
    ? await pm.send('archive', message)
    : await chrome.runtime.sendMessage(message);
  if (!res?.ok) throw new Error(res?.error || `Archive op failed: ${op}`);
  return res.result;
}

async function tryArchiveOp(op, payload = {}, nsDisk){
  try {
    return {
      ok: true,
      op,
      result: await promiseWithTimeout(
        callArchive(op, payload, nsDisk),
        STUDIO_ARCHIVE_TIMEOUT_MS,
        `archive op ${op}`
      ),
    };
  } catch (error){
    return { ok: false, op, error };
  }
}

async function tryArchiveOps(ops, payload = {}, nsDisk){
  let last = null;
  for (const op of (ops || [])){
    const attempt = await tryArchiveOp(op, payload, nsDisk);
    if (attempt.ok) return attempt;
    last = attempt.error;
  }
  return { ok: false, error: last };
}

function parseHash(){
  const hash = String(location.hash || "");
  if (!hash && history.state?.h2oStudioReader){
    const activeSnapshotId = String(state.currentReaderSnapshot?.snapshotId || state.selectedSnapshotId || "").trim();
    if (activeSnapshotId) return { name: "read", snapshotId: activeSnapshotId };
  }

  const raw = (hash || "#/saved").replace(/^#/, "");
  const [pathRaw, searchRaw = ""] = raw.split("?");
  const parts = pathRaw.split("/").filter(Boolean);
  if (parts[0] === "read") return { name: "read", snapshotId: decodeURIComponent(parts[1] || "") };
  // The Library overlay (S0F1d Library Insights) owns #/library/* routes.
  // Surface them through parseHash with a distinct `name`, so renderRoute can
  // skip studio.js's list/reader render path AND avoid the listHash reset in
  // renderList — which previously rewrote the URL back to #/saved the moment
  // the user clicked the sidebar Library button.
  if (parts[0] === "library") {
    let view = "dashboard";
    try { view = decodeURIComponent(parts[1] || "dashboard"); } catch { view = parts[1] || "dashboard"; }
    let id = "";
    try { id = decodeURIComponent(parts.slice(2).join("/")); } catch { id = parts.slice(2).join("/"); }
    return { name: "library", view, id };
  }
  // v2 full-bundle migration routes (export from old extension, import into new).
  // Two leaf actions: "export" (download bundle JSON) and "import" (file picker
  // + dry-run + auto-backup + confirm). Owned by renderMigrateRoute below.
  if (parts[0] === "migrate") {
    const action = String(parts[1] || "").toLowerCase();
    if (action === "export" || action === "import") return { name: "migrate", action };
  }
  // Settings page — sidebar entry-point that exposes #/migrate/* through
  // user-facing cards. Owned by renderSettingsRoute below.
  if (parts[0] === "settings") {
    let section = "account";
    let subsection = "";
    try { section = decodeURIComponent(parts[1] || "account").toLowerCase(); }
    catch { section = String(parts[1] || "account").toLowerCase(); }
    try { subsection = decodeURIComponent(parts[2] || "").toLowerCase(); }
    catch { subsection = String(parts[2] || "").toLowerCase(); }
    return { name: "settings", section, subsection };
  }
  const search = new URLSearchParams(searchRaw);
  return {
    name: "list",
    view: normalizeArchiveView(parts[0] || "saved"),
    folderId: normalizeFolderFilter(search.get("folder") || ""),
    chatId: String(search.get("chat") || "").trim(),
    snapshotId: String(search.get("snapshot") || "").trim(),
  };
}

function buildListHash(view, folderId = ""){
  const params = new URLSearchParams();
  const folder = normalizeFolderFilter(folderId);
  if (folder) params.set("folder", folder);
  const suffix = params.toString();
  return `#/${normalizeArchiveView(view)}${suffix ? `?${suffix}` : ""}`;
}

function viewLabel(view){
  const next = normalizeArchiveView(view);
  if (next === "pinned") return "Pinned";
  if (next === "archive") return "Archive";
  if (next === "linked") return "Linked";
  return "Saved";
}

function viewCopy(view){
  const next = normalizeArchiveView(view);
  if (next === "pinned") return "Pinned snapshots";
  if (next === "archive") return "Archived conversations";
  if (next === "linked") return "Linked Chats";
  return "Saved chats";
}

function buildEmptyListState(view, folderId, query){
  const scope = [];
  const folderLabel = folderId === FOLDER_FILTER_NONE
    ? "Unfiled"
    : (folderId ? resolveFolderName(folderId) : "");
  if (folderLabel) scope.push(`inside ${folderLabel}`);
  if (query) scope.push(`matching "${query}"`);
  const scopeText = scope.length ? ` ${scope.join(" ")}` : "";
  /* Phase K-1 — Linked Chats has a distinct discoverability story:
   * the user populates it via Add-to-Library on chatgpt.com, not via
   * capture/refresh. Match the copy to that flow. */
  const normalized = normalizeArchiveView(view);
  if (normalized === "linked") {
    return `
      <div class="wbState">
        <div><strong>No linked chats yet${esc(scopeText)}.</strong></div>
        <div style="margin-top:8px;">Use Add-to-Library on chatgpt.com to register a chat link here.</div>
      </div>
    `;
  }
  return `
    <div class="wbState">
      <div><strong>No ${esc(viewCopy(view).toLowerCase())}${esc(scopeText)}.</strong></div>
      <div style="margin-top:8px;">Capture a conversation from chatgpt.com with the archive tools, then refresh Studio.</div>
    </div>
  `;
}

function buildListErrorState(error){
  const msg = normalizeText(error?.message || error || "Unknown Studio error");
  return `
    <div class="wbState wbState--error">
      <div><strong>Studio cannot list snapshots yet.</strong></div>
      <div style="margin-top:8px;">${esc(msg)}</div>
      <div style="margin-top:8px;">The extension archive bridge is still the source of truth for this page.</div>
    </div>
  `;
}


function normalizeTurnHighlights(raw){
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  for (let i = 0; i < src.length; i += 1){
    const row = src[i] && typeof src[i] === "object" ? src[i] : {};
    const turnIdx = Math.max(1, Math.floor(Number(row.turnIdx ?? row.answerIndex ?? (i + 1)) || (i + 1)));
    const colors = uniqStrings(row.colors || row.highlightColors || row.values || []);
    if (!colors.length) continue;
    out.push({ turnIdx, colors });
  }
  out.sort((a, b) => Number(a.turnIdx) - Number(b.turnIdx));
  return out;
}

function normalizeMiniMapDotColor(raw){
  const color = String(raw || "").trim();
  const lower = color.toLowerCase();
  const aliases = {
    gold: "#f7d34a",
    yellow: "#f7d34a",
    blue: "#66b5ff",
    pink: "#ff79c6",
    green: "#35c759",
    purple: "#a78bfa",
    orange: "#fb923c",
    red: "#f87171",
  };
  for (const [token, value] of Object.entries(aliases)){
    if (lower === token || lower.includes(token)) return value;
  }
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  if (/^(?:rgb|hsl)a?\([^)]+\)$/i.test(color)) return color;
  if (/^[a-z-]{3,32}$/i.test(lower)) return lower;
  return "";
}

const STUDIO_MM_COLOR_ORDER = ["blue", "red", "green", "gold", "sky", "pink", "purple", "orange"];

function normalizeMiniMapColorToken(raw){
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  if (value.includes("gold") || value.includes("yellow") || value === "#ffd700" || value === "#f7d34a") return "gold";
  if (value.includes("blue") || value === "#66b5ff" || value === "#3a8bff") return "blue";
  if (value.includes("red") || value === "#f87171" || value === "#ff4a4a") return "red";
  if (value.includes("green") || value === "#35c759" || value === "#31d158") return "green";
  if (value.includes("purple") || value === "#a78bfa" || value === "#a36bff") return "purple";
  if (value.includes("pink") || value === "#ff79c6" || value === "#ff71c6") return "pink";
  if (value.includes("orange") || value === "#fb923c" || value === "#ffa63a") return "orange";
  if (value.includes("sky") || value === "#4cd3ff") return "sky";
  return "";
}

function resolveMiniMapTone(colors){
  const list = uniqStrings(colors || []);
  for (const color of list){
    const token = normalizeMiniMapColorToken(color);
    if (token) return token;
  }
  return "";
}

function buildExcerptFromMessages(messages){
  const normalizeRendererRole = getStudioChatRenderer().normalizeRole;
  const firstAssistant = (messages || []).find(
    (row) => normalizeRendererRole(row?.role) === "assistant" && row?.text
  );
  const first = firstAssistant || (messages || [])[0];
  return normalizeText(first?.text || "").slice(0, 240);
}


function appendMiniMapDots(btn, colors){
  const palette = uniqStrings(colors).slice(0, 4);
  if (!palette.length) return;
  btn.classList.add("has-dots");
  const dots = document.createElement("span");
  dots.className = "cgMMDots";
  for (const color of palette){
    const dot = document.createElement("span");
    dot.className = "cgMMDot";
    const safeColor = normalizeMiniMapDotColor(color);
    if (safeColor) dot.style.background = safeColor;
    dot.title = String(color || "");
    dots.appendChild(dot);
  }
  btn.appendChild(dots);
}

function buildMiniMap(mm, turnEls, turnHighlightsRaw = [], scrollEl = null){
  const items = (Array.isArray(turnEls) ? turnEls : []).filter(Boolean);
  const highlightRows = normalizeTurnHighlights(turnHighlightsRaw);
  const highlightMap = new Map(highlightRows.map((row) => [Number(row.turnIdx), row.colors.slice()]));
  mm.textContent = "";
  mm.hidden = items.length === 0;
  if (!items.length) return;

  const chrome = document.createElement("div");
  chrome.className = "cgMMChrome";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "cgMMToggle";
  toggle.setAttribute("aria-expanded", "true");

  const pagePill = document.createElement("div");
  pagePill.className = "cgMMPagePill";

  const list = document.createElement("div");
  list.className = "cgMMList";

  const dial = document.createElement("button");
  dial.type = "button";
  dial.className = "cgMMDial";
  dial.title = "Toggle navigation colors";
  dial.innerHTML = '<span class="cgMMDialDot"></span>';

  const colorNav = document.createElement("div");
  colorNav.className = "cgMMColorNav is-open";

  chrome.appendChild(toggle);
  chrome.appendChild(pagePill);
  chrome.appendChild(list);
  chrome.appendChild(dial);
  chrome.appendChild(colorNav);
  mm.appendChild(chrome);

  const host = scrollEl || document.querySelector(".wbMain") || document.querySelector(".cgScroll") || null;
  const pairs = [];
  const colorTargets = new Map();
  const colorState = new Map();
  let rafId = 0;
  let activeIndex = 0;
  let collapsed = false;

  function jumpToIndex(nextIndex){
    const pair = pairs[nextIndex];
    if (!pair) return;
    pair.turnEl.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    try {
      pair.turnEl.animate(
        [{ backgroundColor: "rgba(255,215,0,.10)" }, { backgroundColor: "" }],
        { duration: 560 }
      );
    } catch {}
  }

  function refreshColorLabels(){
    colorNav.querySelectorAll(".cgMMColorBtn").forEach((btn) => {
      const token = String(btn.dataset.color || "");
      const targets = colorTargets.get(token) || [];
      const stateEntry = colorState.get(token) || { current: 0 };
      const total = targets.length;
      const current = total ? Math.max(1, Math.min(total, Number(stateEntry.current || 1))) : 0;
      btn.textContent = total ? `${current}/${total}` : "0/0";
      btn.hidden = total === 0;
    });
  }

  function setActiveByIndex(nextIndex){
    activeIndex = Math.max(0, Math.min(pairs.length - 1, Number(nextIndex || 0)));
    pairs.forEach((pair, idx) => {
      const active = idx === activeIndex;
      pair.button.classList.toggle("active", active);
      pair.button.setAttribute("aria-current", active ? "true" : "false");
      if (active) {
        try { pair.button.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch {}
      }
    });
    toggle.textContent = `${activeIndex + 1}/${pairs.length}`;
    pagePill.textContent = `PAGE ${Math.max(1, Math.ceil((activeIndex + 1) / 25))}`;
    toggle.title = `Answer ${activeIndex + 1} of ${pairs.length}`;
  }

  function syncActive(){
    rafId = 0;
    if (!pairs.length) return;
    const hostRect = host?.getBoundingClientRect?.() || null;
    const probeY = hostRect ? (hostRect.top + Math.min(hostRect.height * 0.28, 180)) : (window.innerHeight * 0.33);
    let bestIndex = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    pairs.forEach((pair, idx) => {
      const rect = pair.turnEl?.getBoundingClientRect?.();
      if (!rect) return;
      const mid = rect.top + (rect.height * 0.5);
      const dist = Math.abs(mid - probeY);
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = idx;
      }
    });
    setActiveByIndex(bestIndex);
  }

  function queueSync(){
    if (rafId) return;
    rafId = requestAnimationFrame(syncActive);
  }

  items.forEach((turnEl, index) => {
    const answerIndex = index + 1;
    const turnIdx = Math.max(1, Math.floor(Number(turnEl?.dataset?.turnIdx || answerIndex) || answerIndex));
    const colors = highlightMap.get(answerIndex) || highlightMap.get(turnIdx) || [];
    const tone = resolveMiniMapTone(colors);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "cgMMBtn";
    button.dataset.index = String(answerIndex);
    if (tone) button.dataset.tone = tone;
    button.title = `Answer ${answerIndex}/${items.length}`;

    const num = document.createElement("span");
    num.className = "cgMMIndex";
    num.textContent = String(answerIndex);
    button.appendChild(num);
    appendMiniMapDots(button, colors);

    button.addEventListener("click", () => {
      setActiveByIndex(index);
      jumpToIndex(index);
      refreshColorLabels();
    });

    list.appendChild(button);
    pairs.push({ button, turnEl, turnIdx, colors, tone });

    uniqStrings(colors).forEach((color) => {
      const token = normalizeMiniMapColorToken(color);
      if (!token) return;
      const next = colorTargets.get(token) || [];
      next.push(index);
      colorTargets.set(token, next);
    });
  });

  STUDIO_MM_COLOR_ORDER.forEach((token) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cgMMColorBtn";
    btn.dataset.color = token;
    btn.dataset.tone = token;
    btn.title = `${token} navigation`;
    btn.addEventListener("click", () => {
      const targets = colorTargets.get(token) || [];
      if (!targets.length) return;
      const entry = colorState.get(token) || { current: 0 };
      entry.current = ((Number(entry.current || 0)) % targets.length) + 1;
      colorState.set(token, entry);
      const targetIndex = targets[entry.current - 1] ?? targets[0] ?? 0;
      setActiveByIndex(targetIndex);
      jumpToIndex(targetIndex);
      refreshColorLabels();
    });
    colorNav.appendChild(btn);
  });

  toggle.addEventListener("click", () => {
    collapsed = !collapsed;
    chrome.classList.toggle("is-collapsed", collapsed);
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  });

  dial.addEventListener("click", () => {
    colorNav.classList.toggle("is-open");
    chrome.classList.toggle("nav-open", colorNav.classList.contains("is-open"));
  });

  host?.addEventListener("scroll", queueSync, { passive: true });
  list.addEventListener("scroll", refreshColorLabels, { passive: true });
  window.addEventListener("resize", queueSync, { passive: true });
  setActiveByIndex(0);
  refreshColorLabels();
  queueSync();
}

function normalizeOriginSource(raw){
  const value = String(raw || "").trim().toLowerCase();
  if (value === "mobile") return "mobile";
  if (value === "browser") return "browser";
  return "unknown";
}

function normalizeProjectRef(raw){
  const row = raw && typeof raw === "object" ? raw : {};
  const id = String(row.id || row.projectId || "").trim();
  if (!id) return null;
  const name = String(row.name || row.projectName || id).trim() || id;
  return { id, name };
}

function normalizeCategoryAssignment(raw){
  const row = raw && typeof raw === "object" ? raw : {};
  const primaryCategoryId = String(row.primaryCategoryId || row.primary || "").trim();
  if (!primaryCategoryId) return null;
  const secondaryCategoryId = String(row.secondaryCategoryId || row.secondary || "").trim() || null;
  if (secondaryCategoryId && secondaryCategoryId === primaryCategoryId) return null;
  const sourceRaw = String(row.source || "").trim().toLowerCase();
  const source = sourceRaw === "user" || sourceRaw === "manual_override" ? "user" : (sourceRaw === "system" || sourceRaw === "auto" ? "system" : "");
  if (!source) return null;
  if (source === "user") {
    return {
      primaryCategoryId,
      secondaryCategoryId,
      source,
      algorithmVersion: null,
      classifiedAt: null,
      overriddenAt: String(row.overriddenAt || row.classifiedAt || "").trim() || null,
      confidence: null,
    };
  }
  const algorithmVersion = String(row.algorithmVersion || "").trim();
  const classifiedAt = String(row.classifiedAt || "").trim();
  if (!algorithmVersion || !classifiedAt) return null;
  return {
    primaryCategoryId,
    secondaryCategoryId,
    source,
    algorithmVersion,
    classifiedAt,
    overriddenAt: null,
    confidence: Number.isFinite(Number(row.confidence)) ? Math.max(0, Math.min(1, Number(row.confidence))) : null,
  };
}

function normalizeStringArray(raw){
  return uniqStrings(Array.isArray(raw) ? raw : []);
}

function normalizeLabelAssignments(raw){
  const row = raw && typeof raw === "object" ? raw : {};
  return {
    workflowStatusLabelId: String(row.workflowStatusLabelId || "").trim(),
    priorityLabelId: String(row.priorityLabelId || "").trim(),
    actionLabelIds: normalizeStringArray(row.actionLabelIds),
    contextLabelIds: normalizeStringArray(row.contextLabelIds),
    customLabelIds: normalizeStringArray(row.customLabelIds),
  };
}

function normalizeLabelRecord(raw){
  const row = raw && typeof raw === "object" ? raw : {};
  const id = String(row.id || "").trim();
  if (!id) return null;
  const rawType = String(row.type || "").trim();
  const type = ["workflow_status", "priority", "action", "context", "custom"].includes(rawType) ? rawType : "custom";
  return {
    id,
    name: String(row.name || row.title || id).trim() || id,
    type,
    color: String(row.color || "").trim(),
    sortOrder: Number.isFinite(Number(row.sortOrder)) ? Math.floor(Number(row.sortOrder)) : 0,
    createdAt: String(row.createdAt || "").trim(),
  };
}

function normalizeCategoryCatalogRecord(raw){
  const row = raw && typeof raw === "object" ? raw : {};
  const id = String(row.id || "").trim();
  if (!id) return null;
  const statusRaw = String(row.status || "").trim().toLowerCase();
  const status = ["active", "deprecated", "retired"].includes(statusRaw) ? statusRaw : "active";
  return {
    id,
    name: String(row.name || row.title || id).trim() || id,
    description: String(row.description || "").trim() || undefined,
    color: String(row.color || "").trim() || undefined,
    sortOrder: Number.isFinite(Number(row.sortOrder)) ? Math.floor(Number(row.sortOrder)) : 0,
    createdAt: String(row.createdAt || "").trim(),
    updatedAt: String(row.updatedAt || "").trim() || undefined,
    status,
    replacementCategoryId: String(row.replacementCategoryId || "").trim() || null,
    aliases: normalizeStringArray(row.aliases),
  };
}

function normalizeCategoryCatalog(raw){
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of src){
    const category = normalizeCategoryCatalogRecord(item);
    if (!category || seen.has(category.id)) continue;
    seen.add(category.id);
    out.push(category);
  }
  out.sort((a, b) => (
    Number(a.sortOrder || 0) - Number(b.sortOrder || 0)
    || String(a.name || a.id).localeCompare(String(b.name || b.id))
    || String(a.id).localeCompare(String(b.id))
  ));
  return out;
}

function normalizeLabelCatalog(raw){
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of src){
    const label = normalizeLabelRecord(item);
    if (!label || seen.has(label.id)) continue;
    seen.add(label.id);
    out.push(label);
  }
  out.sort((a, b) => (
    String(a.type || "").localeCompare(String(b.type || ""))
    || Number(a.sortOrder || 0) - Number(b.sortOrder || 0)
    || String(a.name || a.id).localeCompare(String(b.name || b.id))
    || String(a.id).localeCompare(String(b.id))
  ));
  return out;
}

function resolveLabelName(labelId){
  const id = String(labelId || "").trim();
  if (!id) return "";
  const found = (state.labelCatalog || []).find((row) => row.id === id);
  return String(found?.name || "").trim();
}

function labelSearchTokens(labels){
  const ids = [
    labels?.workflowStatusLabelId,
    labels?.priorityLabelId,
    ...(labels?.actionLabelIds || []),
    ...(labels?.contextLabelIds || []),
    ...(labels?.customLabelIds || []),
  ].map((id) => String(id || "").trim()).filter(Boolean);
  const names = ids.map(resolveLabelName).filter(Boolean);
  return [...ids, ...names];
}

function normalizeKeywords(raw){
  return normalizeStringArray(raw);
}

function normalizeTags(raw){
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of src){
    const tag = String(item || "").trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function normalizeFolderRecord(raw){
  const row = raw && typeof raw === "object" ? raw : {};
  const id = String(row.id || row.folderId || "").trim();
  const name = String(row.name || row.title || id).trim() || id;
  const createdAt = String(row.createdAt || "").trim();
  const updatedAt = String(row.updatedAt || "").trim();
  const kind = String(row.kind || "").trim().toLowerCase() === "project_backed" ? "project_backed" : "local";
  const projectRef = normalizeProjectRef(row.projectRef);
  const iconColor = normalizeSidebarIconColor(row.iconColor || row.color || row.folderColor || row.accentColor || row.appearance?.color || "");
  const folder = { id, name, createdAt, updatedAt, kind, projectRef };
  if (iconColor) folder.iconColor = iconColor;
  const displayCountLabel = String(row.displayCountLabel || "").trim();
  if (displayCountLabel) folder.displayCountLabel = displayCountLabel;
  const badges = Array.isArray(row.badges) ? row.badges.map((badge) => String(badge || "").trim()).filter(Boolean) : [];
  if (badges.length) folder.badges = badges;
  ["canonicalCount", "knownCount", "savedCount", "linkedCount", "orphanCount", "localBindingCount"].forEach((key) => {
    if (row[key] != null) folder[key] = Number(row[key] || 0) || 0;
  });
  ["isCanonical", "isExtra", "isTestCandidate", "isConflict"].forEach((key) => {
    if (row[key] === true) folder[key] = true;
  });
  if (row.reviewBucket) folder.reviewBucket = String(row.reviewBucket || "").trim();
  if (row.source) folder.source = String(row.source || "").trim();
  return folder;
}

function normalizeWorkbenchRow(raw){
  const row = raw && typeof raw === "object" ? raw : {};
  const messages = Array.isArray(row.messages) ? row.messages : [];
  const meta = row.meta && typeof row.meta === "object" ? row.meta : {};
  const snapshotId = String(
    row.snapshotId || row.lastSnapshotId || row.latestSnapshotId || row.snapshot_id
    || meta.snapshotId || meta.lastSnapshotId || meta.latestSnapshotId || meta.snapshot_id || ""
  ).trim();
  const chatId = String(row.chatId || meta.chatId || "").trim();
  /* Phase K-1 — Linked rows (view: 'linked') are accepted without
   * snapshotId. Saved rows still require both ids. The view value
   * comes from projectLibraryIndexRowToWorkbenchInput; any other
   * caller-provided shape without a view defaults to saved-rules. */
  const rowView = String(row.view || meta.view || "").trim().toLowerCase();
  const isLinkedRow = rowView === "linked";
  const isLinkedState = row.isLinked === true
    || !!(row.state && typeof row.state === "object" && row.state.isLinked === true)
    || meta.isLinked === true;
  const isLinkOnlyRow = isLinkedRow || isLinkedState;
  if (!chatId) return null;
  if (!snapshotId && !isLinkOnlyRow) return null;

  const title = String(row.title || meta.title || chatId).trim() || chatId;
  const excerpt = String(row.excerpt || meta.excerpt || buildExcerptFromMessages(messages)).trim();
  const createdAt = String(row.createdAt || row.updatedAt || meta.updatedAt || "").trim();
  const updatedAt = String(row.updatedAt || meta.updatedAt || createdAt).trim();
  const originalCreatedAt = resolveOriginalChatCreatedAt(row, meta, messages);
  const studioAddedAt = resolveStudioAddedAt(row, meta) || createdAt;
  const lastTurnAt = resolveLastTurnAt(row, meta, messages) || updatedAt;
  const messageCount = Number(row.messageCount || messages.length || meta.messageCount || 0);
  const answerCount = Number(row.answerCount || meta.answerCount || meta.answers || countAssistantTurns(messages));
  const pinned = !!(row.pinned ?? meta.pinned);
  const archived = !!(row.archived ?? meta.archived ?? (String(meta.state || "").trim().toLowerCase() === "archived"));
  const folderId = String(row.folderId || meta.folderId || meta.folder || "").trim();
  const folderName = String(row.folderName || meta.folderName || "").trim();
  const folderIconColor = normalizeSidebarIconColor(row.folderIconColor || meta.folderIconColor || row.folderColor || meta.folderColor || "");
  const tags = normalizeTags(row.tags ?? meta.tags);
  const originSource = normalizeOriginSource(row.originSource ?? meta.originSource);
  const originProjectRef = normalizeProjectRef(row.originProjectRef ?? meta.originProjectRef);
  const category = normalizeCategoryAssignment(row.category ?? meta.category);
  const labels = normalizeLabelAssignments(row.labels ?? meta.labels);
  const keywords = normalizeKeywords(row.keywords ?? meta.keywords);

  return {
    snapshotId,
    chatId,
    /* Phase K-1 — view tier ('saved' | 'linked'). Defaults to 'saved'
     * for legacy callers; only set to 'linked' when explicitly tagged
     * by projectLibraryIndexRowToWorkbenchInput. */
    view: isLinkedRow ? "linked" : "saved",
    title,
    excerpt,
    createdAt,
    updatedAt,
    originalCreatedAt,
    studioAddedAt,
    lastTurnAt,
    messageCount: Number.isFinite(messageCount) ? Math.max(0, Math.floor(messageCount)) : 0,
    answerCount: Number.isFinite(answerCount) ? Math.max(0, Math.floor(answerCount)) : 0,
    pinned,
    archived,
    folderId,
    folderName,
    folderIconColor,
    tags,
    originSource,
    originProjectRef,
    category,
    labels,
    keywords,
    /* Phase K-1 — linked-chat provenance fields. Empty strings on
     * saved rows; populated on linked rows from the Library Index
     * projection. */
    href: String(row.href || meta.href || ""),
    normalizedHref: String(row.normalizedHref || meta.normalizedHref || row.href || meta.href || ""),
    linkSourceHref: String(row.linkSourceHref || meta.linkSourceHref || ""),
    isLinked: isLinkOnlyRow,
    linkedAt: String(row.linkedAt || meta.linkedAt || ""),
    linkedFrom: String(row.linkedFrom || meta.linkedFrom || ""),
  };
}

async function readTitleStateForChat(chatId, chromeValues = null){
  const id = String(chatId || "").trim();
  if (!id) return null;
  const stateKey = `${CHAT_TITLE_STATE_KEY_PREFIX}${id}`;
  const bootKey = `${CHAT_TITLE_BOOT_KEY_PREFIX}${id}`;
  const legacyBootKey = `${LEGACY_CHAT_TITLE_BOOT_KEY_PREFIX}${id}`;

  const direct = normalizeTitleStatePayload(await readSharedRecord(stateKey, chromeValues));
  if (direct) return direct;

  const boot = normalizeTitleStatePayload(await readSharedRecord(bootKey, chromeValues));
  if (boot) return boot;

  let legacyBootRaw = null;
  try { legacyBootRaw = localStorage.getItem(legacyBootKey); } catch {}
  const legacyBoot = normalizeTitleStatePayload(decodeSharedRecord(legacyBootRaw));
  if (legacyBoot) return legacyBoot;

  return null;
}

async function readInterfaceMetaForChat(chatId, chromeValues = null, legacyMetaStore = {}){
  const id = String(chatId || "").trim();
  if (!id) return {};

  const mirrorKey = `${INTERFACE_META_MIRROR_KEY_PREFIX}${id}`;
  const mirror = await readSharedRecord(mirrorKey, chromeValues);
  const legacy = legacyMetaStore && typeof legacyMetaStore === "object" ? legacyMetaStore[id] : null;
  const heatKey = `${HEAT_OVERRIDE_KEY_PREFIX}${id}`;
  const pinKey = `${PIN_KEY_PREFIX}${id}`;
  const rowKey = `${ROW_TINT_KEY_PREFIX}${id}`;

  const chromeHeat = chromeValues && Object.prototype.hasOwnProperty.call(chromeValues, heatKey)
    ? chromeValues[heatKey]
    : null;
  const chromePin = chromeValues && Object.prototype.hasOwnProperty.call(chromeValues, pinKey)
    ? chromeValues[pinKey]
    : null;
  const chromeRow = chromeValues && Object.prototype.hasOwnProperty.call(chromeValues, rowKey)
    ? chromeValues[rowKey]
    : null;

  let localHeat = "";
  let localPinned = false;
  let localRow = -1;
  try { localHeat = localStorage.getItem(heatKey) || ""; } catch {}
  try { localPinned = localStorage.getItem(pinKey) === "1"; } catch {}
  try { localRow = Number.parseInt(localStorage.getItem(rowKey) || "-1", 10); } catch {}

  return {
    ...(legacy && typeof legacy === "object" ? legacy : {}),
    ...(mirror && typeof mirror === "object" ? mirror : {}),
    heatOverride: normalizeHeatLevel((mirror && mirror.heatOverride) || chromeHeat || localHeat || "auto"),
    pinned: !!((mirror && mirror.pinned) || chromePin === "1" || chromePin === true || localPinned),
    rowTint: toRowTintIndex((mirror && mirror.rowTint) ?? chromeRow ?? localRow, -1),
  };
}

async function enrichRowsWithNativeInterfaceData(rows){
  const baseRows = (Array.isArray(rows) ? rows : []).map((row) => ({ ...row }));
  const ids = uniqStrings(baseRows.map((row) => row.chatId));
  if (!ids.length) return baseRows;

  const sharedKeys = ids.flatMap((id) => [
    `${CHAT_TITLE_STATE_KEY_PREFIX}${id}`,
    `${CHAT_TITLE_BOOT_KEY_PREFIX}${id}`,
    `${INTERFACE_META_MIRROR_KEY_PREFIX}${id}`,
    `${HEAT_OVERRIDE_KEY_PREFIX}${id}`,
    `${PIN_KEY_PREFIX}${id}`,
    `${ROW_TINT_KEY_PREFIX}${id}`,
  ]);
  const chromeValues = await chromeStorageGet(sharedKeys).catch(() => ({}));
  const legacyMetaStore = readLocalJson(INTERFACE_META_KEY, {}) || {};

  const out = await Promise.all(baseRows.map(async (row) => {
    const titleState = await readTitleStateForChat(row.chatId, chromeValues);
    const interfaceMeta = await readInterfaceMetaForChat(row.chatId, chromeValues, legacyMetaStore);
    const title = composeTitleFromState(titleState, row.title);
    const originalCreatedAt = firstTimestamp(interfaceMeta.createdAt, row.originalCreatedAt);
    const answerCount = toWholeCount(interfaceMeta.answers ?? interfaceMeta.answerCount, row.answerCount || 0);
    const heatOverride = normalizeHeatLevel(interfaceMeta.heatOverride);
    const pinned = !!(row.pinned || interfaceMeta.pinned);

    state.titleStateByChat[row.chatId] = titleState || {};
    state.interfaceMetaByChat[row.chatId] = interfaceMeta || {};

    const next = {
      ...row,
      title,
      titleState: titleState || null,
      interfaceMeta,
      originalCreatedAt: originalCreatedAt || row.originalCreatedAt,
      answerCount,
      heatOverride,
      rowTint: toRowTintIndex(interfaceMeta.rowTint, -1),
      pinned,
    };
    next.heatLevel = computeHeatLevel(next);
    return next;
  }));

  return out;
}

async function buildRowsFromChatIds(chatIds){
  const rows = [];
  const ids = uniqStrings(chatIds);
  const maxWorkers = 6;
  let index = 0;

  async function worker(){
    while (index < ids.length){
      const current = ids[index];
      index += 1;

      const [latest, snapshots] = await Promise.all([
        callArchive("loadLatestSnapshot", { chatId: current }).catch(() => null),
        callArchive("listSnapshots", { chatId: current }).catch(() => []),
      ]);

      if (!latest) continue;
      const pinned = Array.isArray(snapshots) && snapshots.some((row) => !!row?.pinned);
      const normalized = normalizeWorkbenchRow({
        ...latest,
        pinned,
        archived: latest?.archived ?? latest?.meta?.archived ?? (String(latest?.meta?.state || "").trim().toLowerCase() === "archived"),
      });
      if (normalized) rows.push(normalized);
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxWorkers, ids.length) }, worker));
  return rows;
}

// ── Desktop reader / list (M2a-3j) ──────────────────────────────────────────
// On Tauri Studio Desktop, the workbench list is sourced from
// H2O.LibraryIndex (which already reads from store.chats + folder/label/
// tag/category binding stores via M2a-3g). This pure mapper translates a
// LibraryIndex compact row into the raw shape that normalizeWorkbenchRow
// accepts. Saved rows must carry snapshotId; linked-only rows
// (view === 'linked', state.isLinked && !state.isSaved) are passed
// through with snapshotId === '' — Phase K-1 widens the previous
// snapshot-required guard so the Linked Chats view (#/linked) can
// render Add-to-Library records without a captured transcript.
function projectLibraryIndexRowToWorkbenchInput(liRow){
  if (!liRow || typeof liRow !== 'object') return null;
  const chatId = String(liRow.chatId || '').trim();
  const snapshotId = String(liRow.snapshotId || liRow.lastSnapshotId || liRow.latestSnapshotId || liRow.snapshot_id || '').trim();
  const liView = String(liRow.view || '').toLowerCase();
  const isLinkedRow = liView === 'linked';
  const isLinkedState = liRow.isLinked === true
    || !!(liRow.state && typeof liRow.state === 'object' && liRow.state.isLinked === true);
  const isLinkOnlyRow = isLinkedRow || isLinkedState;
  /* Saved rows still require snapshotId; linked / saved+linked rows do not. */
  if (!chatId) return null;
  if (!snapshotId && !isLinkOnlyRow) return null;

  // LI carries timestamps as epoch ms (capturedAt, updatedAt);
  // normalizeWorkbenchRow expects ISO strings. Same conversion edge as
  // M2a-3i's projectSqliteSnapshotToCanonical.
  function toIso(epochMs){
    if (!epochMs || typeof epochMs !== 'number' || epochMs <= 0) return '';
    try { return new Date(epochMs).toISOString(); }
    catch { return ''; }
  }
  const updatedAtIso = toIso(liRow.updatedAt);
  const capturedAtIso = toIso(liRow.capturedAt);

  const labelNames = Array.isArray(liRow.labels) ? liRow.labels : [];
  const tagNames   = Array.isArray(liRow.tags)   ? liRow.tags   : [];

  return {
    snapshotId: snapshotId || '',
    chatId,
    view: isLinkedRow ? 'linked' : 'saved',
    title: liRow.title || '',
    createdAt: capturedAtIso || updatedAtIso || '',
    updatedAt: updatedAtIso || '',
    messageCount: Number(liRow.messageCount || 0),
    answerCount: Number(liRow.answerCount || 0),
    pinned: !!liRow.pinned,
    archived: !!liRow.archived,
    folderId: liRow.folderId || '',
    folderName: liRow.folderName || '',
    tags: tagNames.slice(),
    labels: labelNames.map((name) => ({ id: name, name, label: name })),
    category: (liRow.categoryId || liRow.categoryName)
      ? { id: liRow.categoryId || '', name: liRow.categoryName || '', label: liRow.categoryName || liRow.categoryId || '' }
      : null,
    keywords: [],
    /* Phase K-1 — propagate linked-chat provenance so the row renderer
     * can surface "Open original" + Linked-from metadata without re-
     * reading the Chat Registry. Empty strings on saved rows. */
    href: String(liRow.href || liRow.normalizedHref || ''),
    normalizedHref: String(liRow.normalizedHref || liRow.href || ''),
    linkSourceHref: String(liRow.linkSourceHref || ''),
    isLinked: isLinkOnlyRow,
    linkedAt: typeof liRow.linkedAt === 'number' ? toIso(liRow.linkedAt) : String(liRow.linkedAt || ''),
    linkedFrom: String(liRow.linkedFrom || ''),
    meta: {
      title: liRow.title || '',
      folderId: liRow.folderId || '',
      folderName: liRow.folderName || '',
      messageCount: Number(liRow.messageCount || 0),
      updatedAt: updatedAtIso || '',
    },
  };
}

function hasLibraryIndexRowsApi(){
  const raw = W.H2O?.LibraryIndex?.getAll;
  return typeof raw === "function"
    || Array.isArray(raw)
    || !!(raw && typeof raw.length === "number");
}

function readLibraryIndexRows(){
  const idx = W.H2O?.LibraryIndex;
  const raw = idx?.getAll;
  try {
    const rows = typeof raw === "function" ? raw.call(idx) : raw;
    if (Array.isArray(rows)) return rows.slice();
    if (rows && typeof rows.length === "number") return Array.from(rows);
  } catch {}
  return [];
}

function readLinkedWorkbenchRowsFromLibraryIndex(){
  return readLibraryIndexRows()
    .filter((row) => String(row?.view || "").toLowerCase() === "linked")
    .map(projectLibraryIndexRowToWorkbenchInput)
    .filter(Boolean)
    .map(normalizeWorkbenchRow)
    .filter(Boolean);
}

function libraryRowIsSavedTranscript(row){
  if (!row || typeof row !== "object") return false;
  const core = W.H2O?.Library?.LibraryIndexCore || null;
  if (core && typeof core.rowIsSavedRecentEligible === "function") {
    try { return !!core.rowIsSavedRecentEligible(row); } catch (_) {}
  }
  const view = String(row.view || row.displayView || row.badgeKind || "").toLowerCase();
  if (view === "linked" || view === "link") return false;
  if (String(row.opens || row.openTarget || row.openKind || "").trim().toLowerCase() === "placeholder-details") return false;
  if (row.saved === false || row.isSaved === false || row.is_saved === false) return false;
  if (core && typeof core.rowHasTranscriptEvidence === "function") {
    try { if (!core.rowHasTranscriptEvidence(row)) return false; } catch (_) { if (!rowReaderSnapshotId(row)) return false; }
  } else if (!rowReaderSnapshotId(row)) {
    const count = Number(row.messageCount || row.turnCount || row.userTurnCount || row.assistantTurnCount || row.answerCount || 0) || 0;
    if (count <= 0) return false;
  }
  if (view === "saved" || view === "imported") return true;
  const state = row.state && typeof row.state === "object" ? row.state : {};
  if (state.isSaved === false) return false;
  return row.isSaved === true || state.isSaved === true || row.saved === true;
}

function stableSavedRecentRowTime(row){
  const value = row?.sortAt || row?.capturedAt || row?.lastCapturedAt || row?.snapshotCapturedAt || row?.savedAt || row?.createdAt || row?.lastMessageAt || row?.lastInteractionAt || row?.updatedAt || row?.lastSeenAt || row?.observedAt || "";
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n < 100000000000 ? n * 1000 : n;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function canonicalSavedRecentLibraryIndexRows(limit = 30){
  const rows = readLibraryIndexRows();
  const core = W.H2O?.Library?.LibraryIndexCore || null;
  if (core && typeof core.canonicalSavedRecentRows === "function") {
    return core.canonicalSavedRecentRows(rows, limit, { dateField: "savedRecent" });
  }
  const source = Array.isArray(rows) ? rows.slice() : [];
  const saved = source.filter((row) => {
    const view = String(row?.view || row?.displayView || row?.badgeKind || "").toLowerCase();
    if (view === "deleted" || view === "tombstone") return false;
    if (row?.deleted || row?.isDeleted || row?.tombstoned) return false;
    return libraryRowIsSavedTranscript(row);
  });
  saved.sort((a, b) => {
    const dateCompare = stableSavedRecentRowTime(b) - stableSavedRecentRowTime(a);
    const titleCompare = String(a?.title || "").localeCompare(String(b?.title || ""));
    const idCompare = String(a?.chatId || a?.id || "").localeCompare(String(b?.chatId || b?.id || ""));
    return dateCompare || titleCompare || idCompare;
  });
  const cap = Number(limit);
  return Number.isFinite(cap) && cap >= 0 ? saved.slice(0, cap) : saved;
}

function projectRecentLibraryRowsToWorkbenchRows(rows){
  return (Array.isArray(rows) ? rows : [])
    .map(projectLibraryIndexRowToWorkbenchInput)
    .filter(Boolean)
    .map(normalizeWorkbenchRow)
    .filter(Boolean);
}

function mergeLinkedLibraryIndexRows(baseRows){
  const out = Array.isArray(baseRows) ? baseRows.slice() : [];
  const seenChatIds = new Set();
  for (const row of out){
    const chatId = String(row?.chatId || "").trim();
    if (chatId) seenChatIds.add(chatId);
  }
  for (const row of readLinkedWorkbenchRowsFromLibraryIndex()){
    const chatId = String(row?.chatId || "").trim();
    if (!chatId || seenChatIds.has(chatId)) continue;
    out.push(row);
    seenChatIds.add(chatId);
  }
  return out;
}

async function fetchWorkbenchRows(force = false){
  if (!force && Array.isArray(state.rowsCache)) return state.rowsCache.slice();

  state.lastFetchDiag = { source: "", directOk: false, idsOk: false, errors: [] };

  // Desktop (Tauri) — M2a-3j: project saved-snapshot rows from
  // H2O.LibraryIndex (already wired to SQLite stores via M2a-3g) instead
  // of going through the MV3 archive bridge. normalizeWorkbenchRow's
  // snapshotId guard naturally drops linked-only chats; the callArchive
  // interceptors below stay as a defensive fallback if LibraryIndex
  // happens to be unavailable. On failure here we fall through to the
  // archive path (which on Desktop returns [] via the M2a-3i sidebar
  // interceptors), preserving the empty-state UI rather than throwing.
  if (STUDIO_isTauri() && hasLibraryIndexRowsApi()) {
    try {
      const liRows = readLibraryIndexRows();
      const raw = liRows.map(projectLibraryIndexRowToWorkbenchInput).filter(Boolean);
      state.rowsCache = raw.map(normalizeWorkbenchRow).filter(Boolean);
      state.lastFetchDiag = { source: 'desktop-library-index', directOk: true, idsOk: false, errors: [] };
      return state.rowsCache.slice();
    } catch (e) {
      state.lastFetchDiag = { source: 'desktop-library-index', directOk: false, idsOk: false, errors: [String(e?.message || e)] };
      // Fall through to the (empty-result) archive path as safety net.
    }
  }

  const direct = await tryArchiveOps(LIST_ROW_OPS, {});
  if (direct.ok && Array.isArray(direct.result)){
    state.lastFetchDiag = { source: direct.op, directOk: true, idsOk: false, errors: [] };
    state.rowsCache = mergeLinkedLibraryIndexRows(direct.result.map(normalizeWorkbenchRow).filter(Boolean));
    return state.rowsCache.slice();
  }

  const directErr = direct.error?.message || "";
  const idsAttempt = await tryArchiveOps(CHAT_ID_OPS, {});
  if (idsAttempt.ok && Array.isArray(idsAttempt.result)){
    state.lastFetchDiag = { source: idsAttempt.op, directOk: false, idsOk: true, errors: directErr ? [directErr] : [] };
    state.rowsCache = mergeLinkedLibraryIndexRows(await buildRowsFromChatIds(idsAttempt.result));
    return state.rowsCache.slice();
  }

  const errors = [directErr, idsAttempt.error?.message || ""].filter(Boolean);
  const linkedRows = readLinkedWorkbenchRowsFromLibraryIndex();
  if (linkedRows.length){
    state.lastFetchDiag = { source: "library-index-linked", directOk: false, idsOk: false, errors };
    state.rowsCache = linkedRows;
    return state.rowsCache.slice();
  }
  state.lastFetchDiag = { source: "", directOk: false, idsOk: false, errors };
  throw new Error(errors.join(" · ") || "Studio listing is unavailable because the archive background does not expose a list operation yet.");
}

function normalizeFolderCatalog(raw){
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const row of src){
    const folder = normalizeFolderRecord(row);
    if (!folder.id || seen.has(folder.id)) continue;
    out.push(folder);
    seen.add(folder.id);
  }
  return out;
}

function normalizeSidebarIconColor(raw){
  const value = String(raw || "").trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : "";
}

function makeKnownCanonicalFolderCatalogFallback(reason = "studio-known-canonical-fallback"){
  return FOLDER_DESKTOP_MIRROR_CANONICAL_ROWS.map((row, index) => {
    const folderId = String(row.folderId || "").trim();
    const color = normalizeSidebarIconColor(FOLDER_DESKTOP_MIRROR_CANONICAL_COLORS[folderId] || "");
    return {
      id: folderId,
      folderId,
      name: String(row.name || folderId).trim() || folderId,
      createdAt: "",
      updatedAt: "",
      kind: "folder",
      projectRef: null,
      iconColor: color,
      color,
      colorSource: color ? "known-canonical-display-palette" : "default",
      source: reason,
      displayCountLabel: "",
      canonicalCount: 0,
      nativeMembershipCount: 0,
      knownCount: 0,
      knownStudioCount: 0,
      savedCount: 0,
      linkedCount: 0,
      orphanCount: 0,
      localBindingCount: 0,
      badges: [],
      isCanonical: true,
      sortOrder: index + 1,
    };
  }).filter((row) => row.id);
}

function mergeFolderCatalogs(...lists){
  const out = [];
  const seen = new Set();
  for (const raw of lists){
    for (const item of normalizeFolderCatalog(raw)){
      if (seen.has(item.id)){
        const existing = out.find((row) => row.id === item.id);
        if (existing && (!existing.name || existing.name === existing.id) && item.name) {
          existing.name = item.name;
        }
        if (existing && !existing.iconColor && item.iconColor) {
          existing.iconColor = item.iconColor;
        }
        if (existing && !existing.displayCountLabel && item.displayCountLabel) {
          existing.displayCountLabel = item.displayCountLabel;
        }
        ["canonicalCount", "knownCount", "savedCount", "linkedCount", "orphanCount", "localBindingCount"].forEach((key) => {
          if (existing && existing[key] == null && item[key] != null) existing[key] = item[key];
        });
        if (existing && Array.isArray(item.badges) && item.badges.length) {
          existing.badges = Array.from(new Set([...(existing.badges || []), ...item.badges]));
        }
        ["isCanonical", "isExtra", "isTestCandidate", "isConflict"].forEach((key) => {
          if (existing && item[key] === true) existing[key] = true;
        });
        continue;
      }
      out.push({ ...item });
      seen.add(item.id);
    }
  }
  return out;
}

function deriveFolderCatalogFromRows(rows){
  const derived = [];
  const seen = new Set();
  for (const row of (Array.isArray(rows) ? rows : [])){
    const folderId = String(row?.folderId || "").trim();
    if (!folderId || seen.has(folderId)) continue;
    derived.push({
      id: folderId,
      name: String(row?.folderName || folderId).trim() || folderId,
      createdAt: "",
      updatedAt: "",
      kind: "local",
      projectRef: null,
      iconColor: normalizeSidebarIconColor(row?.folderIconColor || ""),
    });
    seen.add(folderId);
  }
  derived.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  return derived;
}

function normalizeFolderBinding(raw){
  const src = raw && typeof raw === "object" ? raw : {};
  const binding = {
    folderId: String(src.folderId || src.id || "").trim(),
    folderName: String(src.folderName || src.name || src.title || "").trim(),
  };
  const source = String(src.folderBindingSource || "").trim().toLowerCase();
  if (source === "auto" || source === "user") binding.folderBindingSource = source;
  return binding;
}

function normalizeFolderBindingMap(raw){
  const out = new Map();
  if (Array.isArray(raw)){
    for (const row of raw){
      const chatId = String(row?.chatId || "").trim();
      if (!chatId) continue;
      out.set(chatId, normalizeFolderBinding(row));
    }
    return out;
  }
  if (!raw || typeof raw !== "object") return out;
  for (const [chatId, value] of Object.entries(raw)){
    const id = String(chatId || "").trim();
    if (!id) continue;
    out.set(id, normalizeFolderBinding(value));
  }
  return out;
}

function resolveFolderName(folderId){
  const id = String(folderId || "").trim();
  if (!id) return "";
  const fromCatalog = state.folderCatalog.find((row) => row.id === id);
  if (fromCatalog?.name) return fromCatalog.name;
  const fromRows = (state.rowsCache || []).find((row) => String(row.folderId || "").trim() === id);
  if (fromRows?.folderName) return fromRows.folderName;
  return id;
}

function getSelectedRow(){
  const sid = String(state.selectedSnapshotId || state.currentReaderSnapshot?.snapshotId || "").trim();
  if (!sid) return null;
  return (state.rowsCache || []).find((row) => row.snapshotId === sid) || null;
}

function getSelectedFolderId(){
  const row = getSelectedRow();
  if (row) return String(row.folderId || "").trim();
  return String(state.currentReaderSnapshot?.meta?.folderId || "").trim();
}

function rememberFolderBindings(map){
  for (const [chatId, binding] of map.entries()){
    state.folderBindingsByChat[chatId] = normalizeFolderBinding(binding);
  }
}

// ── Library Workspace facade integration ──────────────────────────────────────
// Prefer H2O.LibraryWorkspace (canonical model facade from S0F1b) when it has
// already booted. The facade memoises results, dedups in-flight calls, and
// emits library-workspace:updated when state changes (so we can re-render
// without polling). If the facade isn't ready yet we fall back to the original
// direct archive bridge call — identical behavior to pre-migration, so this is
// a strict opportunistic upgrade with zero regression risk.
function getLibraryWorkspace(){
  try { return W.H2O?.LibraryWorkspace || null; } catch { return null; }
}

function mapFolderParityRowsToCatalog(rows){
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const folderId = String(row?.folderId || row?.id || "").trim();
    if (!folderId) return null;
    return {
      id: folderId,
      folderId,
      name: String(row?.name || folderId).trim() || folderId,
      createdAt: "",
      updatedAt: "",
      kind: "local",
      projectRef: null,
      iconColor: normalizeSidebarIconColor(row?.iconColor || row?.color || ""),
      source: String(row?.source || "folder-parity-display-model").trim(),
      displayCountLabel: String(row?.displayCountLabel || "").trim(),
      canonicalCount: Number(row?.canonicalCount || 0) || 0,
      knownCount: Number(row?.knownCount || 0) || 0,
      savedCount: Number(row?.savedCount || 0) || 0,
      linkedCount: Number(row?.linkedCount || 0) || 0,
      orphanCount: Number(row?.orphanCount || 0) || 0,
      localBindingCount: Number(row?.localBindingCount || 0) || 0,
      badges: Array.isArray(row?.badges) ? row.badges.map((badge) => String(badge || "").trim()).filter(Boolean) : [],
      isCanonical: row?.isCanonical === true,
      isExtra: row?.isExtra === true,
      isTestCandidate: row?.isTestCandidate === true,
      isConflict: row?.isConflict === true,
      reviewBucket: String(row?.reviewBucket || "").trim(),
    };
  }).filter(Boolean);
}

async function fetchFolderParityCatalog(force = false){
  // Kept for back-compat with any non-renderer consumer that still wants the
  // union. The canonical sidebar path uses fetchFolderParityPartition.
  const api = W.H2O?.Library?.FolderParity;
  if (typeof api?.getDisplayModel !== "function") return [];
  const model = await promiseWithTimeout(
    api.getDisplayModel({ fresh: !!force }),
    STUDIO_BOOT_AUX_TIMEOUT_MS,
    "FolderParity.getDisplayModel"
  );
  const rows = mapFolderParityRowsToCatalog(model?.rows || []);
  return rows.length ? rows : [];
}

async function fetchFolderParityPartition(force = false){
  const api = W.H2O?.Library?.FolderParity;
  if (typeof api?.getDisplayModel !== "function") {
    return {
      canonical: makeKnownCanonicalFolderCatalogFallback("folder-parity-api-loading"),
      review: [],
      fallbackUsed: true,
      fallbackModelUsed: true,
      folderCatalogReady: true,
      displayModelAvailable: true,
      storedModelAvailable: false,
      nativeBroadcastRequired: false,
      renderBlockedReason: "",
    };
  }
  const model = await promiseWithTimeout(
    api.getDisplayModel({ fresh: !!force }),
    STUDIO_BOOT_AUX_TIMEOUT_MS,
    "FolderParity.getDisplayModel"
  );
  const canonical = mapFolderParityRowsToCatalog(model?.canonicalRows || []);
  return {
    canonical: canonical.length ? canonical : makeKnownCanonicalFolderCatalogFallback("folder-parity-empty-display-model"),
    review: mapFolderParityRowsToCatalog(model?.localReviewRows || []),
    fallbackUsed: !!model?.fallbackUsed || !canonical.length,
    fallbackModelUsed: !!model?.fallbackModelUsed || !canonical.length,
    folderCatalogReady: model?.folderCatalogReady === true || canonical.length > 0,
    displayModelAvailable: model?.displayModelAvailable === true || canonical.length > 0,
    storedModelAvailable: model?.storedModelAvailable === true,
    nativeBroadcastRequired: !canonical.length && model?.nativeBroadcastRequired === true,
    renderBlockedReason: canonical.length ? "" : (model?.renderBlockedReason || "folder-parity-empty-display-model"),
  };
}

async function fetchFolderCatalog(force = false){
  const cachedCatalog = Array.isArray(state.folderCatalog) ? state.folderCatalog : [];
  const cachedReview = Array.isArray(state.folderLocalReview) ? state.folderLocalReview : [];
  if (!force && cachedCatalog.length){
    return { canonical: cachedCatalog.slice(), review: cachedReview.slice() };
  }
  try {
    const partition = await fetchFolderParityPartition(force);
    state.folderCatalog = normalizeFolderCatalog(partition.canonical);
    state.folderLocalReview = normalizeFolderCatalog(partition.review);
    return {
      canonical: Array.isArray(state.folderCatalog) ? state.folderCatalog.slice() : [],
      review: Array.isArray(state.folderLocalReview) ? state.folderLocalReview.slice() : [],
    };
  } catch { /* FolderParity is the preferred canonical source per P8a contract.
                If it is still booting, use the same protected known-canonical
                display rows locally so the UI does not block on native broadcast. */ }
  if (cachedCatalog.length) return { canonical: cachedCatalog.slice(), review: cachedReview.slice() };
  state.folderCatalog = normalizeFolderCatalog(makeKnownCanonicalFolderCatalogFallback("folder-parity-timeout-fallback"));
  state.folderLocalReview = cachedReview.slice();
  return { canonical: state.folderCatalog.slice(), review: state.folderLocalReview.slice() };
}

async function fetchLabelCatalog(force = false){
  if (!force && Array.isArray(state.labelCatalog) && state.labelCatalog.length) return state.labelCatalog.slice();
  const ws = getLibraryWorkspace();
  if (ws?.getLabels){
    try {
      const list = await promiseWithTimeout(
        ws.getLabels({ fresh: !!force }),
        STUDIO_BOOT_AUX_TIMEOUT_MS,
        "LibraryWorkspace.getLabels"
      );
      if (Array.isArray(list)){
        state.labelCatalog = normalizeLabelCatalog(list);
        return Array.isArray(state.labelCatalog) ? state.labelCatalog.slice() : [];
      }
    } catch { /* fall through to archive bridge */ }
  }
  const attempt = await tryArchiveOps(LABEL_CATALOG_OPS, {});
  if (attempt.ok){
    state.labelCatalog = normalizeLabelCatalog(attempt.result);
  }
  return Array.isArray(state.labelCatalog) ? state.labelCatalog.slice() : [];
}

async function fetchCategoryCatalog(force = false){
  if (!force && Array.isArray(state.categoryCatalog) && state.categoryCatalog.length) return state.categoryCatalog.slice();
  const ws = getLibraryWorkspace();
  if (ws?.getCategories){
    try {
      const list = await promiseWithTimeout(
        ws.getCategories({ fresh: !!force }),
        STUDIO_BOOT_AUX_TIMEOUT_MS,
        "LibraryWorkspace.getCategories"
      );
      if (Array.isArray(list)){
        state.categoryCatalog = normalizeCategoryCatalog(list);
        return Array.isArray(state.categoryCatalog) ? state.categoryCatalog.slice() : [];
      }
    } catch { /* fall through to archive bridge */ }
  }
  const attempt = await tryArchiveOps(CATEGORY_CATALOG_OPS, {});
  if (attempt.ok){
    state.categoryCatalog = normalizeCategoryCatalog(attempt.result);
  }
  return Array.isArray(state.categoryCatalog) ? state.categoryCatalog.slice() : [];
}

// One-time subscription: when Library Workspace cache busts (folder binding
// change, category change, cross-surface sync), drop our local catalog caches
// so the next fetch picks up the canonical model. This is fire-and-forget — if
// Workspace isn't ready, we wire the listener once it emits its ready event.
(function wireLibraryWorkspaceSubscription(){
  function attach(){
    const ws = getLibraryWorkspace();
    if (!ws || typeof ws.subscribe !== 'function') return false;
    ws.subscribe((evt) => {
      const reason = String(evt?.reason || '');
      // Only bust on changes that actually affect catalogs (not on every
      // route-change/index-tick).
      if (['folder-binding-changed','category-changed','index-updated','cache-bust','cross-surface-sync'].includes(reason)){
        state.folderCatalog = [];
        state.folderLocalReview = [];
        state.categoryCatalog = [];
        state.labelCatalog = [];
      }
    });
    return true;
  }
  if (!attach()){
    W.addEventListener('h2o.ev:prm:cgx:lib:ready:v1', () => { attach(); }, { once: true });
  }
  // Also listen for Library Sync's cross-surface-sync event independently so
  // we catch native-originated changes even if the Workspace facade is slow.
  const handleCatalogBroadcast = () => {
    state.folderCatalog = [];
    state.folderLocalReview = [];
    state.categoryCatalog = [];
    state.labelCatalog = [];
    renderFolderSidebar(state.rowsCache || [], state.lastView, state.lastFolderId);
    renderFolderAssignmentControl();
  };
  W.addEventListener('evt:h2o:library:cross-surface-sync', handleCatalogBroadcast);
  W.addEventListener('evt:h2o:folders:changed', handleCatalogBroadcast);
  W.addEventListener('evt:h2o:labels:changed', handleCatalogBroadcast);
})();

function resolveCategoryRecord(categoryId){
  const id = String(categoryId || "").trim();
  if (!id) return null;
  return (state.categoryCatalog || []).find((row) => row.id === id) || null;
}

function resolveCategoryName(categoryId){
  const id = String(categoryId || "").trim();
  if (!id) return "Uncategorized";
  return String(resolveCategoryRecord(id)?.name || "Uncategorized");
}

function updateRowCategory(snapshotId, category){
  const sid = String(snapshotId || "").trim();
  if (!sid) return;
  const normalized = normalizeCategoryAssignment(category);
  if (Array.isArray(state.rowsCache)){
    state.rowsCache = state.rowsCache.map((row) => (
      row.snapshotId === sid ? { ...row, category: normalized } : row
    ));
  }
  if (state.currentReaderSnapshot?.snapshotId === sid) {
    const meta = state.currentReaderSnapshot.meta && typeof state.currentReaderSnapshot.meta === "object"
      ? state.currentReaderSnapshot.meta
      : {};
    state.currentReaderSnapshot.meta = {
      ...meta,
      category: normalized,
    };
  }
}

function applySnapshotCategoryUpdate(snap){
  if (!snap || typeof snap !== "object") return;
  const sid = String(snap.snapshotId || "").trim();
  if (!sid) return;
  const meta = snap.meta && typeof snap.meta === "object" ? snap.meta : {};
  updateRowCategory(sid, meta.category);
  if (state.currentReaderSnapshot?.snapshotId === sid) {
    state.currentReaderSnapshot = {
      ...state.currentReaderSnapshot,
      ...snap,
      meta: {
        ...(state.currentReaderSnapshot.meta && typeof state.currentReaderSnapshot.meta === "object" ? state.currentReaderSnapshot.meta : {}),
        ...meta,
      },
    };
  }
}

async function resolveFolderBindingsForChatIds(chatIds){
  const ids = uniqStrings(chatIds);
  if (!ids.length) return new Map();

  const attempt = await tryArchiveOps(FOLDER_BINDING_OPS, { chatIds: ids });
  if (!attempt.ok) {
    const fallback = new Map();
    for (const chatId of ids){
      if (!Object.prototype.hasOwnProperty.call(state.folderBindingsByChat, chatId)) continue;
      fallback.set(chatId, normalizeFolderBinding(state.folderBindingsByChat[chatId]));
    }
    return fallback;
  }

  const map = normalizeFolderBindingMap(attempt.result);
  rememberFolderBindings(map);
  return map;
}

function mergeRowFolderData(row, bindingMap){
  const next = { ...row };
  const hasBinding = bindingMap.has(next.chatId);
  const binding = hasBinding ? normalizeFolderBinding(bindingMap.get(next.chatId)) : null;

  if (binding){
    next.folderId = binding.folderId;
    next.folderName = binding.folderId
      ? (binding.folderName || resolveFolderName(binding.folderId) || binding.folderId)
      : "";
  } else if (next.folderId) {
    next.folderName = String(next.folderName || resolveFolderName(next.folderId) || next.folderId).trim();
  } else {
    next.folderName = "";
  }

  return next;
}

async function enrichRowsWithFolderData(rows, force = false){
  const baseRows = await enrichRowsWithNativeInterfaceData(rows);
  const [, bindingMap] = await Promise.all([
    promiseWithTimeoutFallback(
      fetchFolderCatalog(force),
      STUDIO_BOOT_AUX_TIMEOUT_MS,
      "fetchFolderCatalog",
      { canonical: [], review: [] }
    ),
    promiseWithTimeoutFallback(
      resolveFolderBindingsForChatIds(baseRows.map((row) => row.chatId)),
      STUDIO_BOOT_AUX_TIMEOUT_MS,
      "resolveFolderBindingsForChatIds",
      new Map()
    ),
  ]);
  // fetchFolderCatalog already wrote state.folderCatalog (canonical) and
  // state.folderLocalReview (review). Row-derived folders no longer pollute
  // the canonical sidebar per P8a contract.
  const merged = baseRows.map((row) => mergeRowFolderData(row, bindingMap));
  state.rowsCache = merged.slice();
  return merged;
}

function matchesView(row, view){
  if (!row) return false;
  const next = normalizeArchiveView(view);
  const rowView = String(row.view || "").toLowerCase();
  const rowState = row.state && typeof row.state === "object" ? row.state : {};
  const saved = rowView === "saved" || row.saved === true || row.isSaved === true || row.is_saved === true || rowState.isSaved === true;
  const archived = !!(row.archived || row.isArchived);
  const deleted = !!(row.deleted || row.isDeleted || row.tombstoned);
  if (deleted) return false;
  if (next === "archive") return archived;
  if (archived && !saved) return false;
  if (next === "pinned") return !!row.pinned;
  /* Phase K-1 — Linked view: only rows projected as linked-only by
   * Library Index (state.isLinked && !state.isSaved). Saved rows
   * (even if they also carry linked metadata) belong in #/saved by
   * the precedence rule documented in normalizeLinkedOnlyProjection. */
  if (next === "linked") return rowView === "linked" && !saved;
  /* Saved view: explicitly exclude linked-only rows so a chat without
   * a snapshot does not surface alongside Saved snapshots. */
  if (next === "saved") return saved;
  return true;
}

function matchesFolder(row, folderId){
  const filterId = normalizeFolderFilter(folderId);
  if (!filterId) return true;
  const rowFolderId = String(row?.folderId || "").trim();
  if (filterId === FOLDER_FILTER_NONE) return !rowFolderId;
  return rowFolderId === filterId;
}

function filterRows(rows, view, query, folderId = "", tagFilter = ""){
  const q = normalizeText(query).toLowerCase();
  const filtered = (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!matchesView(row, view)) return false;
    if (!matchesFolder(row, folderId)) return false;
    if (tagFilter && !(Array.isArray(row.tags) ? row.tags : []).includes(tagFilter)) return false;

    if (!q) return true;
    const labels = row?.labels || {};
    /* Phase K-1 — Linked rows carry href + linkedFrom (canonical URL +
     * provenance source). Include both in the search haystack so the
     * Linked Chats view can be filtered by URL or origin. Empty for
     * Saved rows, so the only change for non-linked rows is two extra
     * empty tokens — no behavioral difference. */
    const haystack = [
      row.title,
      row.excerpt,
      row.chatId,
      row.folderId,
      row.folderName,
      row.originSource,
      row.href || "",
      row.linkedFrom || "",
      row?.category?.primaryCategoryId,
      row?.category?.secondaryCategoryId,
      ...labelSearchTokens(labels),
      ...(row.tags || []),
      ...(row.keywords || []),
    ].join(" ").toLowerCase();
    return haystack.includes(q);
  });

  const core = W.H2O?.Library?.LibraryIndexCore || null;
  if (core && typeof core.canonicalSortRows === "function") {
    const sorted = core.canonicalSortRows(filtered, "recent", "best");
    sorted.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return 0;
    });
    return sorted;
  }

  filtered.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const dateCompare = String(b.updatedAt || b.capturedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.capturedAt || a.createdAt || ""));
    const titleCompare = String(a.title || "").localeCompare(String(b.title || ""));
    const idCompare = String(a.chatId || a.id || "").localeCompare(String(b.chatId || b.id || ""));
    return dateCompare || titleCompare || idCompare;
  });
  return filtered;
}

function setActiveNav(view){
  const next = normalizeArchiveView(view);
  state.lastView = next;
  $$(".wbNavItem[data-view]").forEach((node) => {
    node.classList.toggle("active", String(node.dataset.view || "") === next);
  });
}

function setActiveFolder(folderId){
  const selected = normalizeFolderFilter(folderId);
  state.lastFolderId = selected;
  $$(".wbFolderItem[data-folder-id]").forEach((node) => {
    const dataId = String(node.dataset.folderId || "");
    node.classList.toggle("active", dataId === selected);
  });
}

function buildFilterPill(label, accent = false){
  return `<span class="wbFilterPill${accent ? " wbFilterPill--accent" : ""}">${esc(label)}</span>`;
}

function renderListHeader(allRows, filteredRows, view, folderId, query){
  const totalForView = (Array.isArray(allRows) ? allRows : []).filter((row) => matchesView(row, view)).length;
  const folderLabel = folderId === FOLDER_FILTER_NONE
    ? "Unfiled"
    : (folderId ? resolveFolderName(folderId) : "All folders");

  const title = viewCopy(view);
  let subtitle = `${pluralize(filteredRows.length, "chat")} shown`;
  if (totalForView !== filteredRows.length) subtitle += ` of ${pluralize(totalForView, "chat")}`;
  if (folderId) subtitle += ` in ${folderLabel}`;
  if (query) subtitle += ` matching "${query}"`;

  const pills = [
    buildFilterPill(viewLabel(view), true),
  ];
  if (folderId) pills.push(buildFilterPill(folderLabel, true));
  if (query) pills.push(buildFilterPill(`Search: ${query}`));
  pills.push(buildFilterPill(`${filteredRows.length} shown`));

  const titleEl = $("#listTitle");
  const subtitleEl = $("#listSubtitle");
  const filterEl = $("#listFilters");
  if (titleEl) titleEl.textContent = title;
  if (subtitleEl) subtitleEl.textContent = subtitle;
  if (filterEl) filterEl.innerHTML = pills.join("");

  setRouteMeta("Studio", folderId ? `${title} / ${folderLabel}` : title, subtitle);
}

function collectFolderSidebarItems(rows, view, mode = "canonical"){
  const base = (Array.isArray(rows) ? rows : []).filter((row) => matchesView(row, view));
  let unfiledCount = 0;
  for (const row of base){
    const folderId = String(row?.folderId || "").trim();
    if (!folderId) unfiledCount += 1;
  }

  // Canonical mode reads state.folderCatalog (canonical-only per P8a contract).
  // Review mode reads state.folderLocalReview. Neither merges row-derived
  // folders — extras only appear if FolderParity recognises them as Local Review.
  const sourceCatalog = mode === "review"
    ? (Array.isArray(state.folderLocalReview) ? state.folderLocalReview : [])
    : (Array.isArray(state.folderCatalog) ? state.folderCatalog : []);
  const out = [];
  for (const folder of sourceCatalog){
    const canonicalCount = Number(folder.canonicalCount || 0) || 0;
    const knownCount = Number(folder.knownCount || 0) || 0;
    const localBindingCount = Number(folder.localBindingCount || 0) || 0;
    const nativeMembershipCount = Number(folder.nativeMembershipCount ?? canonicalCount) || 0;
    out.push({
      folderId: folder.id,
      label: folder.name || folder.id,
      // P8a contract §8: primary count is native membership, never max'd with
      // local binding counts. displayCountLabel ("<n> native · <m> known")
      // drives the visible UI; numeric count only gates the is-empty class.
      count: nativeMembershipCount,
      displayCountLabel: String(folder.displayCountLabel || "").trim(),
      canonicalCount,
      nativeMembershipCount,
      knownCount,
      knownStudioCount: Number(folder.knownStudioCount ?? knownCount) || 0,
      savedCount: Number(folder.savedCount || 0) || 0,
      linkedCount: Number(folder.linkedCount || 0) || 0,
      orphanCount: Number(folder.orphanCount || 0) || 0,
      localBindingCount,
      badges: Array.isArray(folder.badges) ? folder.badges.slice() : [],
      isCanonical: folder.isCanonical === true,
      isExtra: folder.isExtra === true,
      isTestCandidate: folder.isTestCandidate === true,
      isConflict: folder.isConflict === true,
      reviewBucket: folder.reviewBucket || null,
      kind: "folder",
      folderKind: folder.kind || "local",
      iconColor: normalizeSidebarIconColor(folder.iconColor || ""),
    });
  }
  if (mode === "canonical") {
    out.push({
      folderId: FOLDER_FILTER_NONE,
      label: "Unfiled",
      count: unfiledCount,
      kind: "utility",
      isSystem: true,
      isUnfiled: true,
    });
  }
  return out;
}

const SIDEBAR_FOLDER_ICON_SVG = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-11Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
  </svg>
`;

const SIDEBAR_UNFILED_ICON_SVG = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 5.5h14l-1.8 8.2a2.5 2.5 0 0 1-2.4 2H9.2a2.5 2.5 0 0 1-2.4-2L5 5.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
    <path d="M8 15.5h1.7a2.3 2.3 0 0 0 4.6 0H16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M4 18.5h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
  </svg>
`;

function folderSidebarCountDetails(item, countText){
  if (!folderOperatorModeEnabled()) return folderSidebarSimpleCountLabel(item);
  const display = String(item?.displayCountLabel || "").trim();
  if (display) return display;
  if (item?.folderId === FOLDER_FILTER_NONE || item?.label === "Unfiled") {
    return `${String(item?.count || 0)} known here`;
  }
  if (item?.kind === "folder") {
    const nativeCount = Number(item?.nativeMembershipCount ?? item?.canonicalCount ?? item?.count ?? 0) || 0;
    const knownCount = Number(item?.knownStudioCount ?? item?.knownCount ?? 0) || 0;
    const parts = [`${nativeCount} native`, `${knownCount} known here`];
    if (Array.isArray(item?.badges) && item.badges.includes("count-mismatch")) parts.push("count-mismatch");
    return parts.join(" · ");
  }
  return String(countText || "").trim();
}

function folderSidebarSimpleCountLabel(item){
  if (!item) return "";
  const count = Number(item?.nativeMembershipCount ?? item?.canonicalCount ?? item?.count ?? item?.knownStudioCount ?? item?.knownCount ?? 0) || 0;
  return pluralize(count, "chat");
}

function renderFolderSidebarMoreLink(){
  const link = document.createElement("a");
  link.className = "wbSidebarSectionMore wbFolderSectionMore";
  link.href = "#/library/folders";
  link.dataset.h2oFolderMoreLink = "1";
  link.dataset.groupby = "folder";
  link.textContent = "More";
  link.title = "Open all folders";
  link.setAttribute("aria-label", "Open all folders");
  return link;
}

function updateFolderCountToggleButton(button){
  if (!button) return;
  const enabled = !!FOLDER_SIDEBAR_UI_STATE.showFolderCountPills;
  button.textContent = "#";
  button.title = enabled ? "Hide folder counts" : "Show folder counts";
  button.setAttribute("aria-pressed", String(enabled));
  button.setAttribute("aria-label", enabled ? "Hide folder counts" : "Show folder counts");
  button.style.background = enabled ? "rgba(59,130,246,.18)" : "rgba(255,255,255,.035)";
  button.style.borderColor = enabled ? "rgba(125,211,252,.35)" : "rgba(255,255,255,.12)";
  button.style.color = enabled ? "rgba(191,219,254,.95)" : "rgba(255,255,255,.62)";
}

function ensureFolderCountToggle(){
  const section = document.querySelector(".wbSidebarSection--folders");
  const label = section && section.querySelector(".wbSideLabel");
  if (!(section && label)) return null;
  let button = section.querySelector('[data-h2o-folder-count-toggle="1"]');
  if (button && button.parentElement !== section) section.insertBefore(button, label.nextSibling);
  if (!button) {
    section.style.position = "relative";
    label.style.paddingRight = "40px";
    button = document.createElement("button");
    button.className = "wbSidebarFolderCountToggle";
    button.type = "button";
    button.dataset.h2oFolderCountToggle = "1";
    button.style.cssText = "position:absolute;top:8px;right:8px;z-index:2;display:inline-flex;align-items:center;justify-content:center;width:22px;height:20px;padding:0;border:1px solid rgba(255,255,255,.12);border-radius:999px;background:rgba(255,255,255,.035);color:rgba(255,255,255,.62);font:700 11px/1 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;letter-spacing:0;text-transform:none;cursor:pointer";
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("keydown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      FOLDER_SIDEBAR_UI_STATE.showFolderCountPills = !FOLDER_SIDEBAR_UI_STATE.showFolderCountPills;
      updateFolderCountToggleButton(button);
      renderList();
    });
    section.insertBefore(button, label.nextSibling);
  }
  updateFolderCountToggleButton(button);
  return button;
}

function renderFolderSidebarRow(view, item, opts){
  const appearance = item.kind === "folder"
    ? W.H2O?.Library?.SidebarSections?.getRowAppearance?.({
      kind: "folders",
      id: item.folderId,
      folderId: item.folderId,
      name: item.label,
      color: item.iconColor || "",
      iconColor: item.iconColor || "",
      isCanonical: item.isCanonical === true,
    })
    : null;
  if (appearance?.hidden) return null;
  const displayLabel = String(appearance?.name || item.label || "").trim() || item.folderId || "";
  const isUnfiled = item.isUnfiled === true || item.folderId === FOLDER_FILTER_NONE || item.label === "Unfiled";
  const folderIconSvg = isUnfiled ? SIDEBAR_UNFILED_ICON_SVG : (appearance?.iconSvg || SIDEBAR_FOLDER_ICON_SVG);
  const link = document.createElement("a");
  link.className = "wbFolderItem";
  if (opts && opts.review) link.classList.add("wbFolderItem--review");
  if (isUnfiled) link.classList.add("wbFolderItem--unfiled");
  const operatorDetails = folderOperatorModeEnabled();
  const countText = operatorDetails
    ? (String(item.displayCountLabel || "").trim() || String(item.count || 0))
    : folderSidebarSimpleCountLabel(item);
  const hasDetailedCount = operatorDetails && !!String(item.displayCountLabel || "").trim();
  const compactCounts = !(opts && opts.review) && !FOLDER_SIDEBAR_UI_STATE.showFolderCountPills;
  const countDetails = folderSidebarCountDetails(item, countText);
  const countPillStyle = "display:block;box-sizing:border-box;min-width:0;max-width:108px;padding:1px 5px;font-size:10px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;align-self:center;";
  const rowTitle = countDetails ? `${displayLabel} — ${countDetails}` : displayLabel;
  if (!item.count && !hasDetailedCount) link.classList.add("is-empty");
  if (item.folderKind === "project_backed") link.classList.add("is-project-backed");
  // Honor item.href overrides so system utility rows can route outside the
  // default chat-list hash.
  link.href = item.href ? String(item.href) : buildListHash(view, item.folderId);
  link.title = rowTitle;
  link.setAttribute("aria-label", countDetails ? `${displayLabel}, ${countDetails}` : displayLabel);
  if (compactCounts) link.style.gridTemplateColumns = "16px minmax(0,1fr) 24px";
  link.dataset.folderId = String(item.folderId || "");
  if (isUnfiled) link.dataset.systemRow = "true";
  if (hasDetailedCount) link.dataset.countLabel = countText;
  link.dataset.countMode = compactCounts ? "compact" : "inline";
  if (Array.isArray(item.badges) && item.badges.length) link.dataset.badges = item.badges.join(",");
  if (item.canonicalCount != null) link.dataset.canonicalCount = String(item.canonicalCount);
  if (item.knownCount != null) link.dataset.knownCount = String(item.knownCount);
  if (item.localBindingCount != null) link.dataset.localBindingCount = String(item.localBindingCount);
  if (item.reviewBucket) link.dataset.reviewBucket = String(item.reviewBucket);
  const iconColor = normalizeSidebarIconColor(appearance?.color || item.iconColor || "");
  if (iconColor) {
    link.dataset.color = iconColor;
    link.style.setProperty("--wb-sidebar-item-color", iconColor);
  }
  const reviewBadgesHtml = opts && opts.review ? localReviewBadgesHtml(item) : "";
  const folderMenuHtml = item.kind === "folder" && !(opts && opts.review)
    ? `<button class="wbFolderMenuBtn" type="button" aria-label="More options for ${esc(displayLabel)}" aria-haspopup="menu" aria-expanded="false" title="More options for ${esc(displayLabel)}">...</button>`
    : `<span class="wbFolderMenuSlot" aria-hidden="true"></span>`;
  link.innerHTML = `
    <span class="wbFolderIcon" aria-hidden="true">${folderIconSvg}</span>
    <span class="wbFolderLabel"${reviewBadgesHtml ? ' style="display:flex;flex-direction:column;gap:0;min-width:0;white-space:normal;line-height:1.25"' : ""}>
      <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(displayLabel)}</span>
      ${reviewBadgesHtml}
    </span>
    ${compactCounts ? "" : `<span class="wbFolderCount${hasDetailedCount ? " wbFolderCount--folderParity" : ""}" title="${esc(countDetails || countText)}" aria-label="${esc(countDetails || countText)}" style="${countPillStyle}">${esc(countText)}</span>`}
    ${folderMenuHtml}
  `;
  const menuBtn = link.querySelector(".wbFolderMenuBtn");
  if (menuBtn) {
    menuBtn.addEventListener("pointerdown", (event) => event.stopPropagation());
    menuBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const api = W.H2O?.Library?.SidebarSections;
      if (typeof api?.openRowMenu === "function") {
        api.openRowMenu(menuBtn, {
          kind: "folders",
          id: item.folderId,
          folderId: item.folderId,
          name: displayLabel,
          count: item.count || 0,
          color: iconColor,
          iconKey: appearance?.icon || "folder",
          folderKind: item.folderKind || item.kind || "",
          isCanonical: item.isCanonical === true,
        });
      }
    });
  }
  return link;
}

function renderFolderSidebar(rows, view, selectedFolderId){
  const host = $("#folderList");
  if (!host) return;
  ensureFolderCountToggle();
  let items = collectFolderSidebarItems(rows, view, "canonical");
  const showLocalReview = folderLocalReviewUiEnabled();
  const reviewItems = showLocalReview ? collectFolderSidebarItems(rows, view, "review") : [];
  host.innerHTML = "";
  host.dataset.h2oFolderLocalReview = showLocalReview ? "operator" : "hidden";

  let folderEntries = items.filter((item) => item.kind === "folder");
  if (!folderEntries.length) {
    state.folderCatalog = normalizeFolderCatalog(makeKnownCanonicalFolderCatalogFallback("studio-sidebar-cache-fallback"));
    items = collectFolderSidebarItems(rows, view, "canonical");
    folderEntries = items.filter((item) => item.kind === "folder");
  }
  const reviewEntries = reviewItems.filter((item) => item.kind === "folder");
  if (items.length <= 1 && !folderEntries.length && !reviewEntries.length){
    host.innerHTML = `<div class="wbSideEmpty">Canonical folder catalog unavailable. Open chatgpt.com to broadcast folders.</div>`;
    setActiveFolder("");
    return;
  }

  const projectItems = items.filter((item) => item.kind === "folder" && item.folderKind === "project_backed");
  const localItems = items.filter((item) => item.kind === "folder" && item.folderKind !== "project_backed");
  const unfiledItems = items.filter((item) => item.isUnfiled === true || item.folderId === FOLDER_FILTER_NONE);
  const orderedItems = [...unfiledItems, ...projectItems, ...localItems];

  orderedItems.forEach((item) => {
    if (projectItems.length && localItems.length && item === localItems[0]){
      const divider = document.createElement("hr");
      divider.className = "wbFolderDivider";
      host.appendChild(divider);
    }
    const link = renderFolderSidebarRow(view, item, { review: false });
    if (link) host.appendChild(link);
  });

  host.appendChild(renderFolderSidebarMoreLink());

  if (reviewEntries.length > 0) {
    const persistKey = "h2o:prm:cgx:studio-sidebar:local-review:expanded:v1";
    let expandedPref = false;
    try { expandedPref = W.localStorage.getItem(persistKey) === "1"; } catch {}
    const details = document.createElement("details");
    details.className = "wbFolderLocalReview";
    details.open = expandedPref;
    const summary = document.createElement("summary");
    summary.className = "wbFolderLocalReviewSummary";
    summary.textContent = `Local Review · ${reviewEntries.length}`;
    summary.style.cssText = "cursor:pointer;padding:6px 10px;margin-top:6px;font-size:11px;color:rgba(255,255,255,.5);letter-spacing:.04em;text-transform:uppercase;border-top:1px solid rgba(255,255,255,.06)";
    details.appendChild(summary);
    const explanation = document.createElement("div");
    explanation.className = "wbFolderLocalReviewExplanation";
    explanation.textContent = FOLDER_LOCAL_REVIEW_EXPLANATION;
    explanation.style.cssText = "padding:0 10px 4px;color:rgba(255,255,255,.56);font-size:10.5px;line-height:1.35";
    details.appendChild(explanation);
    const reviewHost = document.createElement("div");
    reviewHost.className = "wbFolderLocalReviewList";
    reviewHost.style.cssText = "opacity:0.84;padding-top:4px";
    reviewEntries.forEach((item) => {
      const link = renderFolderSidebarRow(view, item, { review: true });
      if (link) reviewHost.appendChild(link);
    });
    details.appendChild(reviewHost);
    details.addEventListener("toggle", () => {
      try { W.localStorage.setItem(persistKey, details.open ? "1" : "0"); } catch {}
    });
    host.appendChild(details);
  }

  setActiveFolder(selectedFolderId);
}

function getActiveSnapshotId(){
  return String(state.currentReaderSnapshot?.snapshotId || state.selectedSnapshotId || "").trim();
}

function setActiveSidebarChat(snapshotId = ""){
  const activeSnapshotId = String(snapshotId || getActiveSnapshotId()).trim();
  $$(".wbSidebarChatItem[data-snapshot-id]").forEach((node) => {
    node.classList.toggle("active", String(node.dataset.snapshotId || "").trim() === activeSnapshotId);
  });
}

function setSidebarChatLoading(view, folderId = ""){
  const host = $("#sidebarChatList");
  const labelEl = $("#sidebarChatsLabel");
  const metaEl = $("#sidebarChatsMeta");
  if (!(host && labelEl && metaEl)) return;

  const folderLabel = folderId === FOLDER_FILTER_NONE
    ? "Unfiled"
    : (folderId ? resolveFolderName(folderId) : "");
  labelEl.textContent = "Recents";
  labelEl.title = folderLabel ? `Recent chats in ${folderLabel}` : "Recent chats";
  metaEl.textContent = "Loading…";
  host.innerHTML = `<div class="wbSideEmpty">Loading recents…</div>`;
}

function collectCanonicalSidebarRecentChats(rows, folderId = "", query = ""){
  const q = normalizeText(query).toLowerCase();
  const sourceIsCanonical = hasLibraryIndexRowsApi();
  const canonicalRows = sourceIsCanonical ? canonicalSavedRecentLibraryIndexRows(200) : [];
  const fromIndex = projectRecentLibraryRowsToWorkbenchRows(canonicalRows);
  const fallback = Array.isArray(rows) && rows.length
    ? rows
    : (Array.isArray(state.rowsCache) ? state.rowsCache : []);
  const source = sourceIsCanonical ? fromIndex : fallback;
  const filtered = source.filter((row) => {
    if (!row || row.deleted || row.isDeleted || row.tombstoned) return false;
    if (!libraryRowIsSavedTranscript(row)) return false;
    if (!matchesFolder(row, folderId)) return false;
    if (state.lastTagFilter && !(Array.isArray(row.tags) ? row.tags : []).includes(state.lastTagFilter)) return false;
    if (!q) return true;
    const labels = row?.labels || {};
    const haystack = [
      row.title,
      row.excerpt,
      row.chatId,
      row.folderId,
      row.folderName,
      row.originSource,
      row?.category?.primaryCategoryId,
      row?.category?.secondaryCategoryId,
      ...labelSearchTokens(labels),
      ...(row.tags || []),
      ...(row.keywords || []),
    ].join(" ").toLowerCase();
    return haystack.includes(q);
  });
  if (sourceIsCanonical) return filtered;
  const core = W.H2O?.Library?.LibraryIndexCore || null;
  if (core && typeof core.canonicalSortRows === "function") return core.canonicalSortRows(filtered, "recent", "savedRecent");
  return filtered.sort((a, b) => {
    const dateCompare = stableSavedRecentRowTime(b) - stableSavedRecentRowTime(a);
    const titleCompare = String(a.title || "").localeCompare(String(b.title || ""));
    const idCompare = String(a.chatId || a.id || "").localeCompare(String(b.chatId || b.id || ""));
    return dateCompare || titleCompare || idCompare;
  });
}

function renderSidebarChatList(rows, view, folderId = "", query = ""){
  const host = $("#sidebarChatList");
  const labelEl = $("#sidebarChatsLabel");
  const metaEl = $("#sidebarChatsMeta");
  if (!(host && labelEl && metaEl)) return;

  const folderLabel = folderId === FOLDER_FILTER_NONE
    ? "Unfiled"
    : (folderId ? resolveFolderName(folderId) : "");
  labelEl.textContent = "Recents";
  labelEl.title = folderLabel ? `Recent chats in ${folderLabel}` : "Recent chats";
  const list = collectCanonicalSidebarRecentChats(rows, folderId, query);
  metaEl.textContent = [
    pluralize(list.length, "chat"),
    folderLabel ? folderLabel : "",
    query ? "Filtered" : "",
  ].filter(Boolean).join(" · ");

  host.innerHTML = "";
  if (!list.length){
    host.innerHTML = `<div class="wbSideEmpty">No recent chats match this section.</div>`;
    setActiveSidebarChat("");
    return;
  }

  const activeSnapshotId = getActiveSnapshotId();
  const frag = document.createDocumentFragment();
  list.slice(0, 30).forEach((row) => {
    const readerSnapshotId = rowReaderSnapshotId(row);
    const isSavedTranscript = libraryRowIsSavedTranscript(row);
    const isLinkOnly = rowIsLinkOnly(row);
    const link = document.createElement("a");
    link.className = "wbSidebarChatItem";
    if (readerSnapshotId) {
      link.href = `#/read/${encodeURIComponent(readerSnapshotId)}`;
    } else {
      link.href = buildListHash("linked", state.lastFolderId || "");
      link.classList.add("wbSidebarChatItem--linked");
    }
    link.dataset.snapshotId = String(readerSnapshotId || "");
    link.dataset.chatId = row.chatId;
    link.dataset.view = String(row.view || "");
    link.dataset.saved = isSavedTranscript ? "1" : "0";
    link.dataset.linked = isLinkOnly ? "1" : "0";
    link.dataset.archived = (row.archived || row.isArchived) ? "1" : "0";
    link.dataset.deleted = (row.deleted || row.isDeleted || row.tombstoned) ? "1" : "0";
    link.dataset.opens = readerSnapshotId && !isLinkOnly ? "reader" : "placeholder-details";
    if (readerSnapshotId && readerSnapshotId === activeSnapshotId) link.classList.add("active");

    const meta = rowMetaParts(row).join(" · ");

    link.innerHTML = `
      <span class="wbSidebarChatTitle">${esc(row.title)}</span>
      <span class="wbSidebarChatMeta">${esc(meta)}</span>
    `;

    frag.appendChild(link);
  });

  host.appendChild(frag);
  setActiveSidebarChat(activeSnapshotId);
}

function refreshSidebarChatList(view = state.lastView, folderId = state.lastFolderId){
  const query = $("#q")?.value || "";
  const rows = filterRows(state.rowsCache || [], view, query, folderId, state.lastTagFilter);
  renderSidebarChatList(rows, view, folderId, query);
}

function updateRowFolderBinding(chatId, folderData){
  const id = String(chatId || "").trim();
  if (!id) return;
  const binding = normalizeFolderBinding(folderData);
  state.folderBindingsByChat[id] = binding;

  if (Array.isArray(state.rowsCache)){
    state.rowsCache = state.rowsCache.map((row) => {
      if (row.chatId !== id) return row;
      return {
        ...row,
        folderId: binding.folderId,
        folderName: binding.folderId
          ? (binding.folderName || resolveFolderName(binding.folderId) || binding.folderId)
          : "",
      };
    });
  }

  if (state.currentReaderSnapshot?.chatId === id) {
    const meta = state.currentReaderSnapshot.meta && typeof state.currentReaderSnapshot.meta === "object"
      ? state.currentReaderSnapshot.meta
      : {};
    state.currentReaderSnapshot.meta = {
      ...meta,
      folderId: binding.folderId,
      folderName: binding.folderId
        ? (binding.folderName || resolveFolderName(binding.folderId) || binding.folderId)
        : "",
    };
  }
}

function renderFolderAssignmentControl(){
  const wrap = $("#folderAssignWrap");
  const select = $("#folderAssignSelect");
  if (!(wrap && select)) return;

  const selectedChatId = String(state.selectedChatId || state.currentReaderSnapshot?.chatId || "").trim();
  // P8a contract §2: assignment dropdown shows canonical folders only.
  // Local Review extras are inspect-only; existing non-canonical bindings are
  // preserved because the writer only fires on user-driven select change.
  const catalog = Array.isArray(state.folderCatalog) ? state.folderCatalog : [];
  const currentFolderId = getSelectedFolderId();

  if (!selectedChatId || (!catalog.length && !currentFolderId)) {
    wrap.hidden = true;
    select.innerHTML = "";
    return;
  }

  const options = [{ value: "", label: "Unfiled" }, ...catalog.map((item) => ({
    value: String(item.id || ""),
    label: String(item.name || item.id || ""),
  }))];

  select.innerHTML = options.map((item) => (
    `<option value="${esc(item.value)}">${esc(item.label)}</option>`
  )).join("");

  const hasCurrent = options.some((item) => item.value === currentFolderId);
  select.value = hasCurrent ? currentFolderId : "";
  wrap.hidden = false;
}

function getSelectedWorkbenchRow(){
  const sid = String(state.selectedSnapshotId || state.currentReaderSnapshot?.snapshotId || "").trim();
  if (!sid || !Array.isArray(state.rowsCache)) return null;
  return state.rowsCache.find((row) => String(row?.snapshotId || "").trim() === sid) || null;
}

function syncSelectionControls(){
  renderFolderAssignmentControl();
  renderCategoryInspector();
}

function selectRow(row, articleEl){
  state.selectedSnapshotId = String(row?.snapshotId || "").trim();
  state.selectedChatId = String(row?.chatId || "").trim();

  $$(".wbHistoryRow.is-selected").forEach((node) => node.classList.remove("is-selected"));
  if (articleEl) articleEl.classList.add("is-selected");
  setActiveSidebarChat(state.selectedSnapshotId);
  syncSelectionControls();
}

function rowMetaParts(row){
  const folder = String(row?.folderName || row?.folderId || "Unfiled").trim();
  const answers = pluralize(toWholeCount(row?.answerCount, 0), "answer");
  const created = fmtDateMeta(row?.originalCreatedAt);
  const added = fmtDateMeta(row?.studioAddedAt || row?.createdAt);
  const lastTurn = fmtDateMeta(row?.lastTurnAt || row?.updatedAt);
  return [
    folder,
    answers,
    created ? `Created ${created}` : "Created unknown",
    added ? `Added ${added}` : "Added to Studio",
    lastTurn ? `Last turn ${lastTurn}` : "Last turn unknown",
  ];
}

function heatLabel(level){
  const normalized = normalizeHeatLevel(level);
  if (normalized === "hot") return "Hot";
  if (normalized === "warm") return "Warm";
  if (normalized === "off") return "Off";
  return "Auto";
}

function closeRowPopovers(exceptEl = null){
  $$(".wbRowPopover").forEach((node) => {
    if (exceptEl && node === exceptEl) return;
    node.remove();
  });
  if (!exceptEl) {
    try { W.H2O?.StudioAutoEmojiTitle?.closePalette?.(); } catch {}
  }
  if (!exceptEl && titlePaletteEl) {
    titlePaletteEl.remove();
    titlePaletteEl = null;
  }
  $$(".wbRowTools [aria-expanded='true']").forEach((node) => {
    node.setAttribute("aria-expanded", "false");
  });
}

function updateCachedRow(chatId, patch){
  const id = String(chatId || "").trim();
  if (!id || !Array.isArray(state.rowsCache)) return null;
  let updated = null;
  state.rowsCache = state.rowsCache.map((row) => {
    if (row.chatId !== id) return row;
    updated = { ...row, ...(patch || {}) };
    updated.heatLevel = computeHeatLevel(updated);
    return updated;
  });
  return updated;
}

async function persistInterfaceMetaPatch(chatId, patch, reason = "studio-interface-meta"){
  const id = String(chatId || "").trim();
  if (!id) return {};
  const existing = state.interfaceMetaByChat[id] && typeof state.interfaceMetaByChat[id] === "object"
    ? state.interfaceMetaByChat[id]
    : {};
  const next = {
    ...existing,
    ...(patch && typeof patch === "object" ? patch : {}),
    chatId: id,
    updatedAt: Date.now(),
  };
  state.interfaceMetaByChat[id] = next;
  await writeSharedRecord(`${INTERFACE_META_MIRROR_KEY_PREFIX}${id}`, next);
  broadcastStudioMeta(reason, { chatId: id, meta: next });
  return next;
}

async function persistHeatOverride(chatId, level){
  const id = String(chatId || "").trim();
  const next = normalizeHeatLevel(level);
  if (!id) return;
  const key = `${HEAT_OVERRIDE_KEY_PREFIX}${id}`;
  try {
    if (next === "auto") localStorage.removeItem(key);
    else localStorage.setItem(key, next);
  } catch {}
  if (next === "auto") await chromeStorageRemove([key]).catch(() => false);
  else await chromeStorageSet({ [key]: next }).catch(() => false);
  await persistInterfaceMetaPatch(id, { heatOverride: next }, "studio-heat-override");
}

async function persistPin(chatId, pinned){
  const id = String(chatId || "").trim();
  if (!id) return;
  const key = `${PIN_KEY_PREFIX}${id}`;
  try {
    if (pinned) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {}
  if (pinned) await chromeStorageSet({ [key]: "1" }).catch(() => false);
  else await chromeStorageRemove([key]).catch(() => false);
  await persistInterfaceMetaPatch(id, { pinned: !!pinned }, "studio-pin");
}

async function persistRowTint(chatId, idx){
  const id = String(chatId || "").trim();
  const next = toRowTintIndex(idx, -1);
  if (!id) return;
  const key = `${ROW_TINT_KEY_PREFIX}${id}`;
  try {
    if (next < 0) localStorage.removeItem(key);
    else localStorage.setItem(key, String(next));
  } catch {}
  if (next < 0) await chromeStorageRemove([key]).catch(() => false);
  else await chromeStorageSet({ [key]: String(next) }).catch(() => false);
  await persistInterfaceMetaPatch(id, { rowTint: next }, "studio-row-tint");
}

async function persistChatTitleState(row, emoji){
  const chatId = String(row?.chatId || "").trim();
  if (!chatId) return null;
  const split = splitTitleEmoji(row?.titleState?.baseTitle || row?.title || "");
  const baseTitle = String(row?.titleState?.baseTitle || split.baseTitle || row?.title || chatId).trim();
  const nextEmoji = String(emoji || "").trim();
  const now = Date.now();
  const payload = {
    version: "1.0.0",
    chatId,
    baseTitle,
    source: "studio-title-palette",
    priority: 100,
    confidence: 1,
    emoji: nextEmoji,
    emojiSource: "user-picker-native-rename",
    emojiPriority: 100,
    emojiConfidence: 1,
    updatedAt: now,
    emojiUpdatedAt: now,
  };
  const displayTitle = displayTitleWithEmoji(baseTitle, nextEmoji);
  const titleState = { ...payload, displayTitle };
  await writeSharedRecord(`${CHAT_TITLE_STATE_KEY_PREFIX}${chatId}`, payload);
  state.titleStateByChat[chatId] = titleState;
  broadcastStudioMeta("studio-title-palette", { chatId, titleState });
  return titleState;
}

function syncRowTools(article, row){
  if (!article || !row) return;
  const heatLevel = row.heatLevel || computeHeatLevel(row);
  article.dataset.heatLevel = heatLevel;
  article.classList.toggle("is-pinned", !!row.pinned);
  INTERFACE_COLORS.forEach((color) => article.classList.remove(`wb-row-${color.name}`));
  const rowTint = toRowTintIndex(row?.rowTint, -1);
  if (rowTint >= 0) article.classList.add(`wb-row-${INTERFACE_COLORS[rowTint].name}`);

  const pinBtn = article.querySelector(".wbRowIconBtn--pin");
  if (pinBtn){
    pinBtn.classList.toggle("is-on", !!row.pinned);
    pinBtn.setAttribute("aria-pressed", row.pinned ? "true" : "false");
    pinBtn.setAttribute("title", row.pinned ? "Unpin chat" : "Pin chat");
  }

  const heatBtn = article.querySelector(".wbHeatPill");
  if (heatBtn){
    heatBtn.className = `wbHeatPill wbHeatPill--${heatLevel}`;
    heatBtn.textContent = "";
    heatBtn.setAttribute("aria-label", `Heat: ${heatLabel(heatLevel)}`);
    heatBtn.setAttribute("title", `Heat: ${heatLabel(heatLevel)}`);
  }
}

function buildInfoPopover(row){
  const meta = row?.interfaceMeta && typeof row.interfaceMeta === "object" ? row.interfaceMeta : {};
  const items = [
    ["Created in ChatGPT", fmtDateMeta(row?.originalCreatedAt) || "Unknown"],
    ["Answers", String(toWholeCount(row?.answerCount, 0))],
    ["Folder", String(row?.folderName || row?.folderId || "Unfiled")],
    ["Added to Studio", fmtDateMeta(row?.studioAddedAt || row?.createdAt) || "Unknown"],
    ["Heat", heatLabel(row?.heatLevel || computeHeatLevel(row))],
    ["Pinned", row?.pinned ? "Yes" : "No"],
  ];
  const preview = [
    meta.firstQ ? `<div class="wbRowPopoverPreview"><b>First Q</b><span>${esc(meta.firstQ)}</span></div>` : "",
    meta.lastA ? `<div class="wbRowPopoverPreview"><b>Last A</b><span>${esc(meta.lastA)}</span></div>` : "",
  ].filter(Boolean).join("");
  return `
    <div class="wbRowPopoverHead">
      <div class="wbRowPopoverTitle">${esc(row?.title || "Chat info")}</div>
    </div>
    <div class="wbRowPopoverGrid">
      ${items.map(([label, value]) => `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("")}
    </div>
    ${preview}
  `;
}

function openInfoPopover(row, article, anchor){
  closeRowPopovers();
  const pop = document.createElement("div");
  pop.className = "wbRowPopover wbRowPopover--info";
  pop.setAttribute("role", "dialog");
  pop.innerHTML = buildInfoPopover(row);
  article.appendChild(pop);
  anchor?.setAttribute("aria-expanded", "true");
}

function stopPaletteEvent(ev){
  ev?.preventDefault?.();
  ev?.stopPropagation?.();
}

function refreshTitlePaletteMeta(palette, row){
  if (!palette || !row) return;
  const heat = normalizeHeatLevel(row.heatOverride);
  const rowTint = toRowTintIndex(row.rowTint, -1);
  palette.querySelectorAll(".ho-swatch.heat").forEach((sw) => {
    sw.classList.toggle("ho-meta-selected", sw.dataset.level === heat);
  });
  palette.querySelectorAll(".ho-swatch.row").forEach((sw) => {
    sw.classList.toggle("ho-meta-selected", Number(sw.dataset.idx) === rowTint);
  });
}

function applyTitlePaletteMetaChoice(target, row, article, palette){
  if (!target || !row) return;
  const mode = String(target.dataset.mode || "");
  if (mode === "heat") {
    const nextOverride = normalizeHeatLevel(target.dataset.level || "auto");
    row.interfaceMeta = {
      ...(row.interfaceMeta && typeof row.interfaceMeta === "object" ? row.interfaceMeta : {}),
      heatOverride: nextOverride,
    };
    row.heatOverride = nextOverride;
    row.heatLevel = computeHeatLevel(row);
    updateCachedRow(row.chatId, {
      interfaceMeta: row.interfaceMeta,
      heatOverride: nextOverride,
      heatLevel: row.heatLevel,
    });
    syncRowTools(article, row);
    refreshTitlePaletteMeta(palette, row);
    persistHeatOverride(row.chatId, nextOverride).catch(console.warn);
    return;
  }

  if (mode === "row") {
    const idx = Number.parseInt(target.dataset.idx || "-1", 10);
    const current = toRowTintIndex(row.rowTint, -1);
    const next = current === idx ? -1 : toRowTintIndex(idx, -1);
    row.interfaceMeta = {
      ...(row.interfaceMeta && typeof row.interfaceMeta === "object" ? row.interfaceMeta : {}),
      rowTint: next,
    };
    row.rowTint = next;
    updateCachedRow(row.chatId, { interfaceMeta: row.interfaceMeta, rowTint: next });
    syncRowTools(article, row);
    refreshTitlePaletteMeta(palette, row);
    persistRowTint(row.chatId, next).catch(console.warn);
  }
}

function buildTitleMetaPalette(row, article){
  const palette = document.createElement("div");
  palette.className = "ho-palette ho-emoji-meta-palette show";
  palette.dataset.chatid = row.chatId;

  const heatRow = document.createElement("div");
  heatRow.className = "ho-palette-row ho-emoji-heat-row";
  [
    ["auto", "A"],
    ["hot", "H"],
    ["warm", "W"],
    ["off", "O"],
  ].forEach(([level, label]) => {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "ho-swatch heat";
    sw.textContent = label;
    sw.title = `Heat: ${level}`;
    sw.setAttribute("aria-label", `Heat: ${level}`);
    sw.dataset.mode = "heat";
    sw.dataset.level = level;
    heatRow.appendChild(sw);
  });

  const divider = document.createElement("span");
  divider.className = "ho-emoji-meta-divider";
  divider.setAttribute("aria-hidden", "true");

  const rowRow = document.createElement("div");
  rowRow.className = "ho-palette-row ho-emoji-row-tint-row";
  INTERFACE_COLORS.forEach((color, idx) => {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "ho-swatch row";
    sw.style.backgroundColor = String(color.value || "").replace(/,1\)/, ",0.5)");
    sw.title = `Row: ${color.name}`;
    sw.setAttribute("aria-label", `Row: ${color.name}`);
    sw.dataset.mode = "row";
    sw.dataset.idx = String(idx);
    rowRow.appendChild(sw);
  });

  let choosingMeta = false;
  const chooseMeta = (ev) => {
    const sw = ev.target?.closest?.(".ho-swatch");
    if (!sw) return;
    stopPaletteEvent(ev);
    if (choosingMeta) return;
    choosingMeta = true;
    applyTitlePaletteMetaChoice(sw, row, article, palette);
    setTimeout(() => { choosingMeta = false; }, 120);
  };
  palette.addEventListener("pointerdown", chooseMeta, true);
  palette.addEventListener("mousedown", chooseMeta, true);
  palette.addEventListener("click", chooseMeta, true);
  palette.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    chooseMeta(ev);
  }, true);

  palette.appendChild(heatRow);
  palette.appendChild(divider);
  palette.appendChild(rowRow);
  refreshTitlePaletteMeta(palette, row);
  return palette;
}

function renderTitlePaletteSections(grid, sections, selectedEmoji, selectEmoji){
  grid.innerHTML = "";
  const seen = new Set();
  for (const section of sections){
    const list = Array.from(new Set(section.emojis || [])).filter((emoji) => emoji && !seen.has(emoji));
    if (!list.length) continue;

    const wrap = document.createElement("section");
    wrap.className = "ho-emoji-section";

    const label = document.createElement("div");
    label.className = "ho-emoji-section-title";
    label.textContent = section.label || "Icons";

    const cells = document.createElement("div");
    cells.className = "ho-emoji-section-grid";

    list.forEach((emoji) => {
      seen.add(emoji);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ho-emoji-btn";
      if (selectedEmoji && emoji === selectedEmoji) b.classList.add("ho-emoji-selected");
      b.textContent = emoji;
      b.setAttribute("aria-label", `Use ${emoji}`);
      b.addEventListener("pointerdown", (ev) => selectEmoji(emoji, ev), true);
      b.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        selectEmoji(emoji, ev);
      }, true);
      cells.appendChild(b);
    });

    wrap.appendChild(label);
    wrap.appendChild(cells);
    grid.appendChild(wrap);
  }
}

function searchEmojiSections(query){
  const q = String(query || "").trim().toLowerCase();
  if (!q) return STUDIO_EMOJI_GROUPS;
  const sections = STUDIO_EMOJI_GROUPS.map((section) => {
    const label = String(section.label || "").toLowerCase();
    const emojis = (section.emojis || []).filter((emoji) => String(emoji || "").includes(q));
    if (label.includes(q) || q.includes(label.split(" ")[0])) return { label: section.label, emojis: section.emojis };
    return { label: section.label, emojis };
  }).filter((section) => section.emojis && section.emojis.length);
  if (sections.length) return sections;
  return [{ label: "Results", emojis: STUDIO_EMOJI_POOL.slice(0, 96) }];
}

function openTitlePalette(row, article, anchor){
  const paletteApi = W.H2O?.StudioAutoEmojiTitle;
  if (paletteApi && typeof paletteApi.openPalette === "function") {
    closeRowPopovers();
    paletteApi.openPalette({
      row,
      article,
      anchor,
      callbacks: {
        persistTitleState: persistChatTitleState,
        applyTitleState(titleState){
          if (!titleState) return;
          row.titleState = titleState;
          row.title = titleState.displayTitle || composeTitleFromState(titleState, row.title);
          updateCachedRow(row.chatId, { title: row.title, titleState });
          const titleEl = article?.querySelector?.(".wbTitle");
          if (titleEl) titleEl.textContent = row.title;
          refreshSidebarChatList();
        },
        applyMetaChoice(target, palette){
          applyTitlePaletteMetaChoice(target, row, article, palette);
        },
      },
    });
    return;
  }

  closeRowPopovers();
  const gutter = 12;
  const pickerWidth = Math.min(398, Math.max(292, window.innerWidth - (gutter * 2)));
  const pickerHeight = Math.min(462, Math.max(300, window.innerHeight - (gutter * 2)));
  const rect = anchor?.getBoundingClientRect?.() || article?.getBoundingClientRect?.() || { left: gutter, bottom: gutter };
  const left = Math.max(gutter, Math.min(rect.right - pickerWidth, window.innerWidth - pickerWidth - gutter));
  const top = Math.max(gutter, Math.min(rect.bottom + 8, window.innerHeight - pickerHeight - gutter));
  const split = splitTitleEmoji(row?.titleState?.displayTitle || row?.title || "");
  const selectedEmoji = String(row?.titleState?.emoji || split.emoji || "").trim();

  const picker = document.createElement("div");
  titlePaletteEl = picker;
  picker.className = "ho-emoji-picker";
  picker.setAttribute("data-cgxui-owner", "auto-title-palette");
  picker.setAttribute("data-h2o-glass", "panel");
  picker.setAttribute("data-h2o-skin-surface", "sand-glass");
  picker.style.setProperty("--ho-picker-w", `${pickerWidth}px`);
  picker.style.setProperty("--ho-picker-max-h", `${pickerHeight}px`);
  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;

  const topbar = document.createElement("div");
  topbar.className = "ho-emoji-picker-top";

  const title = document.createElement("div");
  title.className = "ho-emoji-picker-title";
  const icon = document.createElement("span");
  icon.className = "ho-title-panel-icon";
  icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 7.5h8.75a3.25 3.25 0 0 1 0 6.5H9.2"/><path d="M6.5 7.5 4 5m2.5 2.5L4 10"/><path d="M17.5 16.5 20 19m-2.5-2.5L20 14"/><path d="M8 14.25h5.6"/></svg>';
  icon.setAttribute("aria-hidden", "true");
  const titleText = document.createElement("span");
  titleText.textContent = "Title Palette";
  title.appendChild(icon);
  title.appendChild(titleText);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "ho-emoji-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close emoji picker");
  close.addEventListener("pointerdown", (ev) => {
    stopPaletteEvent(ev);
    closeRowPopovers();
  }, true);

  topbar.appendChild(title);
  topbar.appendChild(close);

  const input = document.createElement("input");
  input.placeholder = "Search emoji, symbols, food, travel, flags";
  input.setAttribute("aria-label", "Search emoji");

  const search = document.createElement("div");
  search.className = "ho-emoji-search";
  search.appendChild(input);

  const grid = document.createElement("div");
  grid.className = "ho-emoji-grid";

  const metaPalette = buildTitleMetaPalette(row, article);

  const selectEmoji = (emoji, ev) => {
    stopPaletteEvent(ev);
    persistChatTitleState(row, emoji).then((titleState) => {
      if (!titleState) return;
      row.titleState = titleState;
      row.title = titleState.displayTitle || composeTitleFromState(titleState, row.title);
      updateCachedRow(row.chatId, { title: row.title, titleState });
      const titleEl = article.querySelector(".wbTitle");
      if (titleEl) titleEl.textContent = row.title;
      closeRowPopovers();
    }).catch(console.warn);
  };

  renderTitlePaletteSections(grid, STUDIO_EMOJI_GROUPS, selectedEmoji, selectEmoji);
  input.addEventListener("input", () => {
    renderTitlePaletteSections(grid, searchEmojiSections(input.value), selectedEmoji, selectEmoji);
  });

  picker.addEventListener("pointerdown", (ev) => ev.stopPropagation(), true);
  picker.addEventListener("click", (ev) => ev.stopPropagation(), true);
  picker.appendChild(topbar);
  picker.appendChild(search);
  if (metaPalette) picker.appendChild(metaPalette);
  picker.appendChild(grid);
  document.body.appendChild(picker);
  anchor?.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => input.focus());
}

/* Native Save-to-Folder + linked-row open-target resolution.
 * Prefers the shared LibraryIndexCore resolver (strict order:
 * normalizedHref -> href -> linkSourceHref -> /c/<chatId>; never folderId);
 * falls back to an inline equivalent so the open path works even before
 * the core mirror (S0F0d) has loaded. */
function resolveRowOpenTarget(row){
  const core = W.H2O && W.H2O.Library && W.H2O.Library.LibraryIndexCore;
  if (core && typeof core.resolveRowOpenTarget === "function") {
    try { const t = core.resolveRowOpenTarget(row); if (t) return String(t); } catch (_) { /* fall through */ }
  }
  if (!row || typeof row !== "object") return "";
  const norm = String(row.normalizedHref || "").trim();
  if (norm) return norm;
  const href = String(row.href || "").trim();
  if (href) return href;
  const linkSrc = String(row.linkSourceHref || "").trim();
  if (linkSrc) return linkSrc;
  const chatId = String(row.chatId || "").trim();
  if (chatId && !/^imported[-_:]/i.test(chatId)) return "/c/" + encodeURIComponent(chatId);
  return "";
}

function rowReaderSnapshotId(row){
  if (!row || typeof row !== "object") return "";
  const meta = row.meta && typeof row.meta === "object" ? row.meta : {};
  return String(
    row.snapshotId || row.lastSnapshotId || row.latestSnapshotId || row.snapshot_id
    || meta.snapshotId || meta.lastSnapshotId || meta.latestSnapshotId || meta.snapshot_id || ""
  ).trim();
}

function rowHasReaderSnapshot(row){
  return !!rowReaderSnapshotId(row);
}

/* True when a row should open its original ChatGPT chat (a live link)
 * rather than a captured snapshot reader. Saved+linked rows are common after
 * native Save-to-Folder; once they have a reader snapshot, saved state wins. */
function rowIsLinkOnly(row){
  const core = W.H2O && W.H2O.Library && W.H2O.Library.LibraryIndexCore;
  if (core && typeof core.rowIsLinkOnly === "function") {
    try {
      const coreDecision = !!core.rowIsLinkOnly(row);
      return rowHasReaderSnapshot(row) ? false : coreDecision;
    } catch (_) { /* fall through */ }
  }
  if (!row || typeof row !== "object") return false;
  if (rowHasReaderSnapshot(row)) return false;
  if (String(row.view || "").toLowerCase() === "linked") return true;
  if (row.state && typeof row.state === "object" && row.state.isLinked === true) return true;
  if (row.isLinked === true) return true;
  return !!resolveRowOpenTarget(row);
}

/* Convert a resolved open target to an absolute chatgpt.com URL, then
 * open it via platform.openUrl (Tauri shell|open / MV3 in-tab) with a
 * window.open fallback. Mirrors S0F1j.sourceUrlFromTarget origin logic
 * so relative /c/<id> targets always resolve against chatgpt.com and
 * never against the Studio origin. Returns true when an open was
 * dispatched. NEVER uses folderId. */
function openRowOriginalChat(row, setStatus){
  const target = resolveRowOpenTarget(row);
  if (!target) { if (typeof setStatus === "function") setStatus("No original chat URL available."); return false; }
  let url = String(target);
  if (/^https?:\/\//i.test(url)) { /* already absolute */ }
  else if (url.startsWith("/")) url = "https://chatgpt.com" + url;
  else if (/^c\//i.test(url)) url = "https://chatgpt.com/" + url;
  else url = "https://chatgpt.com/" + url;
  if (typeof setStatus === "function") setStatus("Opening original...");
  const platform = (W.H2O && W.H2O.Studio && W.H2O.Studio.platform) || null;
  if (platform && typeof platform.openUrl === "function") {
    Promise.resolve(platform.openUrl(url))
      .then(() => { if (typeof setStatus === "function") setStatus(""); })
      .catch((err) => { if (typeof setStatus === "function") setStatus("Open failed: " + String((err && (err.message || err)) || err)); });
    return true;
  }
  try { window.open(url, "_blank", "noopener"); if (typeof setStatus === "function") setStatus(""); return true; }
  catch (err) { if (typeof setStatus === "function") setStatus("Open failed: " + String(err)); return false; }
}

function renderRow(row, isSelected = false, activeView = "", activeFolderId = ""){
  const article = document.createElement("article");
  article.className = "wbHistoryRow";
  /* Phase K-1 — linked rows have no snapshotId. Use "" rather than
   * the string "undefined" so downstream lookups stay clean. */
  const rowIsLinked = String(row?.view || "").toLowerCase() === "linked";
  article.dataset.snapshotId = String(row.snapshotId || "");
  article.dataset.chatId = row.chatId;
  if (rowIsLinked) article.classList.add("wbHistoryRow--linked");
  if (isSelected) article.classList.add("is-selected");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "wbRowMain";

  const suppressArchive = (activeView === "archive");

  const sourceLabel = row.originSource === "mobile"
    ? "Mobile"
    : (row.originSource === "browser" ? "Browser" : "");
  const visibleTags = Array.isArray(row.tags) ? row.tags.slice(0, 2) : [];
  const hiddenTagCount = Math.max(0, (Array.isArray(row.tags) ? row.tags.length : 0) - visibleTags.length);
  const badgeHtml = [
    (row.archived && !suppressArchive) ? `<span class="wbBadge wbBadge--archive">Archived</span>` : "",
    sourceLabel ? `<span class="wbBadge wbBadge--source">${esc(sourceLabel)}</span>` : "",
    ...visibleTags.map((tag) => `<span class="wbBadge wbBadge--tag" data-tag="${esc(tag)}" role="button" tabindex="0" aria-label="Filter by tag: ${esc(tag)}">${esc(tag)}</span>`),
    hiddenTagCount > 0 ? `<span class="wbBadge wbBadge--tag-more">+${hiddenTagCount}</span>` : "",
  ].filter(Boolean).join("");
  const metaParts = rowMetaParts(row);
  const heatLevel = row.heatLevel || computeHeatLevel(row);

  button.innerHTML = `
    <div class="wbRowTitleLine">
      <div class="wbTitle">${esc(row.title)}</div>
    </div>
    <div class="wbMeta">
      ${metaParts.map((part) => `<span>${esc(part)}</span>`).join("")}
    </div>
  `;

  const tools = document.createElement("div");
  tools.className = "wbRowTools";
  tools.innerHTML = `
    <button type="button" class="wbRowIconBtn wbRowIconBtn--info" aria-label="Show chat info" aria-expanded="false" title="Chat info">${INFO_ICON_HTML}</button>
    <button type="button" class="wbRowIconBtn wbRowIconBtn--pin${row.pinned ? " is-on" : ""}" aria-label="${row.pinned ? "Unpin chat" : "Pin chat"}" aria-pressed="${row.pinned ? "true" : "false"}" title="${row.pinned ? "Unpin chat" : "Pin chat"}">${PIN_ICON_HTML}</button>
    <button type="button" class="wbHeatPill wbHeatPill--${esc(heatLevel)}" aria-label="Heat: ${esc(heatLabel(heatLevel))}" aria-expanded="false" title="Heat: ${esc(heatLabel(heatLevel))}"></button>
  `;

  // Delete button uses the same compact icon rail as the native row controls.
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "wbDeleteBtn";
  deleteBtn.setAttribute("aria-label", "Delete this chat from Studio");
  deleteBtn.setAttribute("title", "Delete from Studio");
  deleteBtn.innerHTML = DELETE_ICON_HTML;

  deleteBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (deleteConfirm.chatId === row.chatId){
      // Second click — execute
      executeDeleteChat(row.chatId, row.snapshotId, article).catch(console.warn);
    } else {
      // First click — arm confirm
      clearDeleteConfirm();
      armDeleteConfirm(row.chatId, row.snapshotId, article, deleteBtn);
    }
  });
  tools.appendChild(deleteBtn);

  article.appendChild(button);
  article.appendChild(tools);
  if (badgeHtml){
    const badgesEl = document.createElement("div");
    badgesEl.className = "wbBadges";
    badgesEl.innerHTML = badgeHtml;
    article.appendChild(badgesEl);
  }
  article.addEventListener("pointerenter", () => selectRow(row, article));
  article.addEventListener("focusin", () => selectRow(row, article));
  article.addEventListener("pointerleave", () => {
    // Disarm confirm if mouse leaves the row without confirming
    if (deleteConfirm.chatId === row.chatId) clearDeleteConfirm();
  });
  tools.addEventListener("pointerdown", (ev) => ev.stopPropagation(), true);
  tools.addEventListener("click", (ev) => {
    const target = ev.target instanceof HTMLElement ? ev.target : null;
    const infoBtn = target?.closest(".wbRowIconBtn--info");
    const pinBtn = target?.closest(".wbRowIconBtn--pin");
    const heatBtn = target?.closest(".wbHeatPill");
    if (!infoBtn && !pinBtn && !heatBtn) return;
    ev.preventDefault();
    ev.stopPropagation();

    if (infoBtn){
      openInfoPopover(row, article, infoBtn);
      return;
    }

    if (heatBtn){
      openTitlePalette(row, article, heatBtn);
      return;
    }

    if (pinBtn){
      const nextPinned = !row.pinned;
      row.pinned = nextPinned;
      row.interfaceMeta = {
        ...(row.interfaceMeta && typeof row.interfaceMeta === "object" ? row.interfaceMeta : {}),
        pinned: nextPinned,
      };
      updateCachedRow(row.chatId, { pinned: nextPinned, interfaceMeta: row.interfaceMeta });
      syncRowTools(article, row);
      persistPin(row.chatId, nextPinned).catch(console.warn);
      callArchive("pinSnapshot", { chatId: row.chatId, snapshotId: row.snapshotId, pinned: nextPinned }).catch(console.warn);
      if (activeView === "pinned" && !nextPinned) renderList(activeView, activeFolderId).catch(console.warn);
    }
  });
  button.addEventListener("click", () => {
    selectRow(row, article);
    /* Phase K-1 — linked rows have no snapshot to read. Render the
     * placeholder reader pane inline (no URL change) instead of
     * routing to #/read/<empty>. */
    if (rowIsLinked) {
      renderLinkedReaderPlaceholder(row);
      return;
    }
    if (rowIsLinkOnly(row)) {
      if (openRowOriginalChat(row)) return;
      renderLinkedReaderPlaceholder(row);
      return;
    }
    location.hash = `#/read/${encodeURIComponent(row.snapshotId)}`;
  });
  syncRowTools(article, row);

  return article;
}

/* Phase K-1 — Linked-chat reader placeholder. Replaces the snapshot
 * reader for rows with view: 'linked' (no captured transcript). Shows
 * title + linked-at + linked-from + the original URL, plus three
 * action buttons:
 *   - Open original: routes through H2O.Studio.platform.openUrl ->
 *     plugin:shell|open. Falls back to window.open in MV3.
 *   - Save to Folder: invokes H2O.Library.actions.saveToFolder if the
 *     canonical action surface is present (S0F0j). Hidden otherwise.
 *   - Back to Linked: returns to the list view at #/linked.
 * No URL change is performed when this pane is shown — the hash
 * remains #/linked so a page reload returns the user to the list. */
function renderLinkedReaderPlaceholder(row){
  const readerEl = document.getElementById("viewReader");
  const listPanel = document.getElementById("viewListPanel");
  if (!readerEl) return;
  state.activeRoute = "reader";
  if (listPanel) listPanel.hidden = true;
  readerEl.hidden = false;

  const title = String(row?.title || row?.chatId || "Linked chat");
  const href = String(resolveRowOpenTarget(row) || row?.href || "").trim();
  const linkedAtRaw = String(row?.linkedAt || "").trim();
  const linkedAtFmt = linkedAtRaw ? (fmtDateMeta(linkedAtRaw) || linkedAtRaw) : "";
  const linkedFrom = String(row?.linkedFrom || "").trim();
  const folder = String(row?.folderName || row?.folderId || "").trim();

  const actions = (W.H2O && W.H2O.Library && W.H2O.Library.actions) || null;
  const saveToFolderAvailable = !!(actions && typeof actions.saveToFolder === "function");

  readerEl.innerHTML = `
    <section class="wbLinkedReader" style="padding:24px 28px;max-width:760px;margin:0 auto">
      <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.55;margin-bottom:6px">Linked chat</div>
      <h2 style="margin:0 0 12px;font-size:20px;font-weight:600;line-height:1.3">${esc(title)}</h2>
      <div style="display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;font-size:13px;margin:0 0 20px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace">
        ${href ? `<div style="opacity:.55">URL</div><div><a href="${esc(href)}" class="wbLinkedReader-hrefLink" style="color:inherit;text-decoration:underline;word-break:break-all">${esc(href)}</a></div>` : ""}
        ${linkedAtFmt ? `<div style="opacity:.55">Linked at</div><div>${esc(linkedAtFmt)}</div>` : ""}
        ${linkedFrom ? `<div style="opacity:.55">Linked from</div><div>${esc(linkedFrom)}</div>` : ""}
        ${folder ? `<div style="opacity:.55">Folder</div><div>${esc(folder)}</div>` : ""}
        <div style="opacity:.55">Chat ID</div><div>${esc(row?.chatId || "")}</div>
      </div>
      <div style="padding:14px 16px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:rgba(255,255,255,.02);margin:0 0 16px;font-size:13px;line-height:1.55;opacity:.85">
        Linked chat — no snapshot saved. The conversation lives at the URL above on chatgpt.com.
        Open the original to view it, or capture a snapshot by using Save to Folder on chatgpt.com.
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button id="wbLinkedReader-openOriginal" type="button"
          ${href ? "" : "disabled"}
          style="padding:8px 16px;border-radius:6px;cursor:${href ? "pointer" : "not-allowed"};background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:inherit;font:inherit;font-weight:600">Open original</button>
        ${saveToFolderAvailable ? `<button id="wbLinkedReader-saveToFolder" type="button"
          style="padding:8px 16px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:inherit;font:inherit">Save to Folder</button>` : ""}
        <button id="wbLinkedReader-back" type="button"
          style="padding:8px 16px;border-radius:6px;cursor:pointer;background:transparent;border:1px solid rgba(255,255,255,.08);color:inherit;font:inherit;opacity:.75">Back to Linked Chats</button>
      </div>
      <div id="wbLinkedReader-status" style="margin-top:12px;font-size:12px;opacity:.7;min-height:16px"></div>
    </section>
  `;

  const statusEl = readerEl.querySelector("#wbLinkedReader-status");
  const setStatus = (msg) => { if (statusEl) statusEl.textContent = String(msg || ""); };

  /* Open original — route through openRowOriginalChat so the open target
   * is resolved via the strict preference chain and converted to an
   * absolute chatgpt.com URL (never the Studio origin, never folderId),
   * then opened via platform.openUrl (Tauri shell|open / MV3 in-tab)
   * with a window.open fallback. */
  const openBtn = readerEl.querySelector("#wbLinkedReader-openOriginal");
  const hrefLink = readerEl.querySelector(".wbLinkedReader-hrefLink");
  const openOriginal = (ev) => {
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    if (!href) return;
    openRowOriginalChat(row, setStatus);
  };
  if (openBtn) openBtn.addEventListener("click", openOriginal);
  if (hrefLink) hrefLink.addEventListener("click", openOriginal);

  /* Save to Folder — only wired when the canonical action is present.
   * No-op stub if absent (button is hidden by the template). */
  const saveBtn = readerEl.querySelector("#wbLinkedReader-saveToFolder");
  if (saveBtn && saveToFolderAvailable) {
    saveBtn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      setStatus("Requesting Save to Folder…");
      try {
        const result = await actions.saveToFolder({ chatId: row.chatId });
        if (result && result.ok === false) {
          setStatus("Save to Folder failed: " + String(result.error || result.reason || "unknown"));
        } else {
          setStatus("Save to Folder requested. The chat will appear under Saved on the next refresh.");
        }
      } catch (err) {
        setStatus("Save to Folder failed: " + String((err && (err.message || err)) || err));
      }
    });
  }

  /* Back — re-enter the Linked list. renderList unhides the list
   * panel and re-hides the reader pane. */
  const backBtn = readerEl.querySelector("#wbLinkedReader-back");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      const folderId = state.lastFolderId || "";
      if (location.hash.startsWith("#/linked")) {
        renderList("linked", folderId).catch(console.warn);
      } else {
        location.hash = buildListHash("linked", folderId);
      }
    });
  }

  setRouteMeta("Studio", "Linked chat", title);
  try { document.body.dataset.route = "reader"; } catch (_) { /* ignore */ }
  /* D3.2.2: this inline placeholder opens with no hashchange, so notify
   * the Dock shell to re-sync eligibility + context. Mark eligible now
   * (the reader pane is visible) and fire the reader-refresh event the
   * shell already listens for. */
  try {
    document.body.dataset.dockEligible = "true";
    W.dispatchEvent(new CustomEvent("evt:h2o:studio:reader-refresh-requested", {
      detail: { snapshotId: state.selectedSnapshotId || null, source: "linked-placeholder" },
    }));
  } catch (_) { /* ignore */ }
  /* Phase 1a Studio Ribbon — narrow, explicit setContext call. The linked
   * placeholder is reached via in-page row click (Phase K-1) without a URL
   * change, so renderRoute does NOT fire for this transition and the
   * try/finally tail in renderRoute cannot pick it up. Do not add other
   * call sites in this file; this is the only routing quirk that bypasses
   * renderRoute. */
  try {
    const __ribbon = W?.H2O?.Studio?.ribbon;
    if (__ribbon && typeof __ribbon.setContext === 'function') {
      __ribbon.setContext({
        route: 'linked',
        chatType: 'indexed',
        snapshotId: null,
        chatId: row && row.chatId ? String(row.chatId) : null,
        /* Phase 1b — title and source URL for Copy title / Open original
         * actions on linked-reader. Both come from the row record. */
        title: row && (row.title || row.chatId) ? String(row.title || row.chatId) : null,
        originalUrl: row && row.href ? String(row.href) : null,
        readOnly: false,
      });
    }
  } catch (_) { /* swallow */ }
}

function refreshReaderOverlay(root, snap){
  /* Phase 2a — edit-overlay foundation hook (Phase 2b — now also
   * applies ops to DOM via the extended applier, and publishes
   * hasOverlay to the ribbon context). This remains downstream projection
   * orchestration; the base Renderer equivalence contract excludes it. */
  try {
    const __sid = String(snap?.snapshotId || "");
    const __store = W.H2O?.Studio?.store?.editOverlay;
    const __applier = W.H2O?.Studio?.overlay?.applyOverlay;
    if (__sid && __store && typeof __store.get === "function" && typeof __applier === "function") {
      Promise.resolve(__store.get(__sid)).then((__overlay) => {
        if (!isCurrentReaderRoot(root, snap)) return;
        try { __applier(root, snap, __overlay || null); }
        catch (_) { /* applier never throws, but defensive catch anyway */ }
        /* Phase 5b-1 — inline Bold/Italic render pass on initial mount. */
        try { __inlineRender_apply(root, snap, __overlay || null); }
        catch (_) { /* inline render never throws, defensive catch */ }
        /* Phase 2b — publish hasOverlay to the ribbon context so the
         * Format buttons can read it from ctx (in addition to the per-
         * action isEnabled checks that look at chatType + selection).
         * Phase 2d — also publish undoCount / redoCount so the Home tab
         * Undo/Redo buttons enable correctly on initial reader load. */
        try {
          const __ribbon = W?.H2O?.Studio?.ribbon;
          if (__ribbon && typeof __ribbon.setContext === 'function') {
            const __ctx = __ribbon.getContext();
            const __hasOps = !!(__overlay && Array.isArray(__overlay.ops) && __overlay.ops.length > 0);
            const __undo = (__overlay && Array.isArray(__overlay.undoStack)) ? __overlay.undoStack.length : 0;
            const __redo = (__overlay && Array.isArray(__overlay.redoStack)) ? __overlay.redoStack.length : 0;
            __ribbon.setContext(Object.assign({}, __ctx, {
              hasOverlay: __hasOps,
              undoCount: __undo,
              redoCount: __redo,
            }));
          }
        } catch (_) { /* swallow */ }
      }, () => { /* swallow get rejection — reader continues without overlay */ });
    }
  } catch (_) { /* swallow — overlay must never break the reader */ }
}

function buildReaderDOM(snap, rendererInputRaw){
  const renderer = getStudioChatRenderer();
  const rendererInput = rendererInputRaw || renderer.normalizeInput(snap);
  const rendererResult = renderer.render(rendererInput, { getEditOverride });
  const {
    root,
    turnsEl: sc,
    scrollEl: scrollRoot,
    assistantTurnEls,
  } = rendererResult;
  /* S4C: expose this render's Semantic Index to compatibility consumers. */
  bindReaderSemanticIndex(rendererResult);

  try {
    if (typeof W.H2O?.studioHost?.mount === "function") {
      W.H2O.studioHost.mount({
        readerRoot: root,
        turnsEl: sc,
        scrollEl: scrollRoot,
        snapshot: snap,
        assistantTurnEls
      });
    }
  } catch {}
  syncReaderTopOffset();
  try { setTimeout(syncReaderTopOffset, 80); } catch {}

  refreshReaderOverlay(root, snap);

  /* Phase 2b — message-level selection click handler. Saved-reader only
   * (gated by the chatType check in the ribbon shell). Adds an outline
   * class to the clicked turn and pushes selectedMessageId +
   * selectedTurnIdx into the ribbon context. The handler ignores clicks
   * on interactive descendants so the legacy text-edit flow keeps
   * working unchanged. Never throws. */
  try {
    const mountedSnapshotId = String(snap?.snapshotId || '');
    if (sc && typeof sc.addEventListener === 'function' && mountedSnapshotId) {
      sc.addEventListener('click', function (ev) {
        try {
          const target = ev.target;
          if (!target || typeof target.closest !== 'function') return;
          /* Skip clicks on the legacy edit UI and any interactive
           * descendants — clicking those should not steal focus from
           * the ribbon-selection state. */
          if (target.closest('.wbEditBtn, .wbEditWrap, .wbEditTextarea, button, a, input, select, textarea, [contenteditable="true"]')) return;
          const turn = target.closest('[data-turn]');
          if (!turn || !sc.contains(turn)) return;
          const allTurns = Array.prototype.slice.call(sc.querySelectorAll('[data-turn]'));
          const turnIdx = allTurns.indexOf(turn) + 1; /* 1-based */
          if (turnIdx <= 0) return;
          const messageId = String(turn.getAttribute('data-message-id') || '');
          /* Phase 7b repair 7 — In Edit Mode, skip the selection-class
           * side-effect entirely. The user explicitly does NOT want any
           * selection visual (bg tint, ::before bar, outline) to appear
           * before/while editing. Single-click in Edit Mode goes
           * STRAIGHT to mounting the editor; no intermediate selected
           * state. Outside Edit Mode the existing selection behavior
           * is preserved unchanged. */
          const readerRoot = document.querySelector('.wbReader');
          const editModeOn = !!(readerRoot && readerRoot.dataset && readerRoot.dataset.editMode === 'on');
          if (!editModeOn) {
            /* Move the visible outline */
            for (let i = 0; i < allTurns.length; i += 1) {
              try { allTurns[i].classList.remove('is-ribbon-selected'); } catch (_) {}
            }
            turn.classList.add('is-ribbon-selected');
          }
          /* Push to ribbon context — additive merge preserves existing
           * route/title/etc context fields populated by renderRoute.
           * Done in both modes so the Format-tab actions stay
           * context-aware regardless of whether selection is visually
           * rendered. */
          const ribbon = W?.H2O?.Studio?.ribbon;
          if (ribbon && typeof ribbon.setContext === 'function') {
            const ctx = ribbon.getContext();
            ribbon.setContext(Object.assign({}, ctx, {
              selectedMessageId: messageId || null,
              selectedTurnIdx: turnIdx,
            }));
          }
          /* Phase 7b repair 7 — single-click-to-edit in Edit Mode. */
          try {
            if (editModeOn && !turn.classList.contains('wbTurn--editing')) {
              const currentSnap = state.currentReaderSnapshot;
              if (currentSnap && String(currentSnap.snapshotId || '') === mountedSnapshotId) {
                __mountOverlayEditorOnTurn(turn, currentSnap, turnIdx);
              }
            }
          } catch (_) { /* swallow — editor mount must never break selection */ }
        } catch (_) { /* swallow — selection must never break the reader */ }
      });
    }
  } catch (_) { /* swallow */ }

  return root;
}

function renderReaderRouteMeta(snap){
  const meta = snap?.meta && typeof snap.meta === "object" ? snap.meta : {};
  const title = String(meta.title || snap?.chatId || "Saved chat");
  const answerCount = Number(meta.answerCount || countAssistantTurns(snap?.messages));
  const summary = [
    fmtDate(snap?.createdAt || meta.updatedAt || ""),
    pluralize(answerCount, "answer"),
    meta.folderId ? `Folder: ${meta.folderName || resolveFolderName(meta.folderId) || meta.folderId}` : "",
  ].filter(Boolean).join(" · ");
  setRouteMeta("Studio", title, "");
}

function renderCategoryInspector(snap = state.currentReaderSnapshot){
  const wrap = $("#categoryAssignWrap");
  const statusWrap = $("#categoryStatusRibbon") || $("#categoryStatusTopbar");
  if (!wrap) {
    if (statusWrap) {
      statusWrap.hidden = true;
      statusWrap.innerHTML = "";
      statusWrap.dataset.sourceLabel = "";
      statusWrap.dataset.confidenceText = "";
      statusWrap.dataset.primaryName = "";
      statusWrap.dataset.secondaryName = "";
    }
    return;
  }

  const clearCategoryInspector = () => {
    wrap.hidden = true;
    wrap.innerHTML = "";
    if (statusWrap) {
      statusWrap.hidden = true;
      statusWrap.innerHTML = "";
      statusWrap.dataset.sourceLabel = "";
      statusWrap.dataset.confidenceText = "";
      statusWrap.dataset.primaryName = "";
      statusWrap.dataset.secondaryName = "";
    }
  };

  const selectedRow = getSelectedWorkbenchRow();
  const selectedSnapshotId = String(
    snap?.snapshotId
    || state.currentReaderSnapshot?.snapshotId
    || selectedRow?.snapshotId
    || state.selectedSnapshotId
    || ""
  ).trim();
  if (!selectedSnapshotId) {
    clearCategoryInspector();
    return;
  }

  const meta = snap?.meta && typeof snap.meta === "object"
    ? snap.meta
    : (state.currentReaderSnapshot?.meta && typeof state.currentReaderSnapshot.meta === "object"
      ? state.currentReaderSnapshot.meta
      : {});
  const category = normalizeCategoryAssignment(meta.category ?? selectedRow?.category);
  const catalog = (state.categoryCatalog || []).filter((row) => row.status === "active");
  const primaryId = String(category?.primaryCategoryId || "");
  const secondaryId = String(category?.secondaryCategoryId || "");
  const source = String(category?.source || "");
  const primaryName = resolveCategoryName(primaryId);
  const secondaryName = secondaryId ? resolveCategoryName(secondaryId) : "";
  const confidence = Number(category?.confidence);
  const confidenceText = category?.source === "system" && Number.isFinite(confidence)
    ? `${Math.round(confidence * 100)}%`
    : "";
  const sourceLabel = source === "user"
    ? "Manual"
    : (primaryId || confidenceText || secondaryName ? "System" : "Category");

  if (!catalog.length && !primaryId) {
    clearCategoryInspector();
    return;
  }

  if (statusWrap) {
    const showStatus = !!(primaryId || confidenceText || secondaryName || source);
    statusWrap.hidden = !showStatus;
    statusWrap.dataset.sourceLabel = showStatus ? sourceLabel : "";
    statusWrap.dataset.confidenceText = showStatus ? confidenceText : "";
    statusWrap.dataset.primaryName = showStatus ? primaryName : "";
    statusWrap.dataset.secondaryName = showStatus ? secondaryName : "";
    statusWrap.innerHTML = showStatus ? `
      <div class="wbCategoryMeta"${secondaryName ? ` title="Secondary category: ${esc(secondaryName)}"` : ""}>
        <span class="wbCategorySource">${esc(sourceLabel)}</span>
        ${confidenceText ? `<span class="wbCategoryConfidence">${esc(confidenceText)}</span>` : ""}
      </div>
    ` : "";
  }

  const options = [
    { value: "", label: primaryId ? "Uncategorized" : "Select category" },
    ...catalog.map((row) => ({
      value: String(row.id || ""),
      label: String(row.name || row.id || ""),
    })),
  ];
  if (primaryId && !options.some((item) => item.value === primaryId)) {
    options.push({ value: primaryId, label: primaryName });
  }

  wrap.hidden = false;
  wrap.innerHTML = `
    <label class="wbSelectWrap wbSelectWrap--topbar wbSelectWrap--category">
      <span class="wbSelectLabel">Category</span>
      <select id="categoryAssignSelect" class="wbSelect" aria-label="Assign selected chat to category">
        ${options.map((row) => (
          `<option value="${esc(row.value)}"${row.value === primaryId ? " selected" : ""}>${esc(row.label)}</option>`
        )).join("")}
      </select>
    </label>
    ${source === "user" ? `<button class="wbBtn wbBtn--topbar" id="restoreCategoryBtn" type="button">Restore system</button>` : ""}
    <button class="wbBtn wbBtn--topbar" id="reclassifyCategoryBtn" type="button">Reclassify</button>
  `;
}

async function renderList(view, folderId = "", opts = {}){
  const token = ++state.renderToken;
  const nextView = normalizeArchiveView(view);
  const selectedFolderId = normalizeFolderFilter(folderId);
  const query = $("#q")?.value || "";
  const listPanel = $("#viewListPanel");
  const listEl = $("#viewList");
  const readerEl = $("#viewReader");

  state.currentReaderSnapshot = null;
  state.lastView = nextView;
  state.lastFolderId = selectedFolderId;
  setStudioRouteScope("list");
  setActiveNav(nextView);

  const listHash = buildListHash(nextView, selectedFolderId);
  studioHostUnmountPreservingRouteHash("studio:list");
  if (location.hash !== listHash){
    try {
      history.replaceState(
        Object.assign({}, history.state || {}, { h2oStudioReader: false }),
        "",
        listHash
      );
    } catch {
      location.hash = listHash;
    }
  }
  if (readerEl) readerEl.hidden = true;
  if (listPanel) listPanel.hidden = false;
  if (listEl) listEl.innerHTML = `<div class="wbState">Loading ${esc(viewCopy(nextView).toLowerCase())}…</div>`;
  setSidebarChatLoading(nextView, selectedFolderId);
  setRouteMeta("Studio", viewCopy(nextView), "Loading archive state");

  try {
    const fetched = await promiseWithTimeout(
      fetchWorkbenchRows(!!opts.force),
      STUDIO_ARCHIVE_TIMEOUT_MS * 2,
      "fetchWorkbenchRows"
    );
    if (token !== state.renderToken) return;
    const [allRows] = await Promise.all([
      promiseWithTimeoutFallback(
        enrichRowsWithFolderData(fetched, !!opts.force),
        STUDIO_BOOT_AUX_TIMEOUT_MS + 1000,
        "enrichRowsWithFolderData",
        fetched
      ),
      promiseWithTimeoutFallback(
        fetchLabelCatalog(!!opts.force),
        STUDIO_BOOT_AUX_TIMEOUT_MS,
        "fetchLabelCatalog",
        []
      ),
      promiseWithTimeoutFallback(
        fetchCategoryCatalog(!!opts.force),
        STUDIO_BOOT_AUX_TIMEOUT_MS,
        "fetchCategoryCatalog",
        []
      ),
    ]);
    if (token !== state.renderToken) return;

    renderFolderSidebar(allRows, nextView, selectedFolderId);
    const rows = filterRows(allRows, nextView, query, selectedFolderId, state.lastTagFilter);
    renderSidebarChatList(rows, nextView, selectedFolderId, query);
    renderListHeader(allRows, rows, nextView, selectedFolderId, query);

    if (!rows.length){
      if (listEl) listEl.innerHTML = buildEmptyListState(nextView, selectedFolderId, query);
      state.selectedSnapshotId = "";
      state.selectedChatId = "";
      setActiveSidebarChat("");
      syncSelectionControls();
      return;
    }

    if (listEl) listEl.innerHTML = "";
    let selectedRow = null;
    let selectedEl = null;
    const preferredSnapshotId = String(opts.snapshotId || "").trim();
    const preferredChatId = String(opts.chatId || "").trim();
    const currentSelectedSnapshotId = String(state.selectedSnapshotId || "").trim();

    const frag = document.createDocumentFragment();
    rows.forEach((row, index) => {
      const isSelected = preferredSnapshotId
        ? preferredSnapshotId === row.snapshotId
        : preferredChatId
          ? preferredChatId === row.chatId
          : currentSelectedSnapshotId
            ? currentSelectedSnapshotId === row.snapshotId
            : index === 0;
      const el = renderRow(row, isSelected, nextView, selectedFolderId);
      frag.appendChild(el);
      if (isSelected && !selectedRow) {
        selectedRow = row;
        selectedEl = el;
      }
    });
    listEl?.appendChild(frag);

    if (!selectedRow) {
      selectedRow = rows[0];
      selectedEl = listEl?.querySelector(".wbHistoryRow") || null;
    }
    if (selectedRow) selectRow(selectedRow, selectedEl);
  } catch (error){
    renderFolderSidebar(state.rowsCache || [], nextView, selectedFolderId);
    refreshSidebarChatList(nextView, selectedFolderId);
    renderListHeader(state.rowsCache || [], [], nextView, selectedFolderId, query);
    if (listEl) listEl.innerHTML = buildListErrorState(error);
    state.selectedSnapshotId = "";
    state.selectedChatId = "";
    setActiveSidebarChat("");
    syncSelectionControls();
  }
}

function ensureReaderTopbarActions(){
  const slot = document.querySelector('[data-role="topbar-actions"]');
  if (!slot) return;

  let refreshBtn = document.getElementById("wbReaderRefreshBtn");
  if (!refreshBtn) {
    refreshBtn = document.createElement("button");
    refreshBtn.id = "wbReaderRefreshBtn";
    refreshBtn.type = "button";
    refreshBtn.className = "wbLibraryPageRefreshBtn wbReaderTopbarBtn wbReaderRefreshBtn";
    refreshBtn.setAttribute("aria-label", "Refresh chat transcript");
    refreshBtn.setAttribute("title", "Refresh chat transcript");
    refreshBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3.5-7.1"/><path d="M21 4v5h-5"/></svg>';
    refreshBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const sid = String(state.currentReaderSnapshot?.snapshotId || state.selectedSnapshotId || "").trim();
      if (!sid) return;
      refreshBtn.classList.add("is-spinning");
      renderReader(sid).catch(console.warn).finally(() => {
        setTimeout(() => refreshBtn.classList.remove("is-spinning"), 400);
      });
    });
  }

  let ribbonBtn = document.getElementById("wbReaderRibbonToggleBtn");
  if (!ribbonBtn) {
    ribbonBtn = document.createElement("button");
    ribbonBtn.id = "wbReaderRibbonToggleBtn";
    ribbonBtn.type = "button";
    ribbonBtn.className = "wbLibraryPageRefreshBtn wbReaderTopbarBtn wbReaderRibbonToggleBtn";
    ribbonBtn.setAttribute("aria-label", "Toggle chat ribbon menu");
    ribbonBtn.setAttribute("title", "Toggle chat ribbon menu");
    ribbonBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M4 12h10"/><path d="M4 17h16"/></svg>';
    ribbonBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const chrome = getDesktopChromeEl();
      const hidden = !!(chrome && chrome.getAttribute("data-reader-ribbon-hidden") === "true");
      setDesktopReaderRibbonHidden(!hidden);
      updateReaderTopbarActionState();
    });
  }

  const appearanceBtn = slot.querySelector(".wbAppearanceBtn");
  slot.appendChild(refreshBtn);
  slot.appendChild(ribbonBtn);
  if (appearanceBtn) slot.appendChild(appearanceBtn);
  updateReaderTopbarActionState();
}

function updateReaderTopbarActionState(){
  const chrome = getDesktopChromeEl();
  const hidden = !!(chrome && chrome.getAttribute("data-reader-ribbon-hidden") === "true");
  const ribbonBtn = document.getElementById("wbReaderRibbonToggleBtn");
  if (ribbonBtn) {
    ribbonBtn.setAttribute("aria-pressed", hidden ? "false" : "true");
    ribbonBtn.classList.toggle("is-on", !hidden);
  }
}

async function renderReader(snapshotId){
  const token = ++state.renderToken;
  const sid = String(snapshotId || "").trim();
  const listPanel = $("#viewListPanel");
  const readerEl = $("#viewReader");
  const previousSnapshot = state.currentReaderSnapshot;
  const previousEditOverrides = state.currentReaderEditOverrides;
  const previousSnapshotId = String(previousSnapshot?.snapshotId || "").trim();
  const previousMount = sid && sid === previousSnapshotId
    ? getReusableReaderMount(previousSnapshot)
    : null;
  const mayAttemptReuse = !!(
    previousMount
    && Array.isArray(previousEditOverrides)
  );

  if (!mayAttemptReuse){
    state.currentReaderSnapshot = null;
    studioHostUnmountPreservingRouteHash("studio:reader-replace");
  }
  setStudioRouteScope("reader");
  applyDesktopReaderRibbonSession();
  ensureReaderTopbarActions();
  if (listPanel) listPanel.hidden = true;
  if (readerEl) readerEl.hidden = false;
  if (readerEl && !mayAttemptReuse) readerEl.innerHTML = `<div class="wbState">Loading reader…</div>`;
  setRouteMeta("Studio", "Saved chat", "Loading snapshot");

  try {
    const loadedSnapshot = await callArchive("loadSnapshot", { snapshotId: sid });
    if (token !== state.renderToken) return;
    if (!loadedSnapshot){
      state.currentReaderSnapshot = null;
      studioHostUnmountPreservingRouteHash("studio:reader-missing");
      if (readerEl) readerEl.innerHTML = `<div class="wbState">Snapshot not found.</div>`;
      state.selectedSnapshotId = "";
      state.selectedChatId = "";
      setStudioRouteScope("reader");
      syncSelectionControls();
      return;
    }
    let snap = loadedSnapshot;

    if (!Array.isArray(state.rowsCache)) {
      try {
        const rows = await fetchWorkbenchRows(false);
        if (token !== state.renderToken) return;
        await enrichRowsWithFolderData(rows, false);
      } catch {}
    }
    renderFolderSidebar(state.rowsCache || [], state.lastView, state.lastFolderId);

    await Promise.all([
      promiseWithTimeoutFallback(fetchFolderCatalog(false), STUDIO_BOOT_AUX_TIMEOUT_MS, "fetchFolderCatalog", { canonical: [], review: [] }),
      promiseWithTimeoutFallback(fetchLabelCatalog(false), STUDIO_BOOT_AUX_TIMEOUT_MS, "fetchLabelCatalog", []),
      promiseWithTimeoutFallback(fetchCategoryCatalog(false), STUDIO_BOOT_AUX_TIMEOUT_MS, "fetchCategoryCatalog", []),
    ]);
    const bindings = await promiseWithTimeoutFallback(
      resolveFolderBindingsForChatIds([snap.chatId]),
      STUDIO_BOOT_AUX_TIMEOUT_MS,
      "resolveFolderBindingsForChatIds",
      new Map()
    );
    if (token !== state.renderToken) return;
    if (bindings.has(snap.chatId)) {
      const binding = normalizeFolderBinding(bindings.get(snap.chatId));
      const meta = snap.meta && typeof snap.meta === "object" ? snap.meta : {};
      snap = {
        ...snap,
        meta: {
          ...meta,
          folderId: binding.folderId,
          folderName: binding.folderId
            ? (binding.folderName || resolveFolderName(binding.folderId) || binding.folderId)
            : "",
        },
      };
      updateRowFolderBinding(snap.chatId, snap.meta);
    }
    renderFolderSidebar(state.rowsCache || [], state.lastView, state.lastFolderId);
    refreshSidebarChatList(state.lastView, state.lastFolderId);

    const renderer = getStudioChatRenderer();
    const rendererInput = renderer.normalizeInput(snap);
    const nextEditOverrides = collectRendererEditOverrides(rendererInput);
    let canReuseMountedReader = mayAttemptReuse && canReuseReaderDOM({
      mount: previousMount,
      token,
      previousSnapshot,
      rendererInput,
      previousEditOverrides,
      nextEditOverrides,
    });
    if (canReuseMountedReader){
      try {
        canReuseMountedReader = W.H2O.studioHost.updateSnapshot(snap) === true;
      } catch {
        canReuseMountedReader = false;
      }
    }

    if (!canReuseMountedReader && mayAttemptReuse){
      state.currentReaderSnapshot = null;
      studioHostUnmountPreservingRouteHash("studio:reader-replace");
    }

    state.currentReaderSnapshot = snap;
    state.selectedSnapshotId = String(snap.snapshotId || "").trim();
    state.selectedChatId = String(snap.chatId || "").trim();

    if (canReuseMountedReader){
      state.currentReaderEditOverrides = nextEditOverrides;
      refreshReaderOverlay(previousMount.root, snap);
    } else if (readerEl) {
      readerEl.innerHTML = "";
      readerEl.appendChild(buildReaderDOM(snap, rendererInput));
      state.currentReaderEditOverrides = nextEditOverrides;
    } else {
      state.currentReaderEditOverrides = null;
    }
    renderReaderRouteMeta(snap);
    setActiveSidebarChat(state.selectedSnapshotId);
    syncSelectionControls();
    applyUiState();
    /* D3.2.2: the snapshot loaded asynchronously after the initial
     * hashchange, so notify the Dock shell to re-render the active tab
     * with the now-resolved chatId. applyUiState() above already
     * refreshed the dockEligible marker. */
    try {
      W.dispatchEvent(new CustomEvent("evt:h2o:studio:reader-refresh-requested", {
        detail: { snapshotId: state.currentReaderSnapshot?.snapshotId || null, source: "reader-loaded" },
      }));
    } catch (_) { /* ignore */ }
  } catch (error){
    if (token !== state.renderToken) return;
    state.currentReaderSnapshot = null;
    studioHostUnmountPreservingRouteHash("studio:reader-error");
    if (readerEl) {
      readerEl.innerHTML = `<div class="wbState wbState--error">${esc(error?.message || "Failed to load snapshot.")}</div>`;
    }
    state.selectedSnapshotId = "";
    state.selectedChatId = "";
    setStudioRouteScope("reader");
    setActiveSidebarChat("");
    syncSelectionControls();
  }
}

// ── Library Workspace mutation integration ─────────────────────────────────
// Opportunistically route folder / category / reclassify mutations through
// H2O.LibraryWorkspace when it's booted, so the Workspace cache busts, the
// Library Index refreshes, Insights re-renders, and S0F1h Library Sync
// broadcasts the change to other surfaces. If the facade isn't ready, fall
// back to the original tryArchiveOps path so behavior never regresses.
async function workspaceFolderBinding(chatId, folderId){
  const ws = getLibraryWorkspace();
  if (!ws?.setFolderBinding) return null;
  try {
    const result = await ws.setFolderBinding(chatId, folderId, { source: "user" });
    return { ok: true, result };
  } catch (error){
    return { ok: false, error };
  }
}
async function workspaceCategoryAssign(snapshotId, chatId, primaryCategoryId){
  const ws = getLibraryWorkspace();
  if (!ws?.setSnapshotCategory) return null;
  try {
    const result = await ws.setSnapshotCategory(snapshotId, chatId, primaryCategoryId);
    return { ok: true, result };
  } catch (error){
    return { ok: false, error };
  }
}
async function workspaceCategoryReclassify(snapshotId){
  const ws = getLibraryWorkspace();
  if (!ws?.reclassifySnapshotCategory) return null;
  try {
    const result = await ws.reclassifySnapshotCategory(snapshotId);
    return { ok: true, result };
  } catch (error){
    return { ok: false, error };
  }
}

async function handleFolderAssignChange(){
  const select = $("#folderAssignSelect");
  const chatId = String(state.selectedChatId || state.currentReaderSnapshot?.chatId || "").trim();
  if (!(select && chatId)) return;

  const nextFolderId = normalizeFolderFilter(select.value);
  select.disabled = true;
  try {
    // Prefer the Workspace facade; it shares the same archive bridge but also
    // busts the Library catalog cache and emits 'folder-binding-changed'.
    let attempt = await workspaceFolderBinding(chatId, nextFolderId);
    if (!attempt || !attempt.ok){
      attempt = await tryArchiveOps(FOLDER_SET_OPS, { chatId, folderId: nextFolderId, folderBindingSource: "user" });
    }
    if (!attempt.ok) throw attempt.error || new Error("Folder update failed");

    const binding = normalizeFolderBinding(attempt.result);
    updateRowFolderBinding(chatId, binding);
    renderFolderSidebar(state.rowsCache || [], state.lastView, state.lastFolderId);
    renderFolderAssignmentControl();

    const route = parseHash();
    if (route.name === "list") {
      await renderList(route.view, route.folderId, {
        chatId,
        snapshotId: state.selectedSnapshotId,
      });
      return;
    }

    refreshSidebarChatList(state.lastView, state.lastFolderId);
    renderReaderRouteMeta(state.currentReaderSnapshot || {});
    syncSelectionControls();
  } catch (error){
    renderFolderAssignmentControl();
    window.alert(String(error?.message || error || "Failed to update folder binding."));
  } finally {
    if (select) select.disabled = false;
  }
}

async function handleCategoryAssignChange(){
  const select = $("#categoryAssignSelect");
  const snapshotId = String(state.currentReaderSnapshot?.snapshotId || state.selectedSnapshotId || "").trim();
  const primaryCategoryId = String(select?.value || "").trim();
  if (!(select && snapshotId && primaryCategoryId)) return;

  const chatId = String(state.currentReaderSnapshot?.chatId || state.selectedChatId || "").trim();

  select.disabled = true;
  try {
    let attempt = await workspaceCategoryAssign(snapshotId, chatId, primaryCategoryId);
    if (!attempt || !attempt.ok){
      attempt = await tryArchiveOps(CATEGORY_SET_OPS, { snapshotId, primaryCategoryId });
    }
    if (!attempt.ok) throw attempt.error || new Error("Category update failed");
    applySnapshotCategoryUpdate(attempt.result);
    renderCategoryInspector();
    refreshSidebarChatList(state.lastView, state.lastFolderId);
  } catch (error){
    renderCategoryInspector();
    window.alert(String(error?.message || error || "Failed to update category."));
  } finally {
    if (select) select.disabled = false;
  }
}

async function handleCategoryReclassify(){
  const snapshotId = String(state.currentReaderSnapshot?.snapshotId || state.selectedSnapshotId || "").trim();
  if (!snapshotId) return;
  const buttons = ["#restoreCategoryBtn", "#reclassifyCategoryBtn"].map((selector) => $(selector)).filter(Boolean);
  buttons.forEach((btn) => { btn.disabled = true; });
  try {
    let attempt = await workspaceCategoryReclassify(snapshotId);
    if (!attempt || !attempt.ok){
      attempt = await tryArchiveOps(CATEGORY_RECLASSIFY_OPS, { snapshotId });
    }
    if (!attempt.ok) throw attempt.error || new Error("Category reclassify failed");
    applySnapshotCategoryUpdate(attempt.result);
    renderCategoryInspector();
    refreshSidebarChatList(state.lastView, state.lastFolderId);
  } catch (error){
    renderCategoryInspector();
    window.alert(String(error?.message || error || "Failed to reclassify category."));
  }
}

function setSidebarExpanded(expanded){
  state.sidebarExpanded = !!expanded;
  writeUiPrefs();
  applyUiState();
}

function openSidebar(){
  setSidebarExpanded(true);
}

function openSidebarForDock(){
  openSidebar();
}

function closeSidebarForDock(){
  // Dock back/arrow returns to the collapsed rail without changing the
  // user's persisted sidebar preference.
  state.sidebarExpanded = false;
  applyUiState();
}

(() => {
  const H2O = W.H2O = W.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.openSidebarForDock = openSidebarForDock;
  H2O.Studio.closeSidebarForDock = closeSidebarForDock;
})();

function closeDockSidebarModeIfOpen(){
  try {
    const dock = W.H2O && W.H2O.Studio && W.H2O.Studio.dock;
    const dockState = dock && typeof dock.getState === "function" ? dock.getState() : null;
    if (dockState && dockState.open && typeof dock.close === "function") dock.close();
  } catch {}
}

function closeSidebar(){
  closeDockSidebarModeIfOpen();
  setSidebarExpanded(false);
}

function setRailButtonExpanded(button, expanded){
  if (!button) return;
  button.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function railChatIconSvg(){
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7A2.5 2.5 0 0 1 16.5 16H10l-4 3v-3.25A2.5 2.5 0 0 1 5 13.5v-7Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
}

function railFolderIconSvg(){
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.75 6.5A2.25 2.25 0 0 1 6 4.25h4.15l1.85 2H18A2.25 2.25 0 0 1 20.25 8.5v7.75A2.25 2.25 0 0 1 18 18.5H6a2.25 2.25 0 0 1-2.25-2.25V6.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
}

function railEmptyHtml(message){
  return `<div class="wbRailPopoverEmpty">${esc(message)}</div>`;
}

function railSearchEmptyHtml(message){
  return `<div class="wbRailPopoverEmpty">${esc(message)}</div>`;
}

function railRecentHref(row){
  const readerSnapshotId = rowReaderSnapshotId(row);
  if (readerSnapshotId && !rowIsLinkOnly(row)) return `#/read/${encodeURIComponent(readerSnapshotId)}`;
  return buildListHash("linked", state.lastFolderId || "");
}

function railRecentRows(query = "", limit = 10){
  const rows = collectCanonicalSidebarRecentChats(state.rowsCache || [], "", query);
  const cap = Math.max(1, Number(limit) || 10);
  return rows.slice(0, cap);
}

function railFolderItems(limit = 16){
  const items = collectFolderSidebarItems(state.rowsCache || [], state.lastView || "saved", "canonical")
    .filter((item) => item && item.kind === "folder");
  const cap = Math.max(1, Number(limit) || 16);
  return items.slice(0, cap);
}

function closeRailPopover(){
  const pop = $("#wbRailPopover");
  if (pop) pop.hidden = true;
  if (activeRailPopoverButton) setRailButtonExpanded(activeRailPopoverButton, false);
  activeRailPopoverButton = null;
}

function closeRailSearchOverlay(){
  const overlay = $("#wbRailSearchOverlay");
  if (overlay) overlay.hidden = true;
  setRailButtonExpanded($("#railSearchBtn"), false);
}

function closeRailSurfaces(){
  closeRailPopover();
  closeRailSearchOverlay();
}

function positionRailPopover(anchor){
  const pop = $("#wbRailPopover");
  if (!(pop && anchor)) return;
  const railRect = $(".wbRail")?.getBoundingClientRect?.();
  const anchorRect = anchor.getBoundingClientRect();
  const left = Math.round((railRect?.right || anchorRect.right) + 4);
  const height = pop.offsetHeight || 320;
  const top = Math.max(16, Math.min(Math.round(anchorRect.top - 16), Math.round(window.innerHeight - height - 16)));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function openRailPopover(kind, anchor){
  const pop = $("#wbRailPopover");
  const title = $("#wbRailPopoverTitle");
  const list = $("#wbRailPopoverList");
  if (!(pop && title && list && anchor)) return;
  const sameOpen = activeRailPopoverButton === anchor && !pop.hidden;
  closeRailSearchOverlay();
  closeRailPopover();
  if (sameOpen) return;

  if (kind === "folders"){
    title.textContent = "Folders";
    const items = railFolderItems();
    list.innerHTML = items.length
      ? items.map((item) => {
        const count = folderSidebarSimpleCountLabel(item);
        const href = buildListHash(state.lastView || "saved", item.folderId);
        return `
          <button type="button" class="wbRailPopoverItem" role="menuitem" data-rail-href="${esc(href)}">
            <span class="wbRailPopoverIcon">${railFolderIconSvg()}</span>
            <span class="wbRailPopoverBody">
              <span class="wbRailPopoverLabel">${esc(item.label || item.folderId || "Folder")}</span>
              <span class="wbRailPopoverMeta">${esc(count || "Folder")}</span>
            </span>
          </button>`;
      }).join("")
      : railEmptyHtml("No folders available.");
  } else {
    title.textContent = "Recents";
    const rows = railRecentRows("", 10);
    list.innerHTML = rows.length
      ? rows.map((row) => {
        const href = railRecentHref(row);
        const meta = rowMetaParts(row).join(" · ");
        return `
          <button type="button" class="wbRailPopoverItem" role="menuitem" data-rail-href="${esc(href)}">
            <span class="wbRailPopoverIcon">${railChatIconSvg()}</span>
            <span class="wbRailPopoverBody">
              <span class="wbRailPopoverLabel">${esc(row.title || "Untitled chat")}</span>
              <span class="wbRailPopoverMeta">${esc(meta || "Saved chat")}</span>
            </span>
          </button>`;
      }).join("")
      : railEmptyHtml("No recent chats available.");
  }

  activeRailPopoverButton = anchor;
  setRailButtonExpanded(anchor, true);
  pop.hidden = false;
  positionRailPopover(anchor);
}

function renderRailSearchResults(){
  const input = $("#wbRailSearchInput");
  const host = $("#wbRailSearchResults");
  if (!(input && host)) return;
  const query = String(input.value || "").trim();
  const rows = railRecentRows(query, 12);
  if (!rows.length) {
    host.innerHTML = railSearchEmptyHtml(query ? "No chats match this search." : "No recent chats available.");
    return;
  }
  host.innerHTML = `
    <div class="wbRailSearchGroup">${esc(query ? "Results" : "Recent chats")}</div>
    ${rows.map((row) => {
      const href = railRecentHref(row);
      const meta = rowMetaParts(row).join(" · ");
      return `
        <button type="button" class="wbRailSearchItem" role="option" data-rail-href="${esc(href)}">
          <span class="wbRailSearchIcon">${railChatIconSvg()}</span>
          <span class="wbRailSearchText">
            <span class="wbRailSearchTitle">${esc(row.title || "Untitled chat")}</span>
            <span class="wbRailSearchMeta">${esc(meta || "Saved chat")}</span>
          </span>
        </button>`;
    }).join("")}`;
}

function openRailSearchOverlay(){
  const overlay = $("#wbRailSearchOverlay");
  const input = $("#wbRailSearchInput");
  if (!(overlay && input)) return;
  closeRailPopover();
  overlay.hidden = false;
  setRailButtonExpanded($("#railSearchBtn"), true);
  input.value = "";
  renderRailSearchResults();
  requestAnimationFrame(() => input.focus());
}

function toggleDensity(){
  state.density = state.density === "compact" ? "cozy" : "compact";
  writeUiPrefs();
  applyUiState();
}

function toggleLayout(){
  state.layout = state.layout === "wide" ? "focused" : "wide";
  writeUiPrefs();
  applyUiState();
}

function focusSearch(){
  // v2.8: the visible #q input was removed from the sidebar header in favour
  // of a "Search chats" nav row that routes into the Library Explorer (which
  // exposes its own page-level search input). Keep this helper as a no-op-
  // friendly entry point so any callers (keyboard shortcuts, etc.) still work.
  const q = $("#q");
  if (q && typeof q.focus === "function" && !q.hidden) { q.focus(); return; }
  if (location.hash !== "#/library/explorer") location.hash = "#/library/explorer";
  // Defer one frame so S0F1d has a chance to mount the Explorer page header.
  requestAnimationFrame(() => {
    const pageSearch = document.querySelector(".wbLibraryPageSearchInput");
    if (pageSearch && typeof pageSearch.focus === "function") pageSearch.focus();
  });
}

function isVisibleStudioFoldersRoute(){
  const route = parseHash();
  return route.name === "library" && String(route.view || "").toLowerCase() === "folders";
}

function visibleStudioFolderDebugDetailsVisible(){
  return folderOperatorModeEnabled();
}

function visibleStudioFolderSimpleCountLabel(row){
  const count = Number(row?.nativeMembershipCount ?? row?.canonicalCount ?? row?.count ?? row?.knownStudioCount ?? row?.knownCount ?? 0) || 0;
  return pluralize(count, "chat");
}

function visibleStudioFolderPageCountLabel(row){
  if (!visibleStudioFolderDebugDetailsVisible()) return visibleStudioFolderSimpleCountLabel(row);
  const explicit = String(row?.displayCountLabel || "").trim();
  if (explicit) return explicit;
  if (row?.isUnfiled) return `${Number(row?.knownCount || 0) || 0} known here`;
  const nativeCount = Number(row?.nativeMembershipCount ?? row?.canonicalCount ?? row?.count ?? 0) || 0;
  const knownCount = Number(row?.knownStudioCount ?? row?.knownCount ?? 0) || 0;
  return row?.isCanonical === true
    ? `${nativeCount} native · ${knownCount} known here`
    : `${knownCount} known here`;
}

function normalizeVisibleStudioFolderPageRow(raw, canonical){
  const folderId = String(raw?.folderId || raw?.id || "").trim();
  if (!folderId) return null;
  const name = String(raw?.name || raw?.label || folderId).trim() || folderId;
  return {
    ...raw,
    id: folderId,
    folderId,
    name,
    label: name,
    isCanonical: canonical === true || raw?.isCanonical === true,
    iconColor: normalizeSidebarIconColor(raw?.iconColor || raw?.color || ""),
    color: normalizeSidebarIconColor(raw?.iconColor || raw?.color || ""),
    displayCountLabel: String(raw?.displayCountLabel || "").trim(),
    nativeMembershipCount: Number(raw?.nativeMembershipCount ?? raw?.canonicalCount ?? raw?.count ?? 0) || 0,
    canonicalCount: Number(raw?.canonicalCount ?? raw?.nativeMembershipCount ?? raw?.count ?? 0) || 0,
    knownCount: Number(raw?.knownStudioCount ?? raw?.knownCount ?? 0) || 0,
    knownStudioCount: Number(raw?.knownStudioCount ?? raw?.knownCount ?? 0) || 0,
  };
}

function countVisibleStudioUnfiledRows(){
  return (Array.isArray(state.rowsCache) ? state.rowsCache : []).filter((row) => {
    const folderId = String(row?.folderId || "").trim();
    return !folderId && matchesView(row, state.lastView || "saved");
  }).length;
}

function makeVisibleStudioFolderPageActionButton(row){
  const button = document.createElement("button");
  const name = String(row?.name || row?.folderId || "folder");
  button.className = "wbFolderPageActionButton";
  button.type = "button";
  button.textContent = "...";
  button.dataset.h2oFolderPageActionButton = "1";
  button.dataset.h2oFolderId = String(row?.folderId || "");
  button.dataset.folderId = String(row?.folderId || "");
  button.dataset.h2oFolderName = name;
  button.dataset.h2oFolderCanonical = row?.isCanonical === true ? "true" : "false";
  button.dataset.h2oFolderColor = String(row?.iconColor || row?.color || "");
  button.title = row?.isCanonical === true ? `More options for ${name}` : "Local Review rows are protected";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-expanded", "false");
  button.style.cssText = [
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "width:30px",
    "height:30px",
    "min-width:30px",
    "max-width:30px",
    "padding:0",
    "border:1px solid rgba(255,255,255,.12)",
    "border-radius:8px",
    "background:rgba(255,255,255,.045)",
    "color:rgba(255,255,255,.78)",
    "font:700 14px/1 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif",
    "letter-spacing:0",
    "flex:0 0 auto",
    row?.isCanonical === true ? "cursor:pointer" : "cursor:not-allowed;opacity:.52",
  ].join(";");
  if (row?.isCanonical === true) {
    button.setAttribute("aria-haspopup", "menu");
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const openMenu = W.H2O?.Library?.SidebarSections?.openRowMenu;
      if (typeof openMenu === "function") {
        openMenu(button, {
          ...row,
          kind: "folders",
          section: "folders",
          id: row.folderId,
          folderId: row.folderId,
          name: row.name,
          label: row.name,
          color: row.iconColor || row.color || "",
          iconColor: row.iconColor || row.color || "",
          isCanonical: true,
        });
      }
    });
  } else {
    button.disabled = true;
    button.setAttribute("aria-disabled", "true");
  }
  return button;
}

function makeVisibleStudioFolderPageRow(row){
  const label = visibleStudioFolderPageCountLabel(row);
  const folderId = String(row?.folderId || row?.id || "").trim();
  const name = String(row?.name || folderId).trim() || folderId;
  const iconColor = normalizeSidebarIconColor(row?.iconColor || row?.color || "") || "currentColor";
  const showDebugDetails = visibleStudioFolderDebugDetailsVisible();
  const debugBadge = showDebugDetails
    ? `<span style="display:inline-flex;align-items:center;border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:2px 7px;font-size:10.5px;line-height:1.2;color:rgba(255,255,255,.78);background:rgba(255,255,255,.045)">${esc(row?.isUnfiled ? "system" : row?.isCanonical ? "canonical" : "review-required")}</span>`
    : "";
  const debugId = showDebugDetails && folderId
    ? `<span style="display:block;margin-top:5px;color:rgba(255,255,255,.55);font-size:11.5px;line-height:1.35;word-break:break-all">ID ${esc(folderId)}</span>`
    : "";
  const href = row?.isUnfiled
    ? buildListHash(state.lastView || "saved", FOLDER_FILTER_NONE)
    : buildListHash(state.lastView || "saved", folderId);
  const rowEl = document.createElement("div");
  rowEl.className = "wbFolderPageRow";
  rowEl.setAttribute("role", "listitem");
  rowEl.dataset.h2oFolderPageRow = "1";
  rowEl.dataset.h2oFolderId = folderId;
  rowEl.dataset.folderId = folderId;
  rowEl.dataset.canonical = row?.isCanonical === true ? "true" : "false";
  rowEl.title = `${name} — ${label}`;
  rowEl.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:14px 14px 14px 16px;border-bottom:1px solid rgba(255,255,255,.08);color:inherit";

  const link = document.createElement("a");
  link.className = "wbFolderPageRowLink";
  link.href = href;
  link.dataset.h2oFolderId = folderId;
  link.dataset.folderId = folderId;
  link.title = `${name} — ${label}`;
  link.style.cssText = "display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:14px;align-items:center;min-width:0;color:inherit;text-decoration:none";
  link.innerHTML = `
    <span class="wbFolderPageIcon" aria-hidden="true" style="display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:8px;border:1px solid rgba(255,255,255,.10);color:${esc(iconColor)};background:rgba(255,255,255,.035);flex:0 0 auto">
      ${SIDEBAR_FOLDER_ICON_SVG}
    </span>
    <span style="min-width:0">
      <span style="display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap">
        <span style="font-weight:650;font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</span>
        ${debugBadge}
      </span>
      ${debugId}
    </span>
    <span title="${esc(label)}" aria-label="${esc(label)}" style="text-align:right;color:rgba(255,255,255,.78);font-size:12px;line-height:1.25;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(label)}</span>
  `;
  rowEl.appendChild(link);
  if (row?.isUnfiled) {
    const spacer = document.createElement("span");
    spacer.setAttribute("aria-hidden", "true");
    spacer.style.cssText = "display:inline-block;width:30px;height:30px";
    rowEl.appendChild(spacer);
  } else {
    rowEl.appendChild(makeVisibleStudioFolderPageActionButton(row));
  }
  return rowEl;
}

async function appendVisibleStudioRecentlyDeletedFoldersPanel(page){
  if (!page) return false;
  const host = document.createElement("section");
  host.className = "wbFolderPageRecentlyDeletedHost";
  host.dataset.h2oFolderPageRecentlyDeletedHost = "1";
  host.style.cssText = "display:flex;flex-direction:column;min-width:0";
  page.appendChild(host);
  const api = W.H2O?.Library?.SidebarSections;
  if (!STUDIO_isTauri() && api && typeof api.renderChromeRecentlyDeletedCompanionPanel === "function") {
    try {
      await api.renderChromeRecentlyDeletedCompanionPanel(host, { placement: "main", model: null });
      return true;
    } catch (error) {
      console.warn("[H2O.Studio] Chrome Recently Deleted companion failed", error);
      host.innerHTML = `
        <section class="wbFolderRecentlyDeleted wbFolderRecentlyDeleted--chromeCompanion" data-h2o-chrome-recently-deleted-companion="1" style="display:flex;flex-direction:column;gap:8px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.018);padding:12px 14px">
          <div style="font-size:11px;color:rgba(255,255,255,.64);letter-spacing:.04em;text-transform:uppercase">Recently Deleted</div>
          <div class="wbState" style="padding:0;text-align:left">Chrome Recently Deleted companion is unavailable.</div>
        </section>
      `;
      return false;
    }
  }
  if (!api || typeof api.renderRecentlyDeletedFoldersPanel !== "function") {
    host.innerHTML = `
      <section class="wbFolderRecentlyDeleted wbFolderRecentlyDeleted--main" data-h2o-recently-deleted-folders="main" style="display:flex;flex-direction:column;gap:8px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.018);padding:12px 14px">
        <div style="font-size:11px;color:rgba(255,255,255,.64);letter-spacing:.04em;text-transform:uppercase">Recently Deleted</div>
        <div class="wbState" style="padding:0;text-align:left">Recently Deleted diagnostics are loading.</div>
      </section>
    `;
    return false;
  }
  try {
    await api.renderRecentlyDeletedFoldersPanel(host, { placement: "main" });
    return true;
  } catch (error) {
    console.warn("[H2O.Studio] Recently Deleted main panel failed", error);
    host.innerHTML = `
      <section class="wbFolderRecentlyDeleted wbFolderRecentlyDeleted--main" data-h2o-recently-deleted-folders="main" style="display:flex;flex-direction:column;gap:8px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.018);padding:12px 14px">
        <div style="font-size:11px;color:rgba(255,255,255,.64);letter-spacing:.04em;text-transform:uppercase">Recently Deleted</div>
        <div class="wbState" style="padding:0;text-align:left">Recently Deleted diagnostics are unavailable.</div>
      </section>
    `;
    return false;
  }
}

function prepareVisibleStudioFoldersBody(){
  const listPanel = $("#viewListPanel");
  const listEl = $("#viewList");
  const readerEl = $("#viewReader");
  const libraryRegion = document.getElementById("wbLibraryRegion");
  try { W.H2O?.LibraryCore?.getService?.("page-host")?.showLibraryRegion?.(false); } catch {}
  if (libraryRegion) libraryRegion.hidden = true;
  if (listPanel) {
    listPanel.hidden = false;
    listPanel.removeAttribute("data-library-overlay");
  }
  if (readerEl) {
    readerEl.hidden = true;
    readerEl.removeAttribute("data-library-overlay");
  }
  const listTitle = $("#listTitle");
  const listSubtitle = $("#listSubtitle");
  const listFilters = $("#listFilters");
  if (listTitle) listTitle.textContent = "Folders";
  if (listSubtitle) listSubtitle.textContent = "Preparing folders...";
  if (listFilters) listFilters.innerHTML = "";
  setRouteMeta("Library", "Folders", "Library workspace · folders · labels · categories · projects · tags");
  return listEl;
}

function makeVisibleStudioFoldersFallbackModel(reason = "studio-sidebar-cache"){
  const cachedCanonical = normalizeFolderCatalog(state.folderCatalog);
  const canonicalRows = (cachedCanonical.length ? cachedCanonical : makeKnownCanonicalFolderCatalogFallback(reason))
    .map((row) => ({
      ...row,
      id: row.id || row.folderId,
      folderId: row.folderId || row.id,
      isCanonical: true,
      source: row.source || reason,
      nativeMembershipCount: Number(row.nativeMembershipCount ?? row.canonicalCount ?? row.knownCount ?? 0) || 0,
      knownCount: Number(row.knownCount ?? row.savedCount ?? 0) || 0,
    }))
    .filter((row) => row.folderId);
  const localReviewRows = normalizeFolderCatalog(state.folderLocalReview)
    .map((row) => ({
      ...row,
      id: row.id || row.folderId,
      folderId: row.folderId || row.id,
      isCanonical: false,
      source: row.source || reason,
      nativeMembershipCount: Number(row.nativeMembershipCount ?? row.canonicalCount ?? 0) || 0,
      knownCount: Number(row.knownCount ?? row.savedCount ?? 0) || 0,
    }))
    .filter((row) => row.folderId);
  return {
    readOnly: true,
    surface: STUDIO_isTauri() ? "desktop-studio" : "chrome-studio",
    generatedAt: new Date().toISOString(),
    canonicalSource: reason,
    fallbackUsed: true,
    fallbackModelUsed: true,
    folderCatalogReady: canonicalRows.length > 0,
    displayModelAvailable: canonicalRows.length > 0,
    storedModelAvailable: cachedCanonical.length > 0,
    nativeBroadcastRequired: false,
    renderBlockedReason: canonicalRows.length ? "" : "folder-display-model-empty",
    canonicalRows,
    localReviewRows,
  };
}

async function hydrateVisibleStudioFoldersRouteShell(force = false){
  if (!isVisibleStudioFoldersRoute()) return null;
  const view = state.lastView || "saved";
  const folderId = state.lastFolderId || "";
  const initialRows = Array.isArray(state.rowsCache) ? state.rowsCache.slice() : [];
  renderFolderSidebar(initialRows, view, folderId);
  renderSidebarChatList(filterRows(initialRows, view, "", folderId, state.lastTagFilter), view, folderId, "");
  const fetched = await promiseWithTimeoutFallback(
    fetchWorkbenchRows(!!force),
    STUDIO_ARCHIVE_TIMEOUT_MS,
    "fetchWorkbenchRows",
    Array.isArray(state.rowsCache) ? state.rowsCache.slice() : []
  );
  const rows = await promiseWithTimeoutFallback(
    enrichRowsWithFolderData(Array.isArray(fetched) ? fetched : [], !!force),
    STUDIO_BOOT_AUX_TIMEOUT_MS + 1000,
    "enrichRowsWithFolderData",
    Array.isArray(state.rowsCache) ? state.rowsCache.slice() : (Array.isArray(fetched) ? fetched : [])
  );
  await Promise.all([
    promiseWithTimeoutFallback(fetchFolderCatalog(false), STUDIO_BOOT_AUX_TIMEOUT_MS, "fetchFolderCatalog", { canonical: [], review: [] }),
    promiseWithTimeoutFallback(fetchLabelCatalog(!!force), STUDIO_BOOT_AUX_TIMEOUT_MS, "fetchLabelCatalog", []),
    promiseWithTimeoutFallback(fetchCategoryCatalog(!!force), STUDIO_BOOT_AUX_TIMEOUT_MS, "fetchCategoryCatalog", []),
  ]);
  if (!isVisibleStudioFoldersRoute()) return { rows };
  const safeRows = Array.isArray(rows) ? rows : [];
  renderFolderSidebar(safeRows, view, folderId);
  renderSidebarChatList(filterRows(safeRows, view, "", folderId, state.lastTagFilter), view, folderId, "");
  return { rows: safeRows };
}

async function renderVisibleStudioFoldersPageBody(opts = {}){
  const token = ++state.renderToken;
  setStudioRouteScope("library", { clearReader: true });
  setActiveNav(state.lastView || "saved");
  studioHostUnmountPreservingRouteHash("studio:library-folders-visible-body");
  const listEl = prepareVisibleStudioFoldersBody();
  if (listEl) {
    listEl.innerHTML = `
      <section class="wbFolderPage" data-h2o-folder-page="1" data-h2o-folder-page-owner="studio-js-visible-body" data-h2o-folder-page-status="loading" style="padding:16px 18px 24px">
        <div class="wbState">Loading folders...</div>
      </section>
    `;
  }
  const shellHydration = hydrateVisibleStudioFoldersRouteShell(!!opts.force).catch((error) => {
    try { console.warn("[H2O.Studio] folders route shell hydration failed", error); } catch {}
    return null;
  });

  const parity = W.H2O?.Library?.FolderParity;
  let model = opts.model && typeof opts.model === "object" ? opts.model : null;
  if (!model && typeof parity?.getDisplayModel !== "function") {
    model = makeVisibleStudioFoldersFallbackModel("folder-parity-api-loading");
    W.setTimeout(() => {
      if (isVisibleStudioFoldersRoute()) renderVisibleStudioFoldersPageBody({ force: true }).catch(console.warn);
    }, 800);
  }
  if (!model) {
    let modelPromise = null;
    try {
      modelPromise = parity.getDisplayModel({ fresh: opts.force !== false });
      model = await promiseWithTimeout(
        modelPromise,
        STUDIO_BOOT_AUX_TIMEOUT_MS,
        "FolderParity.getDisplayModel"
      );
    } catch (error) {
      if (token !== state.renderToken || !isVisibleStudioFoldersRoute()) return;
      if (modelPromise && typeof modelPromise.then === "function") {
        modelPromise.then((lateModel) => {
          if (!isVisibleStudioFoldersRoute()) return;
          renderVisibleStudioFoldersPageBody({ force: false, model: lateModel }).catch(console.warn);
        }).catch(() => {});
      }
      model = makeVisibleStudioFoldersFallbackModel("folder-parity-pending");
      let hasFallbackRows = (Array.isArray(model.canonicalRows) && model.canonicalRows.length)
        || (Array.isArray(model.localReviewRows) && model.localReviewRows.length);
      if (!hasFallbackRows) {
        await shellHydration.catch(() => null);
        model = makeVisibleStudioFoldersFallbackModel("folder-parity-pending");
        hasFallbackRows = (Array.isArray(model.canonicalRows) && model.canonicalRows.length)
          || (Array.isArray(model.localReviewRows) && model.localReviewRows.length);
      }
      if (!hasFallbackRows) {
        const waitingListEl = prepareVisibleStudioFoldersBody() || listEl;
        if (waitingListEl) {
          waitingListEl.innerHTML = `
            <section class="wbFolderPage" data-h2o-folder-page="1" data-h2o-folder-page-owner="studio-js-visible-body" data-h2o-folder-page-status="waiting" style="padding:16px 18px 24px">
              <div class="wbState">Preparing folder rows. FolderParity will refresh this page when ready.</div>
            </section>
          `;
        }
        W.setTimeout(() => {
          if (isVisibleStudioFoldersRoute()) renderVisibleStudioFoldersPageBody({ force: false }).catch(console.warn);
        }, 800);
        return;
      }
    }
  }
  if (!Array.isArray(model?.canonicalRows) || model.canonicalRows.length === 0) {
    const fallbackModel = makeVisibleStudioFoldersFallbackModel(String(model?.renderBlockedReason || "folder-display-model-empty"));
    if (Array.isArray(fallbackModel.canonicalRows) && fallbackModel.canonicalRows.length) model = fallbackModel;
  }
  if (token !== state.renderToken || !isVisibleStudioFoldersRoute()) return;
  const finalListEl = prepareVisibleStudioFoldersBody() || listEl;

  const canonicalRows = (Array.isArray(model?.canonicalRows) ? model.canonicalRows : [])
    .map((row) => normalizeVisibleStudioFolderPageRow({ ...row, isCanonical: true }, true))
    .filter(Boolean);
  const showLocalReview = folderLocalReviewUiEnabled();
  const rawReviewRows = Array.isArray(model?.localReviewRows) ? model.localReviewRows : [];
  const hiddenReviewRowCount = showLocalReview ? 0 : rawReviewRows.length;
  const reviewRows = (showLocalReview ? rawReviewRows : [])
    .map((row) => normalizeVisibleStudioFolderPageRow(row, false))
    .filter(Boolean);
  const unfiledRow = {
    id: FOLDER_FILTER_NONE,
    folderId: FOLDER_FILTER_NONE,
    name: "Unfiled",
    label: "Unfiled",
    displayCountLabel: `${countVisibleStudioUnfiledRows()} known here`,
    knownCount: countVisibleStudioUnfiledRows(),
    isUnfiled: true,
    isCanonical: false,
  };
  const page = document.createElement("section");
  page.className = "wbFolderPage";
  page.dataset.h2oFolderPage = "1";
  page.dataset.h2oFolderPageOwner = "studio-js-visible-body";
  page.dataset.h2oFolderPageStatus = canonicalRows.length ? "ready" : "empty";
  page.dataset.h2oFolderLocalReview = showLocalReview ? "operator" : "hidden";
  page.dataset.h2oFolderHiddenReviewRows = String(hiddenReviewRowCount);
  page.style.cssText = "padding:16px 18px 24px;display:flex;flex-direction:column;gap:14px;min-width:0";

  const summary = document.createElement("div");
  summary.className = "wbFolderPageSummary";
  summary.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;color:rgba(255,255,255,.62);font-size:12px;line-height:1.4";
  summary.innerHTML = `
    <span>${[
      pluralize(canonicalRows.length, showLocalReview ? "canonical folder" : "folder"),
      showLocalReview ? pluralize(reviewRows.length, "review row") : "",
    ].filter(Boolean).join(" · ")}</span>
    <span>${esc(String(model?.surface || "folder-parity"))}</span>
  `;
  page.appendChild(summary);

  const list = document.createElement("section");
  list.className = "wbFolderPageList";
  list.setAttribute("role", "list");
  list.style.cssText = "display:flex;flex-direction:column;min-width:0;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.025);overflow:hidden";
  const rowsToRender = canonicalRows.concat(unfiledRow);
  if (!canonicalRows.length) {
    const empty = document.createElement("div");
    empty.className = "wbState";
    empty.textContent = "Canonical folder rows are unavailable. Open ChatGPT to broadcast folders, then refresh FolderParity.";
    empty.style.padding = "22px";
    list.appendChild(empty);
  } else {
    rowsToRender.forEach((row) => list.appendChild(makeVisibleStudioFolderPageRow(row)));
  }
  page.appendChild(list);

  await appendVisibleStudioRecentlyDeletedFoldersPanel(page);

  if (reviewRows.length) {
    const review = document.createElement("section");
    review.className = "wbFolderPageReview";
    review.style.cssText = "display:flex;flex-direction:column;min-width:0;border:1px solid rgba(255,255,255,.07);border-radius:10px;background:rgba(255,255,255,.018);overflow:hidden";
    const head = document.createElement("div");
    head.textContent = `Local Review · ${reviewRows.length}`;
    head.style.cssText = "padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.07);font-size:11px;color:rgba(255,255,255,.55);letter-spacing:.04em;text-transform:uppercase";
    review.appendChild(head);
    reviewRows.forEach((row) => review.appendChild(makeVisibleStudioFolderPageRow(row)));
    page.appendChild(review);
  }

  const subtitle = $("#listSubtitle");
  if (subtitle) {
    subtitle.textContent = [
      pluralize(canonicalRows.length, showLocalReview ? "canonical folder" : "folder"),
      showLocalReview && reviewRows.length ? pluralize(reviewRows.length, "Local Review row") : "",
      model?.surface ? String(model.surface) : "",
    ].filter(Boolean).join(" · ");
  }
  if (finalListEl) {
    finalListEl.innerHTML = "";
    finalListEl.appendChild(page);
  }
}

async function renderRoute(opts = {}){
  /* Phase 1a Studio Ribbon — capture the resolved route here so the
   * try/finally tail can sync ribbon context exactly once regardless of
   * which branch returned early. Initialised null in case parseHash throws. */
  let __ribbonRoute = null;
  try {
  const route = parseHash();
  __ribbonRoute = route;
  try { settingsApplyConvergenceAccess(); } catch (_) { /* evaluation mode must never break routing */ }
  // Hide the migration / settings panels by default on every route change;
  // their respective renderers un-hide as needed. This avoids adding cleanup
  // calls inside every other render path.
  if (route.name !== "migrate") {
    const migratePanel = document.getElementById("viewMigratePanel");
    if (migratePanel) migratePanel.hidden = true;
  }
  if (route.name !== "settings") {
    settingsReleaseEmbeddedToolPanels();
    const settingsPanel = document.getElementById("viewSettingsPanel");
    if (settingsPanel) settingsPanel.hidden = true;
  }
  // Sidebar Settings highlight — active on /settings AND on /migrate/* since
  // those are reached from inside Settings. Doesn't touch any other nav item's
  // active state (Library, folders, etc. manage their own).
  try {
    const settingsNav = document.getElementById("wbStudioNavSettings");
    if (settingsNav) {
      const isSettingsScope = route.name === "settings" || route.name === "migrate";
      settingsNav.classList.toggle("active", isSettingsScope);
      if (isSettingsScope) settingsNav.setAttribute("aria-current", "page");
      else settingsNav.removeAttribute("aria-current");
    }
  } catch {}
  if (route.name === "library") {
    state.renderToken += 1;
    setStudioRouteScope("library", { clearReader: true });
    studioHostUnmountPreservingRouteHash("studio:route-library");
    // Library overlay is owned by S0F1d Library Insights and toggled by S0Z1f's
    // route subscriber. Most Library routes still bail out here so renderList
    // does not rewrite the hash back to "#/saved"; folders is the explicit
    // exception because the active runtime can show the static list body while
    // the overlay page is empty.
    const LIBRARY_TAB_LABELS = {
      dashboard: "Dashboard",
      analytics: "Analytics",
      explorer:  "Explorer",
      recents:   "Recents",
      saved:     "Saved",
      organize:  "Organize",
      detail:    "Detail",
    };
    const view = String(route.view || "dashboard").toLowerCase();
    const label = LIBRARY_TAB_LABELS[view] || (view ? view[0].toUpperCase() + view.slice(1) : "Dashboard");
    setRouteMeta("Library", label, "Library workspace · folders · labels · categories · projects · tags");
    if (view === "folders") {
      await renderVisibleStudioFoldersPageBody(opts);
    }
    return;
  }
  if (route.name === "read") {
    await renderReader(route.snapshotId);
    return;
  }
  if (route.name === "migrate") {
    state.renderToken += 1;
    setStudioRouteScope("migrate", { clearReader: true });
    studioHostUnmountPreservingRouteHash("studio:route-migrate");
    renderMigrateRoute(route.action);
    return;
  }
  if (route.name === "settings") {
    state.renderToken += 1;
    setStudioRouteScope("settings", { clearReader: true });
    studioHostUnmountPreservingRouteHash("studio:route-settings");
    await renderSettingsRoute(route);
    return;
  }
  await renderList(route.view, route.folderId, {
    ...opts,
    chatId: route.chatId,
    snapshotId: route.snapshotId,
  });
  } finally {
    /* Phase 1a Studio Ribbon — single guarded context sync. Runs after
     * every branch (read / library / migrate / settings / list) regardless
     * of which one returned early. The ribbon hides itself when chatType
     * resolves to null (Library / Settings / Migrate / list / snapshot
     * load failure) and shows itself when chatType resolves to 'saved'
     * (opened snapshot reader). The linked-reader placeholder has its own
     * narrow setContext call inside renderLinkedReaderPlaceholder() — it
     * is reached without a URL change so renderRoute does not fire for it.
     * Reads state.currentReaderSnapshot which renderReader has already
     * settled by the time await returns. */
    try {
      const __ribbon = W?.H2O?.Studio?.ribbon;
      if (__ribbon && typeof __ribbon.setContext === 'function') {
        const __r = __ribbonRoute;
        const __isRead = !!(__r && __r.name === 'read');
        const __snap = __isRead ? state.currentReaderSnapshot : null;
        const __hasSnap = !!(__snap && typeof __snap === 'object' && __snap.snapshotId);
        const __meta = (__hasSnap && __snap.meta && typeof __snap.meta === 'object') ? __snap.meta : null;
        const __title = __hasSnap ? String((__meta && __meta.title) || __snap.chatId || '') : null;
        __ribbon.setContext({
          route: __r && __r.name ? String(__r.name) : null,
          chatType: (__isRead && __hasSnap) ? 'saved' : null,
          snapshotId: __hasSnap ? String(__snap.snapshotId || '') : null,
          chatId: __hasSnap ? String(__snap.chatId || '') : null,
          /* Phase 1b — title for Copy title action. Saved snapshots have
           * no source URL field; originalUrl stays null. */
          title: __title || null,
          originalUrl: null,
          readOnly: false,
        });
      }
    } catch (_) { /* swallow — ribbon sync must never break routing */ }
  }
}

// ─── Migration UI (full-bundle export / import) ────────────────────────────
// Owned by the two #/migrate/* routes added in parseHash. Renders directly
// into .wbMain by hiding the list + reader panels and inserting a single
// migration panel. No new HTML/CSS needed — uses inline styles so the panel
// works without studio.css edits and is trivially removable.

function migrateOverlayEnsure(){
  const main = document.querySelector(".wbMain");
  if (!main) return null;
  let panel = document.getElementById("viewMigratePanel");
  if (!panel) {
    panel = document.createElement("section");
    panel.id = "viewMigratePanel";
    panel.className = "wbPanel wbPanel--migrate";
    panel.style.padding = "20px 24px";
    panel.style.maxWidth = "720px";
    panel.style.margin = "0 auto";
    panel.style.fontSize = "14px";
    panel.style.lineHeight = "1.5";
    main.appendChild(panel);
  }
  return panel;
}

function migrateRouteHideOtherPanels(){
  const listPanel = $("#viewListPanel");
  const readerEl = $("#viewReader");
  if (listPanel) listPanel.hidden = true;
  if (readerEl) readerEl.hidden = true;
}

function migrateDownloadJson(filename, obj){
  const json = JSON.stringify(obj, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = String(filename || "h2o-studio-bundle.json");
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { try { document.body.removeChild(a); } catch {} try { URL.revokeObjectURL(url); } catch {} }, 200);
}

// Studio talks to the SW directly through callArchive (it's the established
// transport seam). archiveBoot lives in S0D3a which is NOT loaded by the
// Studio surface (only S0D3e Transcript Studio Host is), so the migration UI
// invokes the SW ops directly here — same envelope as exportBundle /
// importBundle, just routing to exportFullBundle / importFullBundle.
function migrateGetArchiveBoot(){
  return {
    exportFullBundle: (opts = {}) => callArchive("exportFullBundle", opts || {}),
    dryRunImportFullBundle: ({ bundle } = {}) => callArchive("dryRunImportFullBundle", { bundle }),
    importFullBundle: ({ bundle, mode = "merge" } = {}) =>
      callArchive("importFullBundle", { bundle, mode: String(mode || "merge") }),
  };
}

function migrateExtensionLabel(){
  try {
    const id = chrome?.runtime?.id || "(unknown id)";
    const name = chrome?.runtime?.getManifest?.().name || "(unknown name)";
    const version = chrome?.runtime?.getManifest?.().version || "";
    return { id, name, version, label: `${name} · ${id}${version ? " · v" + version : ""}` };
  } catch {
    return { id: "", name: "", version: "", label: "(extension info unavailable)" };
  }
}

function migrateBuildTimestamp(){
  // ISO 8601 with seconds, safe for filenames.
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
}

// ─── Settings UI ──────────────────────────────────────────────────────────
// Sidebar entry-point that surfaces the existing #/migrate/* routes through a
// user-facing page. NO migration backend logic lives here — the buttons are
// just navigation links to routes that already work. Storage diagnostics show
// the active extension's identity (the same info that resolves the "data
// disappeared after switching builds" class of bug) plus a cheap saved-chat
// count via the existing listAllChatIds bridge op.

function settingsOverlayEnsure(){
  const main = document.querySelector(".wbMain");
  if (!main) return null;
  let panel = document.getElementById("viewSettingsPanel");
  if (!panel) {
    panel = document.createElement("section");
    panel.id = "viewSettingsPanel";
    panel.className = "wbPanel wbPanel--settings";
    panel.style.padding = "20px 24px";
    panel.style.maxWidth = "880px";
    panel.style.margin = "0 auto";
    panel.style.fontSize = "14px";
    panel.style.lineHeight = "1.55";
    // Settings uses .wbMain as the scroll root so the scrollbar stays at the
    // right pane edge instead of inside the settings card.
    panel.style.maxHeight = "none";
    panel.style.overflowY = "visible";
    panel.style.overscrollBehavior = "auto";
    panel.style.boxSizing = "border-box";
    main.appendChild(panel);
  }
  return panel;
}

function settingsPanelHasCurrentFolderCleanupReview(panel){
  if (!panel || !panel.firstChild) return false;
  const cleanupPanel = panel.querySelector("#wbSettingsFolderParityPanelCleanupReview");
  const cleanupReview = panel.querySelector("#wbSettingsFolderCleanupReview");
  if (!cleanupPanel || !cleanupReview) return false;
  const text = String(cleanupReview.textContent || "");
  if (!/Folder Cleanup Review/.test(text)) return false;
  if (!/Read-only:\s*no cleanup is performed/i.test(text)) return false;
  if (!panel.querySelector("[data-folder-cleanup-subtab='overview']")) return false;
  if (!panel.querySelector("[data-folder-cleanup-subpanel='dry-run']")) return false;
  if (!panel.querySelector("#wbSettingsFolderCleanupDryRunGenerate")) return false;
  if (!panel.querySelector("#wbSettingsFolderCleanupDryRunRows")) return false;
  const legacyMutationControls = [
    "#wbSettingsFolderCleanupDeleteBox",
    "#wbSettingsFolderCleanupDeleteSelected",
    "#wbSettingsFolderConflictDeleteBox",
    "#wbSettingsFolderConflictDeleteSelected",
    "#wbSettingsFolderDesktopDeleteBox",
    "#wbSettingsFolderDesktopDeleteSelected",
    "#wbSettingsFolderDesktopOrphanBindingRemoveBox",
    "#wbSettingsFolderDesktopOrphanBindingRemoveSelected",
  ];
  return !legacyMutationControls.some((selector) => panel.querySelector(selector));
}

function settingsHideOtherPanels(){
  const listPanel = $("#viewListPanel");
  const readerEl = $("#viewReader");
  const migratePanel = document.getElementById("viewMigratePanel");
  if (listPanel) listPanel.hidden = true;
  if (readerEl) readerEl.hidden = true;
  if (migratePanel) migratePanel.hidden = true;
}

const SETTINGS_SYNC_SUBROUTES = Object.freeze({
  status: { label: "Status", hash: "#/settings/sync/status" },
  outbox: { label: "Outbox", hash: "#/settings/sync/outbox" },
  inbox: { label: "Inbox", hash: "#/settings/sync/inbox" },
  relay: { label: "Relay", hash: "#/settings/sync/relay" },
  "proposal-review": { label: "Proposal Review", hash: "#/settings/sync/proposal-review" },
  "conflict-review": { label: "Conflict Review", hash: "#/settings/sync/conflict-review" },
  "apply-log": { label: "Apply Log", hash: "#/settings/sync/apply-log" },
  webdav: { label: "WebDAV", hash: "#/settings/sync/webdav" },
});

const SETTINGS_CONVERGENCE_SUBROUTES = Object.freeze({
  review: { label: "Review", hash: "#/settings/convergence/review" },
  color: { label: "Color", hash: "#/settings/convergence/color" },
  rename: { label: "Rename", hash: "#/settings/convergence/rename" },
  move: { label: "Move", hash: "#/settings/convergence/move" },
  delete: { label: "Delete", hash: "#/settings/convergence/delete" },
  binding: { label: "Binding", hash: "#/settings/convergence/binding" },
  snapshot: { label: "Snapshot", hash: "#/settings/convergence/snapshot" },
  "library-sync": { label: "Library Sync", hash: "#/settings/convergence/library-sync" },
  execute: { label: "Execute", hash: "#/settings/convergence/execute" },
});

const SETTINGS_TOP_LEVEL_ROUTES = Object.freeze({
  account: { label: "Account", hash: "#/settings/account" },
  library: { label: "Library", hash: "#/settings/library" },
  sync: { label: "Sync", hash: "#/settings/sync" },
  convergence: { label: "Convergence", hash: "#/settings/convergence" },
  diagnostics: { label: "Diagnostics", hash: "#/settings/diagnostics" },
  data: { label: "Data", hash: "#/settings/data" },
  about: { label: "About", hash: "#/settings/about" },
});

const SETTINGS_EMBEDDED_TOOL_PANEL_IDS = Object.freeze([
  "h2o-manual-sync-panel",
  "h2o-convergence-review-panel",
  "h2o-convergence-action-panel",
  "h2o-rename-convergence-panel",
  "h2o-move-convergence-panel",
  "h2o-delete-convergence-panel",
  "h2o-binding-convergence-panel",
  "h2o-snapshot-convergence-panel",
  "h2o-library-sync-operator-panel",
  "h2o-execute-lane-panel",
]);

const SETTINGS_EVALUATION_STORAGE_KEY = "h2o:studio:settings-migration-evaluation:v1";
const SETTINGS_EVALUATION_LAYOUTS = Object.freeze({
  auto: "Auto",
  legacy: "Legacy",
  new: "New",
});
const SETTINGS_EVALUATION_CONVERGENCE_ACCESS = Object.freeze({
  floating: "Floating",
  settings: "Settings",
  both: "Both",
});
const SETTINGS_EVALUATION_DEFAULTS = Object.freeze({
  settingsLayout: "new",
  convergenceAccess: "settings",
});
const SETTINGS_EVALUATION_PARITY_ROUTES = Object.freeze([
  ["Legacy Data & Migration - Export", "#/settings/data"],
  ["Legacy Data & Migration - Import", "#/settings/data"],
  ["Legacy Data & Migration - Backup", "#/settings/data"],
  ["Legacy Local Sync - Status / folder-state import", "#/settings/sync/status"],
  ["Floating Manual Sync - Sync Status", "#/settings/sync/status"],
  ["Floating Manual Sync - Outbox", "#/settings/sync/outbox"],
  ["Floating Manual Sync - Pull / Relay", "#/settings/sync/relay"],
  ["Floating Manual Sync - Inbox", "#/settings/sync/inbox"],
  ["Floating Manual Sync - Proposal Review", "#/settings/sync/proposal-review"],
  ["Floating Manual Sync - Conflict Review", "#/settings/sync/conflict-review"],
  ["Floating Manual Sync - Apply Log", "#/settings/sync/apply-log"],
  ["Legacy Folder Parity / Cleanup diagnostics", "#/settings/diagnostics/folder-parity"],
  ["Legacy Storage Diagnostics", "#/settings/diagnostics"],
  ["Floating Convergence Review", "#/settings/convergence/review"],
  ["Floating Color Convergence Action", "#/settings/convergence/color"],
  ["Floating Rename Convergence", "#/settings/convergence/rename"],
  ["Floating Move Convergence", "#/settings/convergence/move"],
  ["Floating Delete Convergence", "#/settings/convergence/delete"],
  ["Floating Binding Convergence", "#/settings/convergence/binding"],
  ["Snapshot Convergence", "#/settings/convergence/snapshot"],
  ["Library Sync Proof Status", "#/settings/convergence/library-sync"],
  ["Execute Lane", "#/settings/convergence/execute"],
]);

function settingsEvaluationNormalize(value, allowed, fallback){
  const key = String(value || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(allowed, key) ? key : fallback;
}

function settingsEvaluationRead(){
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(SETTINGS_EVALUATION_STORAGE_KEY) || "null"); }
  catch (_) { raw = null; }
  return {
    settingsLayout: settingsEvaluationNormalize(
      raw && raw.settingsLayout,
      SETTINGS_EVALUATION_LAYOUTS,
      SETTINGS_EVALUATION_DEFAULTS.settingsLayout
    ),
    convergenceAccess: settingsEvaluationNormalize(
      raw && raw.convergenceAccess,
      SETTINGS_EVALUATION_CONVERGENCE_ACCESS,
      SETTINGS_EVALUATION_DEFAULTS.convergenceAccess
    ),
  };
}

function settingsEvaluationWrite(patch = {}){
  const current = settingsEvaluationRead();
  const next = {
    settingsLayout: settingsEvaluationNormalize(
      patch.settingsLayout || current.settingsLayout,
      SETTINGS_EVALUATION_LAYOUTS,
      SETTINGS_EVALUATION_DEFAULTS.settingsLayout
    ),
    convergenceAccess: settingsEvaluationNormalize(
      patch.convergenceAccess || current.convergenceAccess,
      SETTINGS_EVALUATION_CONVERGENCE_ACCESS,
      SETTINGS_EVALUATION_DEFAULTS.convergenceAccess
    ),
  };
  try { localStorage.setItem(SETTINGS_EVALUATION_STORAGE_KEY, JSON.stringify(next)); }
  catch (_) { /* ignore local persistence failures */ }
  return next;
}

function settingsEvaluationResolvedLayout(){
  const layout = settingsEvaluationRead().settingsLayout;
  return layout === "auto" ? "new" : layout;
}

function settingsEvaluationUseNewSettings(){
  return settingsEvaluationResolvedLayout() !== "legacy";
}

function settingsEvaluationConvergenceAccess(){
  return settingsEvaluationRead().convergenceAccess;
}

function settingsEvaluationHostedConvergenceVisible(){
  return settingsEvaluationConvergenceAccess() !== "floating";
}

function settingsEvaluationFloatingConvergenceVisible(){
  const access = settingsEvaluationConvergenceAccess();
  return access === "floating" || access === "both";
}

function settingsEvaluationSelectHtml(field, current, options){
  return `
    <select data-settings-eval-field="${esc(field)}"
            style="min-width:128px;padding:6px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.18);color:inherit;font:inherit;font-size:12px">
      ${Object.keys(options).map((key) => `<option value="${esc(key)}" ${key === current ? "selected" : ""}>${esc(options[key])}</option>`).join("")}
    </select>
  `;
}

function settingsEvaluationParityTableHtml(){
  return `
    <details data-settings-evaluation-parity="1" style="border:1px solid rgba(255,255,255,.10);border-radius:10px;padding:10px;background:rgba(255,255,255,.025)">
      <summary style="cursor:pointer;font-weight:650">Feature parity map</summary>
      <div style="overflow:auto;margin-top:10px">
        <table style="width:100%;border-collapse:collapse;font-size:12px;line-height:1.45">
          <thead>
            <tr>
              <th style="text-align:left;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.10);opacity:.7">Legacy/Floating Feature</th>
              <th style="text-align:left;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.10);opacity:.7">New Settings Route</th>
            </tr>
          </thead>
          <tbody>
            ${SETTINGS_EVALUATION_PARITY_ROUTES.map(([feature, route]) => `
              <tr>
                <td style="padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.06)">${esc(feature)}</td>
                <td style="padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.06)"><a href="${esc(route)}" style="color:inherit">${esc(route)}</a></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </details>
  `;
}

function settingsEvaluationPanelHtml(){
  const state = settingsEvaluationRead();
  const resolved = settingsEvaluationResolvedLayout();
  return `
    <section class="wbSettingsCard" data-settings-evaluation-panel="1"
             style="display:flex;flex-direction:column;gap:10px;margin:0 0 16px;padding:14px 16px;border:1px solid rgba(96,165,250,.24);border-radius:12px;background:rgba(96,165,250,.055)">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div>
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.62;font-weight:700">Settings Evaluation</div>
          <div style="font-weight:650">Temporary migration comparison</div>
          <div style="opacity:.72;font-size:12px;line-height:1.45">Developer-only controls. No sync, convergence, parity, apply, or data behavior is changed.</div>
        </div>
        <div style="font-size:12px;opacity:.72">Auto resolves to <strong>${esc(SETTINGS_EVALUATION_LAYOUTS[resolved])}</strong></div>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:end">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px">
          <span style="opacity:.72">Settings Layout</span>
          ${settingsEvaluationSelectHtml("settingsLayout", state.settingsLayout, SETTINGS_EVALUATION_LAYOUTS)}
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px">
          <span style="opacity:.72">Convergence Access</span>
          ${settingsEvaluationSelectHtml("convergenceAccess", state.convergenceAccess, SETTINGS_EVALUATION_CONVERGENCE_ACCESS)}
        </label>
      </div>
      ${settingsEvaluationParityTableHtml()}
    </section>
  `;
}

function settingsBindEvaluationControls(panel){
  if (!panel || panel.dataset.settingsEvaluationBound === "1") return;
  panel.dataset.settingsEvaluationBound = "1";
  panel.addEventListener("change", (event) => {
    const target = event.target;
    const field = target?.getAttribute?.("data-settings-eval-field");
    if (!field || !panel.contains(target)) return;
    if (field !== "settingsLayout" && field !== "convergenceAccess") return;
    settingsEvaluationWrite({ [field]: target.value });
    settingsApplyConvergenceAccess();
    try {
      delete panel.dataset.settingsRendered;
      delete panel.dataset.settingsRenderedKey;
    } catch (_) { /* ignore */ }
    renderRoute().catch(console.error);
  }, true);
  panel.addEventListener("click", (event) => {
    const target = event.target?.closest?.("[data-settings-eval-set-convergence]");
    if (!target || !panel.contains(target)) return;
    event.preventDefault();
    const value = target.getAttribute("data-settings-eval-set-convergence");
    settingsEvaluationWrite({ convergenceAccess: value });
    settingsApplyConvergenceAccess();
    try {
      delete panel.dataset.settingsRendered;
      delete panel.dataset.settingsRenderedKey;
    } catch (_) { /* ignore */ }
    renderRoute().catch(console.error);
  }, true);
}

function settingsConvergenceLauncherSpecs(){
  const sync = W.H2O?.Desktop?.Sync || {};
  return [
    { id: "h2o-manual-sync-launcher", install: sync.installManualSyncLauncher, remove: sync.removeManualSyncLauncher },
    { id: "h2o-convergence-review-launcher", install: sync.installConvergenceReviewLauncher, remove: sync.removeConvergenceReviewLauncher },
    { id: "h2o-convergence-action-launcher", install: sync.installConvergenceActionLauncher, remove: sync.removeConvergenceActionLauncher },
    { id: "h2o-rename-convergence-launcher", install: sync.installRenameConvergenceLauncher, remove: sync.removeRenameConvergenceLauncher },
    { id: "h2o-move-convergence-launcher", install: sync.installMoveConvergenceLauncher, remove: sync.removeMoveConvergenceLauncher },
    { id: "h2o-delete-convergence-launcher", install: sync.installDeleteConvergenceLauncher, remove: sync.removeDeleteConvergenceLauncher },
    { id: "h2o-binding-convergence-launcher", install: sync.installBindingConvergenceLauncher, remove: sync.removeBindingConvergenceLauncher },
  ];
}

function settingsRemoveFloatingConvergenceLaunchers(){
  for (const spec of settingsConvergenceLauncherSpecs()) {
    try {
      if (typeof spec.remove === "function") spec.remove();
      else document.getElementById(spec.id)?.remove?.();
    } catch (_) {
      try { document.getElementById(spec.id)?.remove?.(); } catch (_) { /* ignore */ }
    }
  }
}

function settingsInstallFloatingConvergenceLaunchers(){
  if (!STUDIO_isTauri()) {
    settingsRemoveFloatingConvergenceLaunchers();
    return;
  }
  for (const spec of settingsConvergenceLauncherSpecs()) {
    if (typeof spec.install !== "function") continue;
    try { spec.install(); } catch (_) { /* launcher install must not break route rendering */ }
  }
}

function settingsApplyConvergenceAccess(){
  if (settingsEvaluationFloatingConvergenceVisible()) settingsInstallFloatingConvergenceLaunchers();
  else settingsRemoveFloatingConvergenceLaunchers();
}

function settingsEvaluationShellPrefixHtml(){
  return `<div class="wbSettingsEvaluationShellTop">${settingsEvaluationPanelHtml()}</div>`;
}

function settingsReleaseEmbeddedToolPanels(){
  const settingsPanel = document.getElementById("viewSettingsPanel");
  if (!settingsPanel || typeof document === "undefined" || !document.body) return;
  for (const id of SETTINGS_EMBEDDED_TOOL_PANEL_IDS) {
    const node = settingsPanel.querySelector("#" + id);
    if (!node) continue;
    try {
      node.removeAttribute("data-settings-hosted");
      node.remove();
    } catch (_) { /* ignore */ }
  }
}

function settingsNormalizeSubroute(section, subsection){
  const raw = String(subsection || "").toLowerCase();
  if (section === "sync") return SETTINGS_SYNC_SUBROUTES[raw] ? raw : "status";
  if (section === "convergence") return SETTINGS_CONVERGENCE_SUBROUTES[raw] ? raw : "review";
  return raw;
}

function settingsNavLinkHtml(label, hash, active){
  return `<a class="wbSettingsShellLink${active ? " isActive" : ""}" href="${esc(hash)}" ${active ? 'aria-current="page"' : ""}>${esc(label)}</a>`;
}

function settingsShellRailHtml(activeSection){
  const active = String(activeSection || "account").toLowerCase();
  return Object.keys(SETTINGS_TOP_LEVEL_ROUTES).map((key) => {
    if (key === "convergence" && !settingsEvaluationHostedConvergenceVisible()) return "";
    const item = SETTINGS_TOP_LEVEL_ROUTES[key];
    return settingsNavLinkHtml(item.label, item.hash, key === active);
  }).join("");
}

function settingsSubnavHtml(section, activeSubroute){
  const map = section === "sync" ? SETTINGS_SYNC_SUBROUTES : SETTINGS_CONVERGENCE_SUBROUTES;
  return Object.keys(map).map((key) => settingsNavLinkHtml(map[key].label, map[key].hash, key === activeSubroute)).join("");
}

function settingsDiagnosticsSubnavHtml(activeSubroute){
  const active = String(activeSubroute || "storage").toLowerCase();
  return [
    settingsNavLinkHtml("Storage", "#/settings/diagnostics", active === "storage"),
    settingsNavLinkHtml("Folder Parity", "#/settings/diagnostics/folder-parity", active === "folder-parity"),
  ].join("");
}

function settingsTopLevelMeta(section){
  const meta = {
    account: {
      title: "Account",
      eyebrow: "Identity and preferences",
      description: "Account-facing Settings shell. Identity and preference controls can be migrated here without changing runtime behavior.",
    },
    library: {
      title: "Library",
      eyebrow: "Library workspace",
      description: "Library settings shell for folders, chats, snapshots, captures, labels, and categories.",
    },
    diagnostics: {
      title: "Diagnostics",
      eyebrow: "Storage diagnostics",
      description: "Read-only runtime and storage diagnostics. No sync, convergence, or apply behavior is changed here.",
    },
    data: {
      title: "Data",
      eyebrow: "Export, import, backup",
      description: "Existing Studio migration and backup entry points, grouped into the Settings shell.",
    },
    about: {
      title: "About",
      eyebrow: "Build and documentation",
      description: "Version, build-channel, and operator documentation placeholders for Studio.",
    },
  };
  return meta[section] || meta.account;
}

function settingsInfoCardHtml(title, body, actionHtml = "", cardStyle = ""){
  return `
    <div class="wbSettingsCard" style="${cardStyle}">
      <div style="font-weight:600">${esc(title)}</div>
      <div style="opacity:.72;font-size:12px;line-height:1.45;flex:1">${body}</div>
      ${actionHtml}
    </div>
  `;
}

function settingsDataSectionHtml(cardStyle, btnStyle){
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px">
      <div class="wbSettingsCard" style="${cardStyle}">
        <div style="font-weight:600">Export Studio Bundle</div>
        <div style="opacity:.7;font-size:12px;flex:1">Download a full JSON bundle of your chats, snapshots, folders, labels, categories, projects, highlights, library KV, and UI prefs. Auth tokens are never exported.</div>
        <a href="#/migrate/export" style="${btnStyle}">Open Export</a>
      </div>
      <div class="wbSettingsCard" style="${cardStyle}">
        <div style="font-weight:600">Import Studio Bundle</div>
        <div style="opacity:.7;font-size:12px;flex:1">Apply a previously exported bundle to this extension. The flow auto-backs-up current data and dry-runs before any write. Merge mode never overwrites existing records.</div>
        <a href="#/migrate/import" style="${btnStyle}">Open Import</a>
      </div>
      <div class="wbSettingsCard" style="${cardStyle}">
        <div style="font-weight:600">Backup Current Studio Data</div>
        <div style="opacity:.7;font-size:12px;flex:1">Generate a snapshot of this extension's Studio data right now. Same operation as Export; pair it with Import to migrate across extension IDs or restore from a known-good state.</div>
        <a href="#/migrate/export" style="${btnStyle}">Open Backup</a>
      </div>
    </div>
  `;
}

function settingsFolderOperatorModeDiagnosticsHtml(cardStyle, btnStyle, extraStyle = ""){
  const enabled = folderOperatorModeEnabled();
  const style = [cardStyle, extraStyle].filter(Boolean).join(";");
  const badgeStyle = [
    "display:inline-flex",
    "align-items:center",
    "border:1px solid " + (enabled ? "rgba(34,197,94,.44)" : "rgba(255,255,255,.12)"),
    "border-radius:999px",
    "padding:3px 8px",
    "font-size:11px",
    "line-height:1.2",
    "color:" + (enabled ? "rgba(187,247,208,.96)" : "rgba(255,255,255,.68)"),
    "background:" + (enabled ? "rgba(34,197,94,.14)" : "rgba(255,255,255,.045)"),
  ].join(";");
  return `
    <div class="wbSettingsCard" data-h2o-folder-operator-mode-ui="1" data-enabled="${enabled ? "true" : "false"}" style="${style}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div style="min-width:220px;display:flex;flex-direction:column;gap:4px">
          <div style="font-weight:600">Advanced Folder Operator Mode</div>
          <div style="opacity:.72;font-size:12px;line-height:1.45">${esc(FOLDER_OPERATOR_MODE_CONFIRM_TEXT)}</div>
        </div>
        <span data-h2o-folder-operator-mode-badge="1" style="${badgeStyle}">${enabled ? "Operator Mode ON" : "Operator Mode OFF"}</span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" data-h2o-folder-operator-mode-action="enable" style="${btnStyle}" ${enabled ? "disabled" : ""}>Enable Operator Mode</button>
        <button type="button" data-h2o-folder-operator-mode-action="disable" style="${btnStyle}" ${enabled ? "" : "disabled"}>Disable Operator Mode</button>
      </div>
    </div>
  `;
}

function syncFolderOperatorModeDiagnosticsUi(root = document){
  const enabled = folderOperatorModeEnabled();
  const nodes = Array.from(root?.querySelectorAll?.("[data-h2o-folder-operator-mode-ui='1']") || []);
  nodes.forEach((node) => {
    node.dataset.enabled = enabled ? "true" : "false";
    const badge = node.querySelector("[data-h2o-folder-operator-mode-badge='1']");
    if (badge) {
      badge.textContent = enabled ? "Operator Mode ON" : "Operator Mode OFF";
      badge.style.borderColor = enabled ? "rgba(34,197,94,.44)" : "rgba(255,255,255,.12)";
      badge.style.color = enabled ? "rgba(187,247,208,.96)" : "rgba(255,255,255,.68)";
      badge.style.background = enabled ? "rgba(34,197,94,.14)" : "rgba(255,255,255,.045)";
    }
    const enableBtn = node.querySelector("[data-h2o-folder-operator-mode-action='enable']");
    const disableBtn = node.querySelector("[data-h2o-folder-operator-mode-action='disable']");
    if (enableBtn) {
      enableBtn.disabled = enabled;
      enableBtn.setAttribute("aria-disabled", enabled ? "true" : "false");
    }
    if (disableBtn) {
      disableBtn.disabled = !enabled;
      disableBtn.setAttribute("aria-disabled", enabled ? "false" : "true");
    }
  });
}

function rerenderSettingsFolderOperatorModeRoute(){
  const panel = document.getElementById("viewSettingsPanel");
  if (!panel || panel.hidden) return;
  const route = parseHash();
  if (!route || route.name !== "settings") return;
  panel.dataset.settingsRendered = "";
  delete panel.dataset.syncControlsBound;
  renderSettingsRoute(route).catch((err) => console.warn("[H2O.Studio] Folder operator Settings refresh failed", err));
}

function settingsBindFolderOperatorModeControls(panel){
  if (!panel) return;
  syncFolderOperatorModeDiagnosticsUi(panel);
  if (panel.dataset.folderOperatorModeControlsBound === "1") return;
  panel.dataset.folderOperatorModeControlsBound = "1";
  panel.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-h2o-folder-operator-mode-action]");
    if (!button || !panel.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    const action = String(button.getAttribute("data-h2o-folder-operator-mode-action") || "").trim();
    if (action === "enable") {
      if (!W.confirm(FOLDER_OPERATOR_MODE_CONFIRM_TEXT)) return;
      setFolderOperatorModeEnabled(true);
      return;
    }
    if (action === "disable") {
      setFolderOperatorModeEnabled(false);
    }
  }, true);
}

function settingsStorageDiagnosticsHtml(meta, cardStyle){
  return `
    <div id="wbSettingsDiagBox" class="wbSettingsCard" style="${cardStyle}">
      <div style="display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace">
        <div style="opacity:.6">Extension ID</div>           <div id="wbSettingsDiagId">${esc(meta.id || "(unavailable)")}</div>
        <div style="opacity:.6">Extension name</div>         <div id="wbSettingsDiagName">${esc(meta.name || "(unavailable)")}</div>
        <div style="opacity:.6">Version</div>                <div id="wbSettingsDiagVersion">${esc(meta.version || "(unavailable)")}</div>
        <div style="opacity:.6">Saved chats</div>            <div id="wbSettingsDiagChats">(loading...)</div>
        <div style="opacity:.6">Build channel</div>          <div id="wbSettingsDiagBuild">(loading...)</div>
      </div>
      <div id="wbSettingsDiagWarn" style="margin-top:8px;font-size:12px;opacity:.75" hidden></div>
    </div>
    <div style="margin-top:8px;font-size:12px;opacity:.6">
      Tip: each Chrome extension ID has its own isolated <code>chrome.storage.local</code> and IndexedDB. If your data ever disappears after rebuilding from a new path, it is usually still alive under the previous extension ID. Use Data -> Import on the old extension's bundle to restore.
    </div>
  `;
}

function settingsArchiveHealthCardHtml(cardStyle){
  return `
    <section data-settings-archive-health-section="1">
      <h3 style="margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;opacity:.65">Saved Chat Archive Health</h3>
      <div id="wbSettingsArchiveHealthBox" class="wbSettingsCard" style="${cardStyle}"></div>
    </section>
  `;
}

function settingsLegacySyncStatusHtml(cardStyle, btnStyle){
  return `
    <div id="wbSettingsSyncBox" class="wbSettingsCard" style="${cardStyle}">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div>
          <div id="wbSettingsSyncTitle" style="font-weight:600">Desktop to Chrome Sync</div>
          <div id="wbSettingsSyncSummary" style="opacity:.7;font-size:12px">Reading sync status...</div>
        </div>
        <button id="wbSettingsSyncRefresh" type="button" style="${btnStyle}">Refresh Status</button>
      </div>
      <div id="wbSettingsSyncStatus" style="display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace"></div>
      <div id="wbSettingsSyncDesktopControls" style="display:none;gap:8px;flex-wrap:wrap">
        <button id="wbSettingsSyncExportLatest" type="button" style="${btnStyle}">Write latest.json</button>
        <button id="wbSettingsSyncEnableDesktopAuto" type="button" style="${btnStyle}">Enable Auto Export</button>
        <button id="wbSettingsSyncDisableDesktopAuto" type="button" style="${btnStyle}">Disable Auto Export</button>
        <button id="wbSettingsSyncEnableDesktopFocusImport" type="button" style="${btnStyle}" title="When this Studio window gains focus or becomes visible, scan the configured sync folder once and import any new bundles (chrome-latest.json, latest.json, etc.) through the existing merge-only path. Behind feature flag sync.desktopImportOnFocus. 30s minimum interval. No polling, no watcher.">Enable Import on Focus</button>
        <button id="wbSettingsSyncDisableDesktopFocusImport" type="button" style="${btnStyle}">Disable Import on Focus</button>
      </div>
      <div id="wbSettingsSyncFolderStateImport" style="display:none;flex-direction:column;gap:8px;padding-top:10px;margin-top:4px;border-top:1px solid rgba(255,255,255,.06)">
        <div style="font-size:12px;opacity:.7;line-height:1.4">
          Import a manually captured Chrome/Studio folder-state JSON file. Routes through
          <code>H2O.Studio.sync.importFromFile()</code>; folder-only payloads take the
          <code>importFolderStateOnly</code> fast path. Read-only on the source file; no Chrome
          write-back, no daemon, no bidirectional sync.
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input id="wbSettingsSyncFolderStatePath" type="text" spellcheck="false" autocomplete="off"
                 value="/Users/hobayda/H2O Studio Sync/real-folder-state.json"
                 placeholder="/absolute/path/to/folder-state.json"
                 style="flex:1;min-width:240px;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.18);color:inherit;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px" />
          <button id="wbSettingsSyncFolderStatePickBtn" type="button" style="${btnStyle}" title="Open native file picker to select a folder-state JSON">Choose file...</button>
          <button id="wbSettingsSyncFolderStateImportBtn" type="button" style="${btnStyle}">Import folder-state</button>
        </div>
      </div>
      <div id="wbSettingsSyncChromeControls" style="display:none;gap:8px;flex-wrap:wrap">
        <button id="wbSettingsSyncConnectFolder" type="button" style="${btnStyle}">Connect Folder</button>
        <button id="wbSettingsSyncDisconnectFolder" type="button" style="${btnStyle}">Disconnect</button>
        <button id="wbSettingsSyncNow" type="button" style="${btnStyle}">Sync Now</button>
        <button id="wbSettingsSyncChromeExportNow" type="button" style="${btnStyle}" title="Write h2o.studio.fullBundle.v2 to chrome-latest.json in the connected sync folder. Requires Chrome export to be enabled.">Export to Desktop sync folder</button>
        <button id="wbSettingsSyncEnableChromeAuto" type="button" style="${btnStyle}">Enable Auto Sync</button>
        <button id="wbSettingsSyncDisableChromeAuto" type="button" style="${btnStyle}">Disable Auto Sync</button>
        <button id="wbSettingsSyncEnableChromeAutoExport" type="button" style="${btnStyle}" title="Enable Chrome export to write chrome-latest.json, and wire library changes to trigger debounced exportNow(). 2s debounce. No polling.">Enable Chrome Export</button>
        <button id="wbSettingsSyncDisableChromeAutoExport" type="button" style="${btnStyle}">Disable Chrome Export</button>
      </div>
      <pre id="wbSettingsSyncLog" style="white-space:pre-wrap;background:rgba(0,0,0,.18);padding:10px;border-radius:6px;max-height:160px;overflow:auto;font-size:12px;line-height:1.45;margin:0" hidden></pre>
    </div>
  `;
}

function settingsTopLevelContentHtml(section, cardStyle, btnStyle, meta){
  if (section === "data") return settingsDataSectionHtml(cardStyle, btnStyle);
  if (section === "diagnostics") {
    return `
      <div style="display:flex;flex-direction:column;gap:12px">
        ${settingsStorageDiagnosticsHtml(meta, cardStyle)}
        ${settingsArchiveHealthCardHtml(cardStyle)}
        ${settingsArchiveRequestDeliveryCardHtml(cardStyle)}
        ${settingsFolderOperatorModeDiagnosticsHtml(cardStyle, btnStyle)}
        ${settingsInfoCardHtml(
          "Folder Parity Diagnostics",
          "Existing Folder Parity, Folder Cleanup, Desktop Mirror Refresh, conflict review, orphan binding review, and Operations / Proofs diagnostics.",
          `<a href="#/settings/diagnostics/folder-parity" style="${btnStyle}">Open Folder Parity</a>`,
          cardStyle
        )}
      </div>
    `;
  }
  if (section === "library") {
    return `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
        ${settingsInfoCardHtml("Folders", "Library folder controls remain in the Library workspace. This Settings section is a safe shell placeholder for future library preferences.", `<a href="#/library/folders" style="${btnStyle}">Open Library Folders</a>`, cardStyle)}
        ${settingsInfoCardHtml("Chats and Snapshots", "Saved chats, snapshots, captures, labels, and categories are not moved in this repair. No Library data behavior changes.", `<a href="#/library/dashboard" style="${btnStyle}">Open Library</a>`, cardStyle)}
      </div>
    `;
  }
  if (section === "about") {
    return `
      <div style="display:flex;flex-direction:column;gap:12px">
        ${settingsStorageDiagnosticsHtml(meta, cardStyle)}
        ${settingsInfoCardHtml("Documentation", "About/documentation links can be added here in a later phase. This repair only establishes the global Settings shell.", "", cardStyle)}
      </div>
    `;
  }
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
      ${settingsInfoCardHtml("Account Identity", "Account-specific controls are not migrated yet. This placeholder preserves the approved Settings shell route without adding account behavior.", "", cardStyle)}
      ${settingsInfoCardHtml("Preferences", "Preference controls can be moved here later. This repair does not change current preferences, sync, diagnostics, or convergence behavior.", "", cardStyle)}
    </div>
  `;
}

function settingsToolSpec(section, subsection){
  if (section === "sync") {
    if (subsection === "webdav") {
      return {
        title: "WebDAV",
        eyebrow: "Transport setup",
        description: "Prepare the Desktop WebDAV resolver configuration. Setup only: no probe, no sync, no write.",
        panelId: "wbRealTransportWebDavSetupSubtab",
        open: () => W.H2O?.Studio?.sync?.realTransportWebDavSetupUi?.openSettingsSubtab?.(),
      };
    }
    return {
      title: "Sync",
      eyebrow: "Manual relay tools",
      description: "Existing manual sync UI, hosted inside Settings. Manual only: no automatic sync, no convergence, no apply.",
      panelId: "h2o-manual-sync-panel",
      open: () => W.H2O?.Desktop?.Sync?.openManualSyncPanel?.(),
      filter: () => settingsFocusManualSyncSection(subsection),
    };
  }
  const convergence = {
    review: {
      title: "Convergence Review",
      description: "Existing read-only convergence review panel hosted inside Settings.",
      panelId: "h2o-convergence-review-panel",
      open: () => W.H2O?.Desktop?.Sync?.openConvergenceReview?.(),
    },
    color: {
      title: "Color Convergence",
      description: "Existing color convergence action panel hosted inside Settings.",
      panelId: "h2o-convergence-action-panel",
      open: () => W.H2O?.Desktop?.Sync?.openConvergenceActionPanel?.(),
    },
    rename: {
      title: "Rename Convergence",
      description: "Existing rename convergence action panel hosted inside Settings.",
      panelId: "h2o-rename-convergence-panel",
      open: () => W.H2O?.Desktop?.Sync?.openRenameConvergencePanel?.(),
    },
    move: {
      title: "Move Convergence",
      description: "Existing move convergence action panel hosted inside Settings.",
      panelId: "h2o-move-convergence-panel",
      open: () => W.H2O?.Desktop?.Sync?.openMoveConvergencePanel?.(),
    },
    delete: {
      title: "Delete Convergence",
      description: "Existing delete convergence action panel hosted inside Settings.",
      panelId: "h2o-delete-convergence-panel",
      open: () => W.H2O?.Desktop?.Sync?.openDeleteConvergencePanel?.(),
    },
    binding: {
      title: "Binding Convergence",
      description: "Existing binding convergence action panel hosted inside Settings.",
      panelId: "h2o-binding-convergence-panel",
      open: () => W.H2O?.Desktop?.Sync?.openBindingConvergencePanel?.(),
    },
    snapshot: {
      title: "Snapshot Convergence",
      description: "Read-only snapshot convergence evidence panel hosted inside Settings.",
      panelId: "h2o-snapshot-convergence-panel",
      open: () => W.H2O?.Desktop?.Sync?.openSnapshotConvergencePanel?.({ settingsHosted: true }),
    },
    "library-sync": {
      title: "Library Sync",
      description: "Read-only Library Sync proof and status panel hosted inside Settings.",
      panelId: "h2o-library-sync-operator-panel",
      open: () => W.H2O?.Desktop?.Sync?.openLibrarySyncOperatorPanel?.({ settingsHosted: true }),
    },
    execute: {
      title: "Execute Lane",
      description: "Read-only Execute Lane operator visibility panel hosted inside Settings.",
      panelId: "h2o-execute-lane-panel",
      open: () => W.H2O?.Desktop?.Sync?.openExecuteLanePanel?.({ settingsHosted: true }),
    },
  };
  const item = convergence[subsection] || convergence.review;
  return {
    eyebrow: "Convergence tools",
    ...item,
  };
}

function renderSettingsToolShell(panel, section, subsection){
  const spec = settingsToolSpec(section, subsection);
  const syncActive = section === "sync";
  const convActive = section === "convergence";
  const cardStyle = "display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.02)";
  const btnStyle = "padding:8px 14px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:inherit;font:inherit;text-decoration:none;display:inline-block";
  const statusHtml = syncActive && subsection === "status" ? settingsLegacySyncStatusHtml(cardStyle, btnStyle) : "";
  panel.innerHTML = `
    ${settingsEvaluationShellPrefixHtml()}
    <div class="wbSettingsShell">
      <nav class="wbSettingsShellRail" aria-label="Settings sections">
        ${settingsShellRailHtml(section)}
      </nav>
      <section class="wbSettingsShellMain" aria-label="${esc(spec.title)}">
        <div class="wbSettingsShellHeader">
          <div>
            <div class="wbSettingsShellEyebrow">${esc(spec.eyebrow)}</div>
            <h2 class="wbSettingsShellTitle">${esc(spec.title)}</h2>
            <p class="wbSettingsShellCopy">${esc(spec.description)}</p>
          </div>
        </div>
        <nav class="wbSettingsSubnav" aria-label="${syncActive ? "Sync" : "Convergence"} tools">
          ${settingsSubnavHtml(section, subsection)}
        </nav>
        ${statusHtml}
        <div id="wbSettingsEmbeddedToolHost" class="wbSettingsEmbeddedTool" data-settings-tool-section="${esc(section)}" data-settings-tool-subroute="${esc(subsection)}">
          <div class="wbSettingsCard wbSettingsEmbeddedLoading">Opening existing ${esc(spec.title)} panel…</div>
        </div>
      </section>
    </div>
  `;
  settingsBindEvaluationControls(panel);
}

function settingsFocusManualSyncSection(subsection){
  const host = document.getElementById("wbSettingsEmbeddedToolHost");
  if (!host) return;
  const panel = host.querySelector("#h2o-manual-sync-panel");
  if (!panel) return;
  const sectionMatchers = {
    status: [/Sync Status/i],
    outbox: [/Outbox/i],
    inbox: [/Inbox/i],
    relay: [/Pull/i],
    "proposal-review": [/Proposal Review/i],
    "conflict-review": [/Conflict Review/i],
    "apply-log": [/Apply Log/i],
  };
  const matchers = sectionMatchers[subsection] || sectionMatchers.status;
  const sections = Array.from(panel.querySelectorAll(".h2oSyncSection"));
  for (const section of sections) {
    const summary = section.querySelector("summary");
    const label = String(summary && summary.textContent || "");
    const visible = matchers.some((re) => re.test(label));
    section.hidden = !visible;
    section.style.display = visible ? "" : "none";
    if (visible) {
      try { section.open = true; } catch (_) { /* ignore */ }
    }
  }
}

function settingsInstallManualSyncFilter(host, subsection){
  if (!host || typeof MutationObserver !== "function") return;
  try { host.__h2oSettingsManualSyncObserver?.disconnect?.(); } catch {}
  let pending = false;
  const run = () => {
    pending = false;
    settingsFocusManualSyncSection(subsection);
  };
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    Promise.resolve().then(run);
  });
  observer.observe(host, { childList: true, subtree: true });
  host.__h2oSettingsManualSyncObserver = observer;
}

async function settingsMountEmbeddedTool(section, subsection){
  const host = document.getElementById("wbSettingsEmbeddedToolHost");
  if (!host) return;
  const spec = settingsToolSpec(section, subsection);
  try {
    if (!STUDIO_isTauri()) {
      host.innerHTML = `<div class="wbSettingsCard wbSettingsEmbeddedLoading">This Settings-hosted ${esc(spec.title)} panel is available in Desktop Studio.</div>`;
      return;
    }
    if (typeof spec.open !== "function" || !W.H2O?.Desktop?.Sync) {
      host.innerHTML = `<div class="wbSettingsCard wbSettingsEmbeddedLoading">${esc(spec.title)} API is not installed in this runtime.</div>`;
      return;
    }
    if (section === "sync" && subsection === "webdav") {
      const existingWebDavPanel = document.getElementById(spec.panelId);
      if (existingWebDavPanel && existingWebDavPanel.parentElement === host) {
        existingWebDavPanel.setAttribute("data-settings-hosted", "true");
        return;
      }
      W.H2O?.Studio?.sync?.realTransportWebDavSetupUi?.captureDraft?.();
      host.innerHTML = "";
      const mounted = await spec.open();
      const webDavPanel = document.getElementById(spec.panelId);
      if (!mounted || !webDavPanel) {
        host.innerHTML = `<div class="wbSettingsCard wbSettingsEmbeddedLoading">${esc(spec.title)} panel did not mount.</div>`;
        return;
      }
      webDavPanel.setAttribute("data-settings-hosted", "true");
      return;
    }
    await spec.open();
    const toolPanel = document.getElementById(spec.panelId);
    if (!toolPanel) {
      host.innerHTML = `<div class="wbSettingsCard wbSettingsEmbeddedLoading">${esc(spec.title)} panel did not mount.</div>`;
      return;
    }
    host.innerHTML = "";
    toolPanel.setAttribute("data-settings-hosted", "true");
    host.appendChild(toolPanel);
    if (section === "sync" && subsection !== "webdav") {
      settingsFocusManualSyncSection(subsection);
      settingsInstallManualSyncFilter(host, subsection);
    }
  } catch (err) {
    host.innerHTML = `<div class="wbSettingsCard wbSettingsEmbeddedLoading">Failed to open ${esc(spec.title)}: ${esc(err && (err.message || err))}</div>`;
  }
}

async function renderSettingsToolRoute(panel, route){
  const section = String(route && route.section || "").toLowerCase();
  const subsection = settingsNormalizeSubroute(section, route && route.subsection);
  const routeKey = section + "/" + subsection;
  if (panel.dataset.settingsRendered === "1" && panel.dataset.settingsRenderedKey === routeKey && panel.firstChild) {
    if (section === "sync" && subsection === "status") settingsBindLegacySyncStatus(panel);
    await settingsMountEmbeddedTool(section, subsection);
    return;
  }
  panel.dataset.settingsRendered = "1";
  panel.dataset.settingsRenderedKey = routeKey;
  delete panel.dataset.syncControlsBound;
  renderSettingsToolShell(panel, section, subsection);
  if (section === "sync" && subsection === "status") settingsBindLegacySyncStatus(panel);
  await settingsMountEmbeddedTool(section, subsection);
}

function settingsBindLegacySyncStatus(panel){
  if (!panel || !panel.querySelector("#wbSettingsSyncBox")) return;
  bindSettingsSyncControls(panel);
  refreshSettingsSync(panel).catch((err) => settingsSyncLog(panel, String(err && (err.stack || err.message || err))));
  STUDIO_settingsReadFolderStateLastPath().then((stored) => {
    if (!stored) return;
    const input = panel.querySelector("#wbSettingsSyncFolderStatePath");
    if (input) input.value = stored;
  }).catch(() => { /* ignore */ });
}

function mountSettingsArchiveHealthCard(panel){
  try {
    const archiveHealthBox = panel?.querySelector?.("#wbSettingsArchiveHealthBox");
    if (!archiveHealthBox || archiveHealthBox.dataset.archiveHealthMounted === "1") return;
    const archiveHealthUi = W?.H2O?.Studio?.archiveHealthUi;
    if (archiveHealthUi && typeof archiveHealthUi.renderArchiveHealthCard === "function") {
      archiveHealthUi.renderArchiveHealthCard(archiveHealthBox, {
        diagnose: (opts) => W?.H2O?.Studio?.ingestion?.diagnoseSavedChatArchiveV1?.(opts),
        diagnoseOptions: { includeCasChecks: true, includeRendererChecks: true, includeDbChecks: true, limit: 500 },
      });
      archiveHealthBox.dataset.archiveHealthMounted = "1";
    } else {
      archiveHealthBox.textContent = "Archive diagnostics are available in Desktop Studio only.";
    }
  } catch (_) { /* read-only diagnostics card must never break Settings */ }
}

/* Phase D.3C.2 — mount the manual Chrome archive-request delivery utility card.
   Renders only into its own box; never repaints Settings, never touches the
   Archive Health card, and degrades to a "Chrome Studio only" message when the
   delivery APIs are absent (e.g. on Desktop). */
function mountSettingsArchiveRequestDeliveryCard(panel){
  try {
    const box = panel?.querySelector?.("#wbSettingsArchiveRequestDeliveryBox");
    if (!box || box.dataset.archiveRequestDeliveryMounted === "1") return;
    const deliveryUi = W?.H2O?.Studio?.archiveRequestDeliveryUi;
    if (deliveryUi && typeof deliveryUi.renderArchiveRequestDeliveryCard === "function") {
      deliveryUi.renderArchiveRequestDeliveryCard(box);
      box.dataset.archiveRequestDeliveryMounted = "1";
    } else {
      box.textContent = "Archive request delivery is available in Chrome Studio only.";
    }
  } catch (_) { /* manual delivery utility card must never break Settings */ }
}

function renderSettingsSectionShell(panel, section){
  const key = SETTINGS_TOP_LEVEL_ROUTES[section] ? section : "account";
  const meta = settingsTopLevelMeta(key);
  const extensionMeta = migrateExtensionLabel();
  const cardStyle = "display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.02)";
  const btnStyle = "padding:8px 14px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:inherit;font:inherit;text-decoration:none;display:inline-block";
  panel.innerHTML = `
    ${settingsEvaluationShellPrefixHtml()}
    <div class="wbSettingsShell">
      <nav class="wbSettingsShellRail" aria-label="Settings sections">
        ${settingsShellRailHtml(key)}
      </nav>
      <section class="wbSettingsShellMain" aria-label="${esc(meta.title)}">
        <div class="wbSettingsShellHeader">
          <div>
            <div class="wbSettingsShellEyebrow">${esc(meta.eyebrow)}</div>
            <h2 class="wbSettingsShellTitle">${esc(meta.title)}</h2>
            <p class="wbSettingsShellCopy">${esc(meta.description)}</p>
          </div>
        </div>
        ${key === "diagnostics" ? `<nav class="wbSettingsSubnav" aria-label="Diagnostics tools">${settingsDiagnosticsSubnavHtml("storage")}</nav>` : ""}
        <div class="wbSettingsSectionBody" data-settings-section="${esc(key)}">
          ${settingsTopLevelContentHtml(key, cardStyle, btnStyle, extensionMeta)}
        </div>
      </section>
    </div>
  `;
  settingsBindEvaluationControls(panel);
  settingsBindFolderOperatorModeControls(panel);
  if (key === "diagnostics") mountSettingsArchiveHealthCard(panel);
  if (key === "diagnostics") mountSettingsArchiveRequestDeliveryCard(panel);
  if (key === "diagnostics" || key === "about") refreshSettingsDiagnostics(panel);
}

/* Phase D.3C.2 — minimal manual Chrome delivery utility. Separate card from the
   read-only Archive Health card above; the delivery UI module renders its
   diagnostics + manual buttons into this box under an explicit user gesture. */
function settingsArchiveRequestDeliveryCardHtml(cardStyle){
  return `
    <section data-settings-archive-request-delivery-section="1">
      <h3 style="margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;opacity:.65">Archive Request Delivery</h3>
      <div id="wbSettingsArchiveRequestDeliveryBox" class="wbSettingsCard" style="${cardStyle}"></div>
    </section>
  `;
}

async function renderSettingsTopLevelRoute(panel, route){
  const section = SETTINGS_TOP_LEVEL_ROUTES[String(route && route.section || "").toLowerCase()]
    ? String(route.section).toLowerCase()
    : "account";
  const routeKey = section;
  if (panel.dataset.settingsRendered === "1" && panel.dataset.settingsRenderedKey === routeKey && panel.firstChild) {
    if (section === "diagnostics") mountSettingsArchiveHealthCard(panel);
    if (section === "diagnostics") mountSettingsArchiveRequestDeliveryCard(panel);
    if (section === "diagnostics" || section === "about") refreshSettingsDiagnostics(panel);
    return;
  }
  panel.dataset.settingsRendered = "1";
  panel.dataset.settingsRenderedKey = routeKey;
  delete panel.dataset.syncControlsBound;
  renderSettingsSectionShell(panel, section);
}

function settingsWrapFolderParityRoute(panel, parityNode){
  const cardStyle = "display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.02)";
  const btnStyle = "padding:8px 14px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:inherit;font:inherit;text-decoration:none;display:inline-block";
  const fallback = `
    <div class="wbSettingsCard" style="${cardStyle}">
      Folder Parity diagnostics could not mount because the legacy Folder Parity panel was not rendered.
    </div>
  `;
  panel.innerHTML = `
    ${settingsEvaluationShellPrefixHtml()}
    <div class="wbSettingsShell">
      <nav class="wbSettingsShellRail" aria-label="Settings sections">
        ${settingsShellRailHtml("diagnostics")}
      </nav>
      <section class="wbSettingsShellMain" aria-label="Folder Parity Diagnostics">
        <div class="wbSettingsShellHeader">
          <div>
            <div class="wbSettingsShellEyebrow">Diagnostics</div>
            <h2 class="wbSettingsShellTitle">Folder Parity</h2>
            <p class="wbSettingsShellCopy">Existing Folder Parity and Folder Cleanup diagnostics, mounted inside the Settings shell without changing parity behavior.</p>
          </div>
        </div>
        <nav class="wbSettingsSubnav" aria-label="Diagnostics tools">
          ${settingsDiagnosticsSubnavHtml("folder-parity")}
        </nav>
        <div class="wbSettingsSectionBody" data-settings-section="diagnostics" data-settings-subsection="folder-parity">
          ${settingsFolderOperatorModeDiagnosticsHtml(cardStyle, btnStyle)}
          <div id="wbSettingsFolderParityHost" style="display:flex;flex-direction:column;gap:12px">
            ${parityNode ? "" : fallback}
          </div>
        </div>
      </section>
    </div>
  `;
  const host = panel.querySelector("#wbSettingsFolderParityHost");
  if (host && parityNode) host.appendChild(parityNode);
  settingsBindEvaluationControls(panel);
  settingsBindFolderOperatorModeControls(panel);
  panel.dataset.settingsRendered = "1";
  panel.dataset.settingsRenderedKey = "diagnostics/folder-parity";
  delete panel.dataset.syncControlsBound;
  settingsFolderParityEnsureTabBinding(panel);
  bindSettingsSyncControls(panel);
  refreshSettingsFolderParity(panel).catch((err) => {
    settingsFolderParitySetOperationStatus(panel, "folderDiagnostics", "failed", "Refresh failed");
    settingsFolderParityLog(panel, String(err && (err.stack || err.message || err)));
  });
}

function renderSettingsHostedConvergenceHidden(panel, route){
  const subsection = settingsNormalizeSubroute("convergence", route && route.subsection);
  const spec = settingsToolSpec("convergence", subsection);
  const btnStyle = "padding:8px 14px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:inherit;font:inherit;text-decoration:none;display:inline-block";
  panel.dataset.settingsRendered = "1";
  panel.dataset.settingsRenderedKey = "convergence-hidden/" + subsection;
  delete panel.dataset.syncControlsBound;
  panel.innerHTML = `
    ${settingsEvaluationShellPrefixHtml()}
    <div class="wbSettingsShell">
      <nav class="wbSettingsShellRail" aria-label="Settings sections">
        ${settingsShellRailHtml("convergence")}
      </nav>
      <section class="wbSettingsShellMain" aria-label="${esc(spec.title)} hidden">
        <div class="wbSettingsShellHeader">
          <div>
            <div class="wbSettingsShellEyebrow">Convergence access</div>
            <h2 class="wbSettingsShellTitle">${esc(spec.title)}</h2>
            <p class="wbSettingsShellCopy">Settings-hosted convergence is hidden while Convergence Access is set to Floating. Floating launchers remain the active convergence entry points.</p>
          </div>
        </div>
        <div class="wbSettingsCard" style="display:flex;flex-direction:column;gap:10px;padding:16px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.02)">
          <div style="font-weight:600">Settings-hosted convergence hidden</div>
          <div style="opacity:.72;font-size:12px;line-height:1.45">Switch Convergence Access to Settings or Both to show the Settings-hosted convergence panels again. No convergence behavior is changed by this evaluation mode.</div>
          <button type="button" data-settings-eval-set-convergence="both" style="${btnStyle};width:max-content">Show both access modes</button>
        </div>
      </section>
    </div>
  `;
  settingsBindEvaluationControls(panel);
}

async function renderSettingsRoute(route = { section: "account", subsection: "" }){
  settingsHideOtherPanels();
  const settingsSection = String(route && route.section || "account").toLowerCase();
  const isSyncToolRoute = settingsSection === "sync";
  const isConvergenceToolRoute = settingsSection === "convergence";
  const isFolderParityRoute = settingsSection === "diagnostics"
    && String(route && route.subsection || "").toLowerCase() === "folder-parity";
  setRouteMeta("Settings", "Studio Settings", "Studio configuration · data & migration · storage diagnostics");
  const panel = settingsOverlayEnsure();
  if (!panel) return;
  panel.hidden = false;
  settingsApplyConvergenceAccess();
  if (isConvergenceToolRoute) {
    if (!settingsEvaluationHostedConvergenceVisible()) {
      renderSettingsHostedConvergenceHidden(panel, route);
      return;
    }
    await renderSettingsToolRoute(panel, route);
    return;
  }
  if (settingsEvaluationUseNewSettings()) {
    if (isSyncToolRoute) {
      await renderSettingsToolRoute(panel, route);
      return;
    }
    if (!isFolderParityRoute) {
      await renderSettingsTopLevelRoute(panel, route);
      return;
    }
  }
  settingsFolderParityEnsureTabBinding(panel);

  // Idempotency: same guard as renderMigrateRoute (focus / visibilitychange
  // re-enters renderRoute and would otherwise wipe the panel on every
  // window-focus event). Rebuild if the active Settings DOM was mounted by an
  // older bundle, otherwise the Cleanup / Review tab can keep stale content
  // while diagnostics refresh normally.
  if (panel.dataset.settingsRendered === "1" && panel.firstChild) {
    if (settingsPanelHasCurrentFolderCleanupReview(panel)) {
      refreshSettingsDiagnostics(panel);
      return;
    }
    panel.dataset.settingsRendered = "";
  }
  panel.dataset.settingsRendered = "1";
  delete panel.dataset.syncControlsBound;
  panel.innerHTML = "";

  const meta = migrateExtensionLabel();
  const cardStyle = "display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.02)";
  const sectionTitleStyle = "margin:0 0 12px;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;opacity:.65";
  const btnStyle = "padding:8px 14px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:inherit;font:inherit;text-decoration:none;display:inline-block";
  const folderOperatorMode = folderOperatorModeEnabled();
  if (!folderOperatorMode && (FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "local-review" || FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "cleanup-review")) {
    FOLDER_PARITY_SETTINGS_UI_STATE.activeTab = "overview";
  }

  panel.innerHTML = `
    <h2 style="margin:0 0 4px;font-size:22px;font-weight:600">Studio Settings</h2>
    <div style="margin:0 0 24px;opacity:.7;font-size:12px">Studio configuration, data tools, and diagnostics.</div>

    <h3 style="${sectionTitleStyle}">Data &amp; Migration</h3>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin:0 0 28px">
      <div class="wbSettingsCard" style="${cardStyle}">
        <div style="font-weight:600">Export Studio Bundle</div>
        <div style="opacity:.7;font-size:12px;flex:1">Download a full JSON bundle of your chats, snapshots, folders, labels, categories, projects, highlights, library KV, and UI prefs. Auth tokens are never exported.</div>
        <a href="#/migrate/export" style="${btnStyle}">Open Export</a>
      </div>
      <div class="wbSettingsCard" style="${cardStyle}">
        <div style="font-weight:600">Import Studio Bundle</div>
        <div style="opacity:.7;font-size:12px;flex:1">Apply a previously exported bundle to this extension. The flow auto-backs-up current data and dry-runs before any write. Merge mode never overwrites existing records.</div>
        <a href="#/migrate/import" style="${btnStyle}">Open Import</a>
      </div>
      <div class="wbSettingsCard" style="${cardStyle}">
        <div style="font-weight:600">Backup Current Studio Data</div>
        <div style="opacity:.7;font-size:12px;flex:1">Generate a snapshot of <em>this</em> extension's Studio data right now. Same operation as Export — pair it with Import to migrate across extension IDs or restore from a known-good state.</div>
        <a href="#/migrate/export" style="${btnStyle}">Open Backup</a>
      </div>
    </div>

    <h3 style="${sectionTitleStyle}">Local Sync</h3>
    <div id="wbSettingsSyncBox" class="wbSettingsCard" style="${cardStyle};margin:0 0 28px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div>
          <div id="wbSettingsSyncTitle" style="font-weight:600">Desktop to Chrome Sync</div>
          <div id="wbSettingsSyncSummary" style="opacity:.7;font-size:12px">Reading sync status…</div>
        </div>
        <button id="wbSettingsSyncRefresh" type="button" style="${btnStyle}">Refresh Status</button>
      </div>
      <div id="wbSettingsSyncStatus" style="display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace"></div>
      <div id="wbSettingsFolderSyncHealthDashboard" style="display:flex;flex-direction:column;gap:10px;padding-top:10px;margin-top:4px;border-top:1px solid rgba(255,255,255,.08)">
        <div style="opacity:.7;font-size:12px">Reading Folder Sync Health diagnostics...</div>
      </div>
      <div id="wbSettingsSyncDesktopControls" style="display:none;gap:8px;flex-wrap:wrap">
        <button id="wbSettingsSyncExportLatest" type="button" style="${btnStyle}">Write latest.json</button>
        <button id="wbSettingsSyncEnableDesktopAuto" type="button" style="${btnStyle}">Enable Auto Export</button>
        <button id="wbSettingsSyncDisableDesktopAuto" type="button" style="${btnStyle}">Disable Auto Export</button>
        <button id="wbSettingsSyncEnableDesktopFocusImport" type="button" style="${btnStyle}" title="When this Studio window gains focus or becomes visible, scan the configured sync folder once and import any new bundles (chrome-latest.json, latest.json, etc.) through the existing merge-only path. Behind feature flag sync.desktopImportOnFocus. 30s minimum interval. No polling, no watcher.">Enable Import on Focus</button>
        <button id="wbSettingsSyncDisableDesktopFocusImport" type="button" style="${btnStyle}">Disable Import on Focus</button>
      </div>
      <div id="wbSettingsSyncFolderStateImport" style="display:none;flex-direction:column;gap:8px;padding-top:10px;margin-top:4px;border-top:1px solid rgba(255,255,255,.06)">
        <div style="font-size:12px;opacity:.7;line-height:1.4">
          Import a manually captured Chrome/Studio folder-state JSON file. Routes through
          <code>H2O.Studio.sync.importFromFile()</code>; folder-only payloads take the
          <code>importFolderStateOnly</code> fast path. Read-only on the source file; no Chrome
          write-back, no daemon, no bidirectional sync.
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input id="wbSettingsSyncFolderStatePath" type="text" spellcheck="false" autocomplete="off"
                 value="/Users/hobayda/H2O Studio Sync/real-folder-state.json"
                 placeholder="/absolute/path/to/folder-state.json"
                 style="flex:1;min-width:240px;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.18);color:inherit;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px" />
          <button id="wbSettingsSyncFolderStatePickBtn" type="button" style="${btnStyle}" title="Open native file picker to select a folder-state JSON">Choose file…</button>
          <button id="wbSettingsSyncFolderStateImportBtn" type="button" style="${btnStyle}">Import folder-state</button>
        </div>
      </div>
      <div id="wbSettingsSyncChromeControls" style="display:none;gap:8px;flex-wrap:wrap">
        <button id="wbSettingsSyncConnectFolder" type="button" style="${btnStyle}">Connect Folder</button>
        <button id="wbSettingsSyncDisconnectFolder" type="button" style="${btnStyle}">Disconnect</button>
        <button id="wbSettingsSyncNow" type="button" style="${btnStyle}">Sync Now</button>
        <button id="wbSettingsSyncChromeExportNow" type="button" style="${btnStyle}" title="Write h2o.studio.fullBundle.v2 to chrome-latest.json in the connected sync folder. Requires Chrome export to be enabled.">Export to Desktop sync folder</button>
        <button id="wbSettingsSyncEnableChromeAuto" type="button" style="${btnStyle}">Enable Auto Sync</button>
        <button id="wbSettingsSyncDisableChromeAuto" type="button" style="${btnStyle}">Disable Auto Sync</button>
        <button id="wbSettingsSyncEnableChromeAutoExport" type="button" style="${btnStyle}" title="Enable Chrome export to write chrome-latest.json, and wire library changes to trigger debounced exportNow(). 2s debounce. No polling.">Enable Chrome Export</button>
        <button id="wbSettingsSyncDisableChromeAutoExport" type="button" style="${btnStyle}">Disable Chrome Export</button>
      </div>
      <pre id="wbSettingsSyncLog" style="white-space:pre-wrap;background:rgba(0,0,0,.18);padding:10px;border-radius:6px;max-height:160px;overflow:auto;font-size:12px;line-height:1.45;margin:0" hidden></pre>
    </div>

    <h3 style="${sectionTitleStyle}">Saved Chat Archive Health</h3>
    <div id="wbSettingsArchiveHealthBox" class="wbSettingsCard" style="${cardStyle};margin:0 0 28px"></div>

    <h3 style="${sectionTitleStyle}">Folder Parity</h3>
    <div id="wbSettingsFolderParityBox" class="wbSettingsCard" style="${cardStyle};margin:0 0 28px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div>
          <div style="font-weight:600">Folder Parity</div>
          <div id="wbSettingsFolderParitySummary" style="opacity:.7;font-size:12px">Reading read-only folder parity diagnostics…</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="wbSettingsFolderParityRefresh" type="button" style="${btnStyle}">Refresh diagnostics</button>
          <button id="wbSettingsFolderParityCopy" type="button" style="${btnStyle}">Copy report JSON</button>
        </div>
      </div>
      <div id="wbSettingsFolderParityTabs" role="tablist" aria-label="Folder Parity sections" style="display:flex;gap:6px;flex-wrap:wrap;padding-top:4px">
        <button type="button" data-folder-parity-tab="overview" role="tab" aria-selected="${FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "overview" ? "true" : "false"}" style="${settingsFolderParityPanelTabStyle(FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "overview")}">Overview</button>
        <button type="button" data-folder-parity-tab="canonical" role="tab" aria-selected="${FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "canonical" ? "true" : "false"}" style="${settingsFolderParityPanelTabStyle(FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "canonical")}">Canonical Folders</button>
        ${folderOperatorMode ? `<button type="button" data-folder-parity-tab="local-review" role="tab" aria-selected="${FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "local-review" ? "true" : "false"}" style="${settingsFolderParityPanelTabStyle(FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "local-review")}">Local Review</button>` : ""}
        <button type="button" data-folder-parity-tab="mirror-refresh" role="tab" aria-selected="${FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "mirror-refresh" ? "true" : "false"}" style="${settingsFolderParityPanelTabStyle(FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "mirror-refresh")}">Mirror Refresh</button>
        ${folderOperatorMode ? `<button type="button" data-folder-parity-tab="cleanup-review" role="tab" aria-selected="${FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "cleanup-review" ? "true" : "false"}" style="${settingsFolderParityPanelTabStyle(FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "cleanup-review")}">Cleanup / Review</button>` : ""}
        <button type="button" data-folder-parity-tab="operations" role="tab" aria-selected="${FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "operations" ? "true" : "false"}" style="${settingsFolderParityPanelTabStyle(FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "operations")}">Operations / Proofs</button>
      </div>
      <div id="wbSettingsFolderParityPanelOverview" data-folder-parity-panel="overview" ${FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "overview" ? "" : "hidden"} style="display:flex;flex-direction:column;gap:10px">
        ${settingsFolderSectionTabsHtml("parity-overview", [
          { id: "summary", label: "Summary" },
          { id: "counts", label: "Counts" },
          { id: "diagnostics", label: "Diagnostics" },
          { id: "risks", label: "Risks" },
        ], "summary")}
        <div ${settingsFolderSectionPanelAttrs("parity-overview", "summary", "summary")}>
        <div id="wbSettingsFolderParityHealth" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px"></div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("parity-overview", "counts", "summary")}>
        <div id="wbSettingsFolderParityOverviewMeta" style="display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace"></div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("parity-overview", "diagnostics", "summary")}>
        <div id="wbSettingsFolderParityStatus" style="display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace"></div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("parity-overview", "risks", "summary")}>
        <div id="wbSettingsFolderParityWarn" style="font-size:12px;opacity:.72">Read-only. No cleanup performed. Cleanup requires reviewed approval.</div>
        </div>
      </div>
      <div id="wbSettingsFolderParityPanelCanonical" data-folder-parity-panel="canonical" ${FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "canonical" ? "" : "hidden"} style="display:flex;flex-direction:column;gap:8px">
        ${settingsFolderSectionTabsHtml("parity-canonical", [
          { id: "rows", label: "Rows" },
          { id: "counts", label: "Counts" },
          { id: "conflicts", label: "Conflicts" },
          { id: "json", label: "JSON" },
        ], "rows")}
        <div ${settingsFolderSectionPanelAttrs("parity-canonical", "rows", "rows")}>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div>
            <div style="font-weight:600">Canonical Folders</div>
            <div style="opacity:.72;font-size:12px">The native-owned canonical six with local known-here counts and visual source.</div>
          </div>
          <div data-folder-parity-status="canonicalRows">${settingsFolderParityStatusBadgeHtml("not-tested")}</div>
        </div>
        <div id="wbSettingsFolderParityCanonicalRows" style="display:flex;flex-direction:column;gap:7px"></div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("parity-canonical", "counts", "rows")}>
          <div style="font-size:12px;opacity:.76;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:8px">Canonical folder counts are read-only and refresh through FolderParity diagnostics. Use Rows for the live canonical count labels.</div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("parity-canonical", "conflicts", "rows")}>
          <div style="font-size:12px;opacity:.76;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:8px">Duplicate names are review-only. Case and English imported duplicates stay outside the canonical list and must never be merged by name.</div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("parity-canonical", "json", "rows")}>
          <div style="font-size:12px;opacity:.76;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:8px">Use Copy report JSON from the Folder Parity header for the current canonical diagnostics JSON. This section is read-only.</div>
        </div>
      </div>
      <div id="wbSettingsFolderParityPanelLocalReview" data-folder-parity-panel="local-review" data-h2o-folder-operator-only="1" ${folderOperatorMode && FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "local-review" ? "" : "hidden"} style="display:${folderOperatorMode && FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "local-review" ? "flex" : "none"};flex-direction:column;gap:8px">
        ${settingsFolderSectionTabsHtml("parity-local-review", [
          { id: "review-rows", label: "Review Rows" },
          { id: "extra-rows", label: "Extra Rows" },
          { id: "test-rows", label: "Test Rows" },
          { id: "conflicts", label: "Conflicts" },
        ], "review-rows")}
        <div ${settingsFolderSectionPanelAttrs("parity-local-review", "review-rows", "review-rows")}>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div>
            <div style="font-weight:600">Local Review</div>
            <div style="opacity:.72;font-size:12px">Non-canonical folders are review-only and must stay out of the main canonical list.</div>
          </div>
          <div id="wbSettingsFolderParityLocalReviewSummary">${settingsFolderParityStatusBadgeHtml("not-tested")}</div>
        </div>
        <div id="wbSettingsFolderParityLists" style="display:flex;flex-direction:column;gap:6px;font-size:13px"></div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("parity-local-review", "extra-rows", "review-rows")}>
          <div style="font-size:12px;opacity:.76;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:8px">Extra local rows are preserved for review. They are not canonical and are not cleanup permission.</div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("parity-local-review", "test-rows", "review-rows")}>
          <div style="font-size:12px;opacity:.76;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:8px">RT, Empty, and F5D rows are test candidates only after exact-ID reviewed planning. No cleanup is performed here.</div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("parity-local-review", "conflicts", "review-rows")}>
          <div style="font-size:12px;opacity:.76;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:8px">Same-name conflicts such as Case and English are review-only. Never merge by folder name.</div>
        </div>
      </div>
      <div id="wbSettingsFolderParityPanelMirrorRefresh" data-folder-parity-panel="mirror-refresh" ${FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "mirror-refresh" ? "" : "hidden"} style="display:flex;flex-direction:column;gap:8px">
      <div id="wbSettingsFolderMirrorRefresh" style="${STUDIO_isTauri() ? "display:flex" : "display:none"};flex-direction:column;gap:8px;padding:10px;margin-top:0;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px">
        ${settingsFolderSectionTabsHtml("parity-mirror-refresh", [
          { id: "input", label: "Input" },
          { id: "preview", label: "Preview" },
          { id: "confirmation", label: "Confirmation" },
          { id: "result", label: "Result" },
        ], "input")}
        <div ${settingsFolderSectionPanelAttrs("parity-mirror-refresh", "input", "input")}>
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
            <div style="font-weight:600">Refresh Desktop folder mirror</div>
            <div data-folder-parity-status="mirrorRefresh">${settingsFolderParityStatusBadgeHtml("not-tested")}</div>
          </div>
          <div id="wbSettingsFolderMirrorRefreshSummary" style="opacity:.72;font-size:12px">Refreshes only this Desktop mirror key from a reviewed folder-state JSON. Desktop SQLite folders and bindings are not changed.</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input id="wbSettingsFolderMirrorRefreshPath" type="text" spellcheck="false" autocomplete="off"
                 value="${esc(FOLDER_DESKTOP_MIRROR_REFRESH_STATE.path || "")}"
                 placeholder="/absolute/path/to/folder-state.json"
                 style="flex:1;min-width:240px;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.18);color:inherit;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px" />
          <button id="wbSettingsFolderMirrorRefreshPick" type="button" style="${btnStyle}">Choose file...</button>
        </div>
        <textarea id="wbSettingsFolderMirrorRefreshJson" spellcheck="false" autocomplete="off"
                  placeholder="Or paste raw Native/Chrome folder-state JSON here"
                  style="min-height:76px;resize:vertical;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.18);color:inherit;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px">${esc(FOLDER_DESKTOP_MIRROR_REFRESH_STATE.pastedJson || "")}</textarea>
        </div>
        <div ${settingsFolderSectionPanelAttrs("parity-mirror-refresh", "preview", "input")}>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button id="wbSettingsFolderMirrorRefreshPreview" type="button" style="${btnStyle}">Preview Desktop mirror refresh</button>
          <button id="wbSettingsFolderMirrorRefreshCopyPlan" type="button" style="${btnStyle}">Copy refresh plan JSON</button>
        </div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("parity-mirror-refresh", "confirmation", "input")}>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px">
          <span style="opacity:.72">Type <code>${esc(FOLDER_DESKTOP_MIRROR_REFRESH_CONFIRM_TEXT)}</code> to enable mirror refresh.</span>
          <input id="wbSettingsFolderMirrorRefreshConfirm" type="text" autocomplete="off" spellcheck="false"
                 value="${esc(FOLDER_DESKTOP_MIRROR_REFRESH_STATE.confirmation || "")}"
                 style="padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.18);color:inherit;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px" />
        </label>
        <button id="wbSettingsFolderMirrorRefreshRun" type="button" style="${btnStyle}" disabled>Refresh Desktop folder mirror</button>
        </div>
        <div ${settingsFolderSectionPanelAttrs("parity-mirror-refresh", "result", "input")}>
        <div id="wbSettingsFolderMirrorRefreshStatus" style="font-size:12px;opacity:.72">${esc(FOLDER_DESKTOP_MIRROR_REFRESH_STATE.status || "Desktop mirror only. Native, Chrome, folders, and folder_bindings are not changed.")}</div>
        <div id="wbSettingsFolderMirrorRefreshDeltaSummary" style="display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:1.45" hidden></div>
        <pre id="wbSettingsFolderMirrorRefreshPreviewOut" style="white-space:pre-wrap;background:rgba(0,0,0,.18);padding:10px;border-radius:6px;max-height:180px;overflow:auto;font-size:12px;line-height:1.45;margin:0" hidden></pre>
        </div>
      </div>
      </div>
      <div id="wbSettingsFolderParityPanelCleanupReview" data-folder-parity-panel="cleanup-review" data-h2o-folder-operator-only="1" ${folderOperatorMode && FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "cleanup-review" ? "" : "hidden"} style="display:${folderOperatorMode && FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "cleanup-review" ? "flex" : "none"};flex-direction:column;gap:10px">
      <div id="wbSettingsFolderCleanupReview" style="display:flex;flex-direction:column;gap:10px;padding-top:12px;margin-top:4px;border-top:1px solid rgba(255,255,255,.08)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div>
            <h4 id="wbSettingsFolderCleanupReviewTitle" data-h2o-folder-cleanup-review-title="1" style="margin:0;font-size:14px;font-weight:600">Folder Cleanup Review</h4>
            <div id="wbSettingsFolderCleanupReviewSummary" style="opacity:.7;font-size:12px">Read-only: no cleanup is performed.</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button id="wbSettingsFolderCleanupReviewRefresh" type="button" style="${btnStyle}">Refresh review</button>
            <button id="wbSettingsFolderCleanupReviewCopy" type="button" style="${btnStyle}">Copy review report JSON</button>
          </div>
        </div>
        <div id="wbSettingsFolderCleanupSubtabs" role="tablist" aria-label="Folder Cleanup Review sections" style="display:flex;gap:6px;flex-wrap:wrap">
          <button type="button" data-folder-cleanup-subtab="overview" role="tab" aria-selected="${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "overview" ? "true" : "false"}" style="${settingsFolderCleanupSubtabStyle(FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "overview")}">Overview</button>
          <button type="button" data-folder-cleanup-subtab="candidates" role="tab" aria-selected="${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "candidates" ? "true" : "false"}" style="${settingsFolderCleanupSubtabStyle(FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "candidates")}">Candidates</button>
          <button type="button" data-folder-cleanup-subtab="dry-run" role="tab" aria-selected="${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "dry-run" ? "true" : "false"}" style="${settingsFolderCleanupSubtabStyle(FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "dry-run")}">Dry-run Plan</button>
          <button type="button" data-folder-cleanup-subtab="apply-preview" role="tab" aria-selected="${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "apply-preview" ? "true" : "false"}" style="${settingsFolderCleanupSubtabStyle(FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "apply-preview")}">Preview Gate</button>
          <button type="button" data-folder-cleanup-subtab="conflicts" role="tab" aria-selected="${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "conflicts" ? "true" : "false"}" style="${settingsFolderCleanupSubtabStyle(FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "conflicts")}">Conflicts</button>
          <button type="button" data-folder-cleanup-subtab="desktop" role="tab" aria-selected="${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "desktop" ? "true" : "false"}" style="${settingsFolderCleanupSubtabStyle(FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "desktop")}">Desktop</button>
          <button type="button" data-folder-cleanup-subtab="orphans" role="tab" aria-selected="${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "orphans" ? "true" : "false"}" style="${settingsFolderCleanupSubtabStyle(FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "orphans")}">Orphans</button>
        </div>
        <div data-folder-cleanup-subpanel="overview" ${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "overview" ? "" : "hidden"} style="display:${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "overview" ? "flex" : "none"};flex-direction:column;gap:8px">
        ${settingsFolderSectionTabsHtml("cleanup-overview", [
          { id: "summary", label: "Summary" },
          { id: "safety", label: "Safety Rules" },
          { id: "counts", label: "Counts" },
          { id: "risks", label: "Current Risks" },
        ], "summary")}
        <div ${settingsFolderSectionPanelAttrs("cleanup-overview", "summary", "summary")}>
        <div style="font-size:12px;opacity:.72">No cleanup is performed. Use the Candidates and Dry-run Plan subtabs to inspect a reviewed no-mutation plan before any future implementation phase.</div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("cleanup-overview", "safety", "summary")}>
        <div style="font-size:12px;opacity:.76;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:8px">
          Read-only: this panel only renders FolderParity diagnostics. It does not delete, merge, repair, normalize, write Chrome storage, write Desktop SQLite, call Native owner operations, or mutate folder mirrors.
        </div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("cleanup-overview", "counts", "summary")}>
        <div id="wbSettingsFolderCleanupReviewChips" style="display:flex;gap:8px;flex-wrap:wrap;font-size:12px"></div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("cleanup-overview", "risks", "summary")}>
        <div style="font-size:12px;opacity:.76;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:8px">Duplicate names, test/import rows, and orphan memberships are diagnostic risks only. They are not deletion permission.</div>
        </div>
        </div>
        <div data-folder-cleanup-subpanel="candidates" ${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "candidates" ? "" : "hidden"} style="display:${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "candidates" ? "flex" : "none"};flex-direction:column;gap:8px">
        ${settingsFolderSectionTabsHtml("cleanup-candidates", [
          { id: "all", label: "All Candidates" },
          { id: "conflicts", label: "Conflicts" },
          { id: "tests", label: "Test Candidates" },
          { id: "preserve", label: "Preserve Canonical" },
          { id: "blocked", label: "Blocked / Review Only" },
        ], "all")}
        <div ${settingsFolderSectionPanelAttrs("cleanup-candidates", "all", "all")}>
        <div style="font-size:12px;opacity:.72">Selectable rows are non-canonical review candidates only. Native-owned canonical rows are preserve-only.</div>
        <div id="wbSettingsFolderCleanupReviewGroups" style="display:flex;flex-direction:column;gap:8px;font-size:13px"></div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("cleanup-candidates", "conflicts", "all")}>
        <div id="wbSettingsFolderCleanupReviewGroupsConflicts" style="display:flex;flex-direction:column;gap:8px;font-size:13px"></div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("cleanup-candidates", "tests", "all")}>
        <div id="wbSettingsFolderCleanupReviewGroupsTests" style="display:flex;flex-direction:column;gap:8px;font-size:13px"></div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("cleanup-candidates", "preserve", "all")}>
        <div id="wbSettingsFolderCleanupReviewGroupsPreserve" style="display:flex;flex-direction:column;gap:8px;font-size:13px"></div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("cleanup-candidates", "blocked", "all")}>
        <div id="wbSettingsFolderCleanupReviewGroupsBlocked" style="display:flex;flex-direction:column;gap:8px;font-size:13px"></div>
        </div>
        </div>
        <div data-folder-cleanup-subpanel="dry-run" ${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "dry-run" ? "" : "hidden"} style="display:${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "dry-run" ? "flex" : "none"};flex-direction:column;gap:8px">
        ${settingsFolderSectionTabsHtml("cleanup-dry-run", [
          { id: "controls", label: "Controls" },
          { id: "result", label: "Dry-run Result" },
          { id: "selected", label: "Selected Rows" },
          { id: "reasons", label: "Reason Codes" },
          { id: "json", label: "JSON Preview" },
        ], "controls")}
        <div id="wbSettingsFolderCleanupDryRunBox" style="border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px">
          <div ${settingsFolderSectionPanelAttrs("cleanup-dry-run", "controls", "controls")}>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
            <div>
              <div style="font-weight:600">Dry-run cleanup plan</div>
              <div id="wbSettingsFolderCleanupDryRunSummary" style="opacity:.72;font-size:12px">Select review rows, then generate a dry-run plan. No cleanup is performed.</div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button id="wbSettingsFolderCleanupDryRunGenerate" data-folder-cleanup-dry-run-action="generate" type="button" style="${btnStyle}">Generate dry-run plan</button>
              <button id="wbSettingsFolderCleanupDryRunCopy" type="button" style="${btnStyle}" disabled>Copy dry-run plan JSON</button>
            </div>
          </div>
          </div>
          <div ${settingsFolderSectionPanelAttrs("cleanup-dry-run", "result", "controls")}>
          <div style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap">
            <button data-folder-cleanup-dry-run-action="generate" type="button" style="${btnStyle}">Generate dry-run plan</button>
          </div>
          <div id="wbSettingsFolderCleanupDryRunRows" style="display:flex;flex-direction:column;gap:6px;font-size:12px"></div>
          </div>
          <div ${settingsFolderSectionPanelAttrs("cleanup-dry-run", "selected", "controls")}>
          <div id="wbSettingsFolderCleanupDryRunSelectedRows" style="display:flex;flex-direction:column;gap:6px;font-size:12px">Generate a dry-run plan to inspect selected rows.</div>
          </div>
          <div ${settingsFolderSectionPanelAttrs("cleanup-dry-run", "reasons", "controls")}>
          <div id="wbSettingsFolderCleanupDryRunReasonCodes" style="display:flex;flex-direction:column;gap:6px;font-size:12px">Generate a dry-run plan to inspect reason codes.</div>
          </div>
          <div ${settingsFolderSectionPanelAttrs("cleanup-dry-run", "json", "controls")}>
          <pre id="wbSettingsFolderCleanupDryRunJson" style="white-space:pre-wrap;background:rgba(0,0,0,.18);padding:10px;border-radius:6px;max-height:220px;overflow:auto;font-size:12px;line-height:1.45;margin:0" hidden></pre>
          </div>
        </div>
        </div>
        <div data-folder-cleanup-subpanel="apply-preview" ${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "apply-preview" ? "" : "hidden"} style="display:${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "apply-preview" ? "flex" : "none"};flex-direction:column;gap:8px">
        ${settingsFolderSectionTabsHtml("cleanup-apply-preview", [
          { id: "controls", label: "Controls" },
          { id: "result", label: "Preview Result" },
          { id: "blockers", label: "Blockers" },
          { id: "confirmation", label: "Confirmation" },
          { id: "json", label: "JSON Preview" },
        ], "controls")}
        <div id="wbSettingsFolderCleanupApplyPreviewBox" style="border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px">
          <div ${settingsFolderSectionPanelAttrs("cleanup-apply-preview", "controls", "controls")}>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
            <div>
              <div style="font-weight:600">Preview Gate</div>
              <div id="wbSettingsFolderCleanupApplyPreviewSummary" style="opacity:.72;font-size:12px">Preview only: no cleanup is applied.</div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button id="wbSettingsFolderCleanupApplyPreviewGenerate" data-folder-cleanup-apply-preview-action="generate" type="button" style="${btnStyle}">Generate apply preview</button>
              <button id="wbSettingsFolderCleanupApplyPreviewCopy" data-folder-cleanup-apply-preview-action="copy" type="button" style="${btnStyle}" disabled>Copy preview gate JSON</button>
            </div>
          </div>
          <div style="font-size:12px;opacity:.76;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:8px">Preview only: no cleanup is applied. This tab never writes folder state, Native state, Chrome storage, Desktop mirror, Desktop SQLite, or Rust-backed data.</div>
          </div>
          <div ${settingsFolderSectionPanelAttrs("cleanup-apply-preview", "result", "controls")}>
          <div style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap">
            <button data-folder-cleanup-apply-preview-action="generate" type="button" style="${btnStyle}">Generate apply preview</button>
          </div>
          <div id="wbSettingsFolderCleanupApplyPreviewRows" style="display:flex;flex-direction:column;gap:6px;font-size:12px">
            <div style="border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.025);border-radius:8px;padding:8px;opacity:.78">Click Generate apply preview to render the preview-only gate. No cleanup is applied.</div>
          </div>
          </div>
          <div ${settingsFolderSectionPanelAttrs("cleanup-apply-preview", "blockers", "controls")}>
          <div id="wbSettingsFolderCleanupApplyPreviewBlockers" style="display:flex;flex-direction:column;gap:6px;font-size:12px">Generate apply preview to inspect blockers.</div>
          </div>
          <div ${settingsFolderSectionPanelAttrs("cleanup-apply-preview", "confirmation", "controls")}>
          <div id="wbSettingsFolderCleanupApplyPreviewConfirmation" style="font-size:12px;opacity:.76;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:8px">requiredConfirmationText: ${esc(FOLDER_CLEANUP_APPLY_PREVIEW_CONFIRM_TEXT)}</div>
          </div>
          <div ${settingsFolderSectionPanelAttrs("cleanup-apply-preview", "json", "controls")}>
          <pre id="wbSettingsFolderCleanupApplyPreviewJson" style="white-space:pre-wrap;background:rgba(0,0,0,.18);padding:10px;border-radius:6px;max-height:220px;overflow:auto;font-size:12px;line-height:1.45;margin:0" hidden></pre>
          </div>
        </div>
        </div>
        <div data-folder-cleanup-subpanel="conflicts" ${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "conflicts" ? "" : "hidden"} style="display:${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "conflicts" ? "flex" : "none"};flex-direction:column;gap:8px">
        ${settingsFolderSectionTabsHtml("cleanup-conflicts", [
          { id: "case", label: "Case Conflict" },
          { id: "english", label: "English Conflict" },
          { id: "rules", label: "Rules" },
        ], "case")}
        <div ${settingsFolderSectionPanelAttrs("cleanup-conflicts", "rules", "case")}>
        <div style="font-size:12px;opacity:.76;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:8px">Never merge by name. Same-name rows such as Case and English are review-only conflicts until a future exact-ID plan exists.</div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("cleanup-conflicts", "case", "case")}>
        <div id="wbSettingsFolderConflictReview" style="border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
            <div>
              <div style="font-weight:600">Same-name Conflict Resolution</div>
              <div id="wbSettingsFolderConflictSummary" style="opacity:.72;font-size:12px">Review-only. No merge or deletion performed.</div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button id="wbSettingsFolderConflictRefresh" type="button" style="${btnStyle}">Refresh conflict review</button>
              <button id="wbSettingsFolderConflictCopy" type="button" style="${btnStyle}">Copy conflict plan JSON</button>
            </div>
          </div>
          <div id="wbSettingsFolderConflictGroups" style="display:flex;flex-direction:column;gap:8px;font-size:13px"></div>
        </div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("cleanup-conflicts", "english", "case")}>
        <div id="wbSettingsFolderConflictGroupsEnglish" style="display:flex;flex-direction:column;gap:8px;font-size:13px"></div>
        </div>
        </div>
        <div data-folder-cleanup-subpanel="desktop" ${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "desktop" ? "" : "hidden"} style="display:${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "desktop" ? "flex" : "none"};flex-direction:column;gap:8px">
        ${settingsFolderSectionTabsHtml("cleanup-desktop", [
          { id: "summary", label: "Summary" },
          { id: "rows", label: "Desktop Rows" },
          { id: "sqlite", label: "SQLite Bindings" },
          { id: "json", label: "Desktop Report JSON" },
        ], "summary")}
        <div id="wbSettingsFolderDesktopReview" style="border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px">
          <div ${settingsFolderSectionPanelAttrs("cleanup-desktop", "summary", "summary")}>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
            <div>
              <div style="font-weight:600">Desktop Cleanup Review</div>
              <div id="wbSettingsFolderDesktopReviewSummary" style="opacity:.72;font-size:12px">Review-only. No Desktop cleanup performed.</div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button id="wbSettingsFolderDesktopReviewRefresh" type="button" style="${btnStyle}">Refresh Desktop review</button>
              <button id="wbSettingsFolderDesktopReviewCopy" type="button" style="${btnStyle}">Copy Desktop cleanup report JSON</button>
            </div>
          </div>
          <div id="wbSettingsFolderDesktopReviewChips" style="display:flex;gap:8px;flex-wrap:wrap;font-size:12px"></div>
          </div>
          <div ${settingsFolderSectionPanelAttrs("cleanup-desktop", "rows", "summary")}>
          <div id="wbSettingsFolderDesktopReviewGroups" style="display:flex;flex-direction:column;gap:8px;font-size:13px"></div>
          </div>
          <div ${settingsFolderSectionPanelAttrs("cleanup-desktop", "sqlite", "summary")}>
          <div style="font-size:12px;opacity:.76;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:8px">Desktop SQLite bindings are inspected only through diagnostics in this phase. No direct SQLite cleanup is performed.</div>
          </div>
          <div ${settingsFolderSectionPanelAttrs("cleanup-desktop", "json", "summary")}>
          <div style="font-size:12px;opacity:.76;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:8px">Use Copy Desktop cleanup report JSON to copy the current read-only Desktop report.</div>
          </div>
        </div>
        </div>
        <div data-folder-cleanup-subpanel="orphans" ${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "orphans" ? "" : "hidden"} style="display:${FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab === "orphans" ? "flex" : "none"};flex-direction:column;gap:8px">
          ${settingsFolderSectionTabsHtml("cleanup-orphans", [
            { id: "summary", label: "Summary" },
            { id: "memberships", label: "Orphan Memberships" },
            { id: "risk", label: "Risk Explanation" },
            { id: "json", label: "Report JSON" },
          ], "summary")}
          <div ${settingsFolderSectionPanelAttrs("cleanup-orphans", "risk", "summary")}>
          <div style="font-size:12px;opacity:.76;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:8px">Orphan membership/binding risk is diagnostic. It is not deletion permission and does not authorize cleanup.</div>
          </div>
          <div ${settingsFolderSectionPanelAttrs("cleanup-orphans", "summary", "summary")}>
          <div id="wbSettingsFolderDesktopOrphanBindingBox" style="border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
              <div>
                <div style="font-weight:600">Orphan Desktop Binding Review</div>
                <div id="wbSettingsFolderDesktopOrphanBindingSummary" style="opacity:.72;font-size:12px">Review-only. No binding removed.</div>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button id="wbSettingsFolderDesktopOrphanBindingRefresh" type="button" style="${btnStyle}">Refresh orphan binding review</button>
                <button id="wbSettingsFolderDesktopOrphanBindingCopy" type="button" style="${btnStyle}">Copy orphan binding report JSON</button>
              </div>
            </div>
            <div id="wbSettingsFolderDesktopOrphanBindingBody" style="display:flex;flex-direction:column;gap:8px;font-size:13px"></div>
          </div>
          </div>
          <div ${settingsFolderSectionPanelAttrs("cleanup-orphans", "memberships", "summary")}>
          <div style="font-size:12px;opacity:.76;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:8px">Orphan membership facts appear in the Summary tab after refresh. They remain read-only diagnostics.</div>
          </div>
          <div ${settingsFolderSectionPanelAttrs("cleanup-orphans", "json", "summary")}>
          <div style="font-size:12px;opacity:.76;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:8px">Use Copy orphan binding report JSON to copy the current read-only report.</div>
          </div>
        </div>
      </div>
      </div>
      <div id="wbSettingsFolderParityPanelOperations" data-folder-parity-panel="operations" ${FOLDER_PARITY_SETTINGS_UI_STATE.activeTab === "operations" ? "" : "hidden"} style="display:flex;flex-direction:column;gap:8px">
        ${settingsFolderSectionTabsHtml("parity-operations", [
          { id: "status", label: "Operation Status" },
          { id: "proofs", label: "Proofs" },
          { id: "diagnostics", label: "Diagnostics" },
          { id: "json", label: "JSON" },
        ], "status")}
        <div ${settingsFolderSectionPanelAttrs("parity-operations", "status", "status")}>
        <div>
          <div style="font-weight:600">Operations / Proofs</div>
          <div style="opacity:.72;font-size:12px">Read-only status summary. This tab does not run folder color, rename, delete, cleanup, or apply operations.</div>
        </div>
        <div id="wbSettingsFolderParityOperationsRows" style="display:flex;flex-direction:column;gap:7px"></div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("parity-operations", "proofs", "status")}>
          <div style="font-size:12px;opacity:.76;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:8px">Runtime proofs are recorded in folder parity docs. This UI only reports current read-only operation status.</div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("parity-operations", "diagnostics", "status")}>
          <div style="font-size:12px;opacity:.76;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:8px">Use Refresh diagnostics to update current FolderParity status. No metadata operation is applied from this tab.</div>
        </div>
        <div ${settingsFolderSectionPanelAttrs("parity-operations", "json", "status")}>
          <div style="font-size:12px;opacity:.76;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:8px;padding:8px">Use Copy report JSON from the Folder Parity header for the current read-only report.</div>
        </div>
      </div>
      <pre id="wbSettingsFolderParityLog" style="white-space:pre-wrap;background:rgba(0,0,0,.18);padding:10px;border-radius:6px;max-height:160px;overflow:auto;font-size:12px;line-height:1.45;margin:0" hidden></pre>
    </div>

    <h3 style="${sectionTitleStyle}">Storage Diagnostics</h3>
    <div id="wbSettingsDiagBox" class="wbSettingsCard" style="${cardStyle}">
      <div style="display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace">
        <div style="opacity:.6">Extension ID</div>           <div id="wbSettingsDiagId">${esc(meta.id || "(unavailable)")}</div>
        <div style="opacity:.6">Extension name</div>         <div id="wbSettingsDiagName">${esc(meta.name || "(unavailable)")}</div>
        <div style="opacity:.6">Version</div>                <div id="wbSettingsDiagVersion">${esc(meta.version || "(unavailable)")}</div>
        <div style="opacity:.6">Saved chats</div>            <div id="wbSettingsDiagChats">(loading…)</div>
        <div style="opacity:.6">Build channel</div>          <div id="wbSettingsDiagBuild">(loading…)</div>
      </div>
      <div id="wbSettingsDiagWarn" style="margin-top:8px;font-size:12px;opacity:.75" hidden></div>
    </div>
    <div style="margin-top:8px;font-size:12px;opacity:.6">
      Tip: each Chrome extension ID has its own isolated <code>chrome.storage.local</code> and IndexedDB. If your data ever disappears after rebuilding from a new path, it's almost certainly still alive under the previous extension ID — use Import on the old extension's bundle to restore.
    </div>
    ${settingsFolderOperatorModeDiagnosticsHtml(cardStyle, btnStyle, "margin-top:12px")}
  `;

  const evaluationHtml = settingsEvaluationPanelHtml();
  if (evaluationHtml) panel.insertAdjacentHTML("afterbegin", evaluationHtml);
  settingsBindEvaluationControls(panel);

  if (isFolderParityRoute && settingsEvaluationUseNewSettings()) {
    settingsWrapFolderParityRoute(panel, panel.querySelector("#wbSettingsFolderParityBox"));
    return;
  }

  settingsBindFolderOperatorModeControls(panel);
  bindSettingsSyncControls(panel);
  mountSettingsArchiveHealthCard(panel);
  mountSettingsArchiveRequestDeliveryCard(panel);
  refreshSettingsDiagnostics(panel);

  /* Phase I — restore the last-picked folder-state import path if one
   * was persisted in a prior session. Fire-and-forget: the template
   * already pre-fills the input with the runbook example path, so a
   * cold cache or storage failure simply keeps that default. Read
   * happens once per panel build (the renderSettingsRoute first-render
   * branch); subsequent refreshes do not re-read so a user's in-flight
   * edits are never clobbered by focus/visibility re-entries. */
  STUDIO_settingsReadFolderStateLastPath().then((stored) => {
    if (!stored) return;
    const input = panel.querySelector("#wbSettingsSyncFolderStatePath");
    if (input) input.value = stored;
  }).catch(() => { /* ignore */ });
}

async function refreshSettingsDiagnostics(panel){
  if (!panel) return;
  syncFolderOperatorModeDiagnosticsUi(panel);
  const meta = migrateExtensionLabel();
  const elId = panel.querySelector("#wbSettingsDiagId");
  const elName = panel.querySelector("#wbSettingsDiagName");
  const elVer = panel.querySelector("#wbSettingsDiagVersion");
  const elChats = panel.querySelector("#wbSettingsDiagChats");
  const elBuild = panel.querySelector("#wbSettingsDiagBuild");
  const elWarn = panel.querySelector("#wbSettingsDiagWarn");
  if (elId) elId.textContent = meta.id || "(unavailable)";
  if (elName) elName.textContent = meta.name || "(unavailable)";
  if (elVer) elVer.textContent = meta.version || "(unavailable)";

  // Build channel inferred from manifest name. Cheap heuristic; aligns with
  // the names emitted by chrome-live-build-context.mjs.
  let channel = "unknown";
  const nm = String(meta.name || "");
  if (/Cockpit Pro/i.test(nm)) channel = "production (chrome-ext-prod)";
  else if (/Dev Controls/i.test(nm)) channel = "dev-controls";
  else if (/Lean/i.test(nm)) channel = "dev-lean";
  if (elBuild) elBuild.textContent = channel;

  if (elChats) {
    try {
      const rows = await callArchive("listAllChatIds", {});
      const count = Array.isArray(rows) ? rows.length : 0;
      elChats.textContent = String(count);
      if (elWarn && count === 0) {
        elWarn.hidden = false;
        elWarn.textContent = "This extension has zero saved chats. If you expect chats here, check whether another extension (different ID) holds them — see the tip above and use Import.";
      } else if (elWarn) {
        elWarn.hidden = true;
        elWarn.textContent = "";
      }
    } catch (err) {
      elChats.textContent = "(unavailable)";
      if (elWarn) {
        elWarn.hidden = false;
        elWarn.textContent = "Storage probe failed: " + String(err && (err.message || err));
      }
    }
  }
  refreshSettingsSync(panel).catch((err) => {
    const summary = panel.querySelector("#wbSettingsSyncSummary");
    const status = panel.querySelector("#wbSettingsSyncStatus");
    const log = panel.querySelector("#wbSettingsSyncLog");
    if (summary) summary.textContent = "Sync status unavailable.";
    if (status) status.innerHTML = settingsSyncRowsHtml([
      ["Runtime", STUDIO_isTauri() ? "Desktop/Tauri" : "Chrome/MV3"],
      ["Status", "failed"],
      ["Reason", String(err && (err.message || err))],
    ]);
    if (log) {
      log.hidden = false;
      log.textContent = "Sync status refresh failed.\n" + String(err && (err.stack || err.message || err));
    }
  });
  refreshSettingsFolderParity(panel).catch((err) => {
    const summary = panel.querySelector("#wbSettingsFolderParitySummary");
    const status = panel.querySelector("#wbSettingsFolderParityStatus");
    const warn = panel.querySelector("#wbSettingsFolderParityWarn");
    if (summary) summary.textContent = "Folder parity diagnostics unavailable.";
    if (status) status.innerHTML = settingsSyncRowsHtml([
      ["Status", "failed"],
      ["Reason", String(err && (err.message || err))],
    ]);
    if (warn) {
      warn.hidden = false;
      warn.textContent = String(err && (err.message || err));
    }
    settingsFolderParitySetOperationStatus(panel, "folderDiagnostics", "failed", "Refresh failed");
    settingsFolderParityRenderOperationRows(panel);
    settingsFolderParityLog(panel, "Folder parity diagnostics failed.\n" + String(err && (err.stack || err.message || err)));
  });
}

function settingsFormatBytes(value){
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function settingsIsoOrBlank(value){
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    try { return new Date(value).toLocaleString(); }
    catch { return String(value); }
  }
  const raw = String(value || "").trim();
  if (!raw) return "";
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return raw;
  try { return new Date(ms).toLocaleString(); }
  catch { return raw; }
}

function settingsSyncRowsHtml(rows){
  return rows.map(([label, value]) => `
    <div style="opacity:.6">${esc(label)}</div>
    <div>${esc(value == null || value === "" ? "—" : value)}</div>
  `).join("");
}

function settingsFolderSyncHealthStatus(raw, fallback = "not-tested"){
  const value = String(raw || "").trim().toLowerCase();
  if (value === "healthy" || value === "ok" || value === "passed" || value === "current") return "works";
  if (value === "warning" || value === "warn" || value === "needs-attention") return "warning";
  if (value === "blocked" || value === "failed" || value === "error") return "failed";
  if (value === "deferred" || value === "disabled" || value === "not-applicable") return "disabled";
  return fallback;
}

function settingsFolderSyncBoolText(value){
  if (value === true) return "true";
  if (value === false) return "false";
  return "—";
}

function settingsFolderSyncNumber(source, key, fallback = 0){
  const n = Number(source && source[key]);
  return Number.isFinite(n) ? n : fallback;
}

function settingsFolderSyncHealthCardHtml(title, status, detail = "", label = ""){
  return `
    <div style="display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid rgba(255,255,255,.10);border-radius:8px;background:rgba(255,255,255,.03);min-width:170px">
      <div style="font-size:12px;opacity:.72">${esc(title)}</div>
      <div>${settingsFolderParityStatusBadgeHtml(status, label)}${detail ? ` <span style="opacity:.72">${esc(detail)}</span>` : ""}</div>
    </div>
  `;
}

function settingsFolderSyncHealthBadgeHtml(label, status = "works"){
  return settingsFolderParityStatusBadgeHtml(status, label);
}

function settingsFolderSyncDeferredItemsHtml(){
  const items = [
    "purge design deferred",
    "WebDAV/cloud/relay deferred",
    "full chat-folder binding sync deferred",
    "cross-device retention ledger deferred",
  ];
  return items.map((item) => settingsFolderSyncHealthBadgeHtml(item, "disabled")).join(" ");
}

function settingsFolderSyncHealthRender(panel, data = {}){
  const host = panel?.querySelector?.("#wbSettingsFolderSyncHealthDashboard");
  if (!host) return;
  const health = data.health && typeof data.health === "object" ? data.health : {};
  const recently = data.recentlyDeleted && typeof data.recentlyDeleted === "object" ? data.recentlyDeleted : {};
  const deleteState = health.tombstoneLocalDelete && typeof health.tombstoneLocalDelete === "object" ? health.tombstoneLocalDelete : {};
  const desktopToChrome = health.desktopToChrome && typeof health.desktopToChrome === "object" ? health.desktopToChrome : {};
  const chromeToDesktop = health.chromeToDesktop && typeof health.chromeToDesktop === "object" ? health.chromeToDesktop : {};
  const blockers = Array.isArray(health.blockers) ? health.blockers : [];
  const warnings = Array.isArray(health.warnings) ? health.warnings : [];
  const healthVerdict = String(health.verdict || (blockers.length ? "blocked" : warnings.length ? "warning" : "healthy"));
  const lifecycleHealthy = deleteState.tombstoneStoreAvailable === false
    ? "warning"
    : (deleteState.hardDeleteBlocked === true && deleteState.purgeBlocked === true ? "healthy" : "blocked");
  const recentlyAvailable = recently.ok === true && Array.isArray(recently.rows);
  const retentionEnforcement = String(recently.retentionEnforcement || "deferred");
  const purgeEligibleCount = settingsFolderSyncNumber(recently, "purgeEligibleCount", 0);
  const safety = {
    noHardDelete: deleteState.hardDeleteBlocked === true || recently.noHardDelete === true,
    noPurge: deleteState.purgeBlocked === true || recently.noPurge === true,
    noChatDelete: deleteState.chatDeleteBlocked === true || recently.noChatDelete === true,
    noSnapshotDelete: recently.noSnapshotDelete === true,
    noTombstoneApplyOnChrome: true,
  };
  const safetyOk = Object.values(safety).every(Boolean);
  const cards = [
    settingsFolderSyncHealthCardHtml("Create / Rename / Color", settingsFolderSyncHealthStatus(healthVerdict), health.summaryText || healthVerdict, healthVerdict),
    settingsFolderSyncHealthCardHtml("Delete / Restore Lifecycle", settingsFolderSyncHealthStatus(lifecycleHealthy), "Desktop authoritative soft delete / restore", lifecycleHealthy),
    settingsFolderSyncHealthCardHtml("Desktop Authority", deleteState.tombstoneStoreAvailable === false ? "warning" : "works", deleteState.lastStatus || "soft delete and restore paths available"),
    settingsFolderSyncHealthCardHtml("Chrome Receipts", "disabled", "visible-state-only delete/restore receipts", "deferred"),
    settingsFolderSyncHealthCardHtml("Recently Deleted", recentlyAvailable ? "works" : "warning", recentlyAvailable ? `${settingsFolderSyncNumber(recently, "folderTombstoneCount", 0)} folder tombstones` : "diagnostics unavailable"),
    settingsFolderSyncHealthCardHtml("Retention Policy", retentionEnforcement === "deferred" ? "disabled" : "warning", `${settingsFolderSyncNumber(recently, "retentionDays", 30)} days`, retentionEnforcement || "deferred"),
  ];
  const metricRows = [
    ["Desktop -> Chrome auto export", desktopToChrome.autoExportEnabled === true ? "enabled" : "disabled"],
    ["Chrome -> Desktop auto import", chromeToDesktop.desktopAutoImportEnabled === true ? "enabled" : "disabled"],
    ["retentionEnforcement", retentionEnforcement],
    ["retentionDays", String(settingsFolderSyncNumber(recently, "retentionDays", 30))],
    ["purgeEligibleCount", String(purgeEligibleCount)],
    ["purgeBlockedCount", String(settingsFolderSyncNumber(recently, "purgeBlockedCount", 0))],
    ["hardDeleteBlockedCount", String(settingsFolderSyncNumber(recently, "hardDeleteBlockedCount", 0))],
    ["activeRetentionCount", String(settingsFolderSyncNumber(recently, "activeRetentionCount", 0))],
    ["expiredRetentionCount", String(settingsFolderSyncNumber(recently, "expiredRetentionCount", 0))],
    ["restoredRetentionCount", String(settingsFolderSyncNumber(recently, "restoredRetentionCount", 0))],
  ];
  const safetyBadges = [
    settingsFolderSyncHealthBadgeHtml(`noHardDelete:${settingsFolderSyncBoolText(safety.noHardDelete)}`, safety.noHardDelete ? "works" : "failed"),
    settingsFolderSyncHealthBadgeHtml(`noPurge:${settingsFolderSyncBoolText(safety.noPurge)}`, safety.noPurge ? "works" : "failed"),
    settingsFolderSyncHealthBadgeHtml(`noChatDelete:${settingsFolderSyncBoolText(safety.noChatDelete)}`, safety.noChatDelete ? "works" : "failed"),
    settingsFolderSyncHealthBadgeHtml(`noSnapshotDelete:${settingsFolderSyncBoolText(safety.noSnapshotDelete)}`, safety.noSnapshotDelete ? "works" : "failed"),
    settingsFolderSyncHealthBadgeHtml(`noTombstoneApplyOnChrome:${settingsFolderSyncBoolText(safety.noTombstoneApplyOnChrome)}`, safety.noTombstoneApplyOnChrome ? "works" : "failed"),
  ].join(" ");
  host.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <div>
        <div style="font-weight:600">Folder Sync Health</div>
        <div style="opacity:.7;font-size:12px">Read-only local sync, delete/restore, retention, and deferred-item diagnostics.</div>
      </div>
      ${settingsFolderParityStatusBadgeHtml(safetyOk && !blockers.length ? "works" : "warning", safetyOk && !blockers.length ? "healthy" : "warning")}
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px">${cards.join("")}</div>
    <div style="display:flex;flex-direction:column;gap:6px">
      <div style="font-size:12px;opacity:.72">Safety invariants</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${safetyBadges}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      <div style="font-size:12px;opacity:.72">Deferred items</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${settingsFolderSyncDeferredItemsHtml()}</div>
    </div>
    <div style="display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace">
      ${settingsSyncRowsHtml(metricRows)}
    </div>
    ${blockers.length || warnings.length ? `<div style="font-size:12px;opacity:.72">Blockers: ${esc(blockers.join(", ") || "none")} · Warnings: ${esc(warnings.join(", ") || "none")}</div>` : ""}
  `;
}

function settingsFolderSyncHealthUnavailable(panel, message){
  const host = panel?.querySelector?.("#wbSettingsFolderSyncHealthDashboard");
  if (!host) return;
  host.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:6px">
      <div style="font-weight:600">Folder Sync Health</div>
      <div style="opacity:.72;font-size:12px">${esc(message || "Diagnostics unavailable.")}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${settingsFolderParityStatusBadgeHtml("warning", "warning")}
        ${settingsFolderParityStatusBadgeHtml("disabled", "deferred")}
      </div>
    </div>
  `;
}

function settingsFolderParityLog(panel, message){
  const log = panel && panel.querySelector("#wbSettingsFolderParityLog");
  if (!log) return;
  log.hidden = false;
  log.textContent = String(message || "");
}

function settingsFolderParityNames(items, emptyLabel = "none"){
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) return `<span style="opacity:.65">${esc(emptyLabel)}</span>`;
  return arr.map((item) => {
    const name = String(item?.name || item?.normalizedName || item || "").trim() || "(unnamed)";
    const ids = Array.isArray(item?.ids) ? item.ids : (item?.id || item?.folderId ? [item.id || item.folderId] : []);
    const suffix = ids.length ? ` <span style="opacity:.55">(${esc(ids.join(", "))})</span>` : "";
    return `<span>${esc(name)}${suffix}</span>`;
  }).join(", ");
}

function settingsFolderParityChecksHtml(selfCheck){
  const checks = Array.isArray(selfCheck?.checks) ? selfCheck.checks : [];
  const attention = checks.filter((check) => {
    const sev = String(check?.severity || "");
    return !check?.ok || sev === "warning" || sev === "review-required" || sev === "error";
  });
  if (!attention.length) return `<span style="opacity:.65">none</span>`;
  return attention.map((check) => {
    const severity = String(check?.severity || "warning");
    const id = String(check?.id || "");
    const message = String(check?.message || "");
    return `
      <div style="display:grid;grid-template-columns:max-content 1fr;gap:6px 8px;align-items:start">
        <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px;opacity:.75">${esc(severity)}</span>
        <span><strong>${esc(id)}</strong>: ${esc(message)}</span>
      </div>
    `;
  }).join("");
}

function settingsFolderParityStatusMeta(status){
  const key = String(status || "not-tested");
  const map = {
    works: {
      label: "Works",
      color: "rgba(74,222,128,.90)",
      bg: "rgba(74,222,128,.12)",
      border: "rgba(74,222,128,.32)",
    },
    warning: {
      label: "Needs attention",
      color: "rgba(250,204,21,.92)",
      bg: "rgba(250,204,21,.12)",
      border: "rgba(250,204,21,.34)",
    },
    failed: {
      label: "Failed",
      color: "rgba(248,113,113,.95)",
      bg: "rgba(248,113,113,.12)",
      border: "rgba(248,113,113,.34)",
    },
    running: {
      label: "Running",
      color: "rgba(147,197,253,.95)",
      bg: "rgba(147,197,253,.12)",
      border: "rgba(147,197,253,.32)",
    },
    disabled: {
      label: "Disabled / protected",
      color: "rgba(203,213,225,.86)",
      bg: "rgba(148,163,184,.10)",
      border: "rgba(148,163,184,.28)",
    },
    "not-tested": {
      label: "Not tested",
      color: "rgba(203,213,225,.76)",
      bg: "rgba(148,163,184,.08)",
      border: "rgba(148,163,184,.22)",
    },
  };
  return map[key] || map["not-tested"];
}

function settingsFolderParityStatusBadgeHtml(status, label){
  const meta = settingsFolderParityStatusMeta(status);
  const text = label || meta.label;
  return `<span style="display:inline-flex;align-items:center;gap:6px;width:max-content;padding:3px 8px;border-radius:999px;border:1px solid ${meta.border};background:${meta.bg};color:${meta.color};font-size:11px;font-weight:600;line-height:1.2">${esc(text)}</span>`;
}

function settingsFolderParitySetOperationStatus(panel, key, status, detail = "", label = ""){
  const id = String(key || "").trim();
  if (!id) return;
  const entry = {
    status: String(status || "not-tested"),
    detail: String(detail || ""),
    label: String(label || ""),
    updatedAt: new Date().toISOString(),
  };
  FOLDER_PARITY_SETTINGS_UI_STATE.statuses[id] = entry;
  const target = panel?.querySelector?.(`[data-folder-parity-status="${id}"]`);
  if (target) {
    target.innerHTML = `${settingsFolderParityStatusBadgeHtml(entry.status, entry.label)}${entry.detail ? ` <span style="opacity:.72">${esc(entry.detail)}</span>` : ""}`;
  }
  if (panel?.querySelector?.("#wbSettingsFolderParityOperationsRows")) {
    settingsFolderParityRenderOperationRows(panel);
  }
}

function settingsFolderParityStatusCardHtml(key, title, status = "not-tested", detail = "", label = ""){
  return `
    <div style="display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid rgba(255,255,255,.10);border-radius:8px;background:rgba(255,255,255,.03);min-width:150px">
      <div style="font-size:12px;opacity:.72">${esc(title)}</div>
      <div data-folder-parity-status="${esc(key)}">${settingsFolderParityStatusBadgeHtml(status, label)}${detail ? ` <span style="opacity:.72">${esc(detail)}</span>` : ""}</div>
    </div>
  `;
}

function settingsFolderParityPanelTabStyle(active){
  return [
    "padding:7px 10px",
    "border-radius:7px",
    "border:1px solid " + (active ? "rgba(96,165,250,.42)" : "rgba(255,255,255,.10)"),
    "background:" + (active ? "rgba(96,165,250,.14)" : "rgba(255,255,255,.04)"),
    "color:inherit",
    "font:inherit",
    "font-size:12px",
    "cursor:pointer",
    "pointer-events:auto",
  ].join(";");
}

function settingsFolderParityEnsureTabBinding(panel){
  if (!panel) return;
  const version = "p8i-section-tabs-v1";
  if (panel.__h2oFolderParityTabBindingVersion === version) return;
  panel.__h2oFolderParityTabBindingVersion = version;
  panel.addEventListener("click", (event) => {
    const sectionTab = event.target?.closest?.("[data-folder-section-tab]");
    if (sectionTab && panel.contains(sectionTab)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      settingsFolderSectionSetActive(panel, sectionTab.getAttribute("data-folder-section-scope"), sectionTab.getAttribute("data-folder-section-tab"));
      return;
    }
    const tab = event.target?.closest?.("[data-folder-parity-tab]");
    if (!tab || !panel.contains(tab)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    settingsFolderParitySetActiveTab(panel, tab.getAttribute("data-folder-parity-tab"));
  }, true);
  panel.addEventListener("click", (event) => {
    const tab = event.target?.closest?.("[data-folder-cleanup-subtab]");
    if (!tab || !panel.contains(tab)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    settingsFolderCleanupSetActiveSubtab(panel, tab.getAttribute("data-folder-cleanup-subtab"));
  }, true);
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const sectionTab = event.target?.closest?.("[data-folder-section-tab]");
    if (sectionTab && panel.contains(sectionTab)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      settingsFolderSectionSetActive(panel, sectionTab.getAttribute("data-folder-section-scope"), sectionTab.getAttribute("data-folder-section-tab"));
      return;
    }
    const tab = event.target?.closest?.("[data-folder-parity-tab]");
    if (!tab || !panel.contains(tab)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    settingsFolderParitySetActiveTab(panel, tab.getAttribute("data-folder-parity-tab"));
  }, true);
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const tab = event.target?.closest?.("[data-folder-cleanup-subtab]");
    if (!tab || !panel.contains(tab)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    settingsFolderCleanupSetActiveSubtab(panel, tab.getAttribute("data-folder-cleanup-subtab"));
  }, true);
  panel.addEventListener("click", (event) => {
    const generateBtn = event.target?.closest?.("[data-folder-cleanup-dry-run-action='generate'], #wbSettingsFolderCleanupDryRunGenerate");
    if (generateBtn && panel.contains(generateBtn)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      generateSettingsFolderCleanupDryRunPlan(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
      return;
    }
    const copyBtn = event.target?.closest?.("#wbSettingsFolderCleanupDryRunCopy");
    if (copyBtn && panel.contains(copyBtn)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      copySettingsFolderCleanupDryRunPlan(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
      return;
    }
    const applyPreviewBtn = event.target?.closest?.("[data-folder-cleanup-apply-preview-action='generate'], #wbSettingsFolderCleanupApplyPreviewGenerate");
    if (applyPreviewBtn && panel.contains(applyPreviewBtn)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      generateSettingsFolderCleanupApplyPreview(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
      return;
    }
    const applyPreviewCopyBtn = event.target?.closest?.("[data-folder-cleanup-apply-preview-action='copy'], #wbSettingsFolderCleanupApplyPreviewCopy");
    if (applyPreviewCopyBtn && panel.contains(applyPreviewCopyBtn)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      copySettingsFolderCleanupApplyPreview(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
    }
  }, true);
  panel.addEventListener("change", (event) => {
    const target = event.target;
    if (!target || target.getAttribute?.("data-folder-cleanup-dry-run-select") !== "1" || !panel.contains(target)) return;
    const folderId = String(target.getAttribute("data-folder-id") || "").trim();
    if (folderId) {
      panel.querySelectorAll("[data-folder-cleanup-dry-run-select='1'][data-folder-id]").forEach((input) => {
        if (String(input.getAttribute("data-folder-id") || "").trim() !== folderId) return;
        if (input !== target) input.checked = !!target.checked;
      });
    }
    settingsFolderCleanupDryRunSelectedIds(panel);
    panel.__h2oFolderCleanupDryRunPlan = null;
    FOLDER_PARITY_SETTINGS_UI_STATE.cleanupDryRunPlan = null;
    const summary = panel.querySelector("#wbSettingsFolderCleanupDryRunSummary");
    const rows = panel.querySelector("#wbSettingsFolderCleanupDryRunRows");
    const selectedRows = panel.querySelector("#wbSettingsFolderCleanupDryRunSelectedRows");
    const reasonCodes = panel.querySelector("#wbSettingsFolderCleanupDryRunReasonCodes");
    const json = panel.querySelector("#wbSettingsFolderCleanupDryRunJson");
    const copy = panel.querySelector("#wbSettingsFolderCleanupDryRunCopy");
    const box = panel.querySelector("#wbSettingsFolderCleanupDryRunBox");
    if (summary) summary.textContent = "Selection changed. Generate a fresh dry-run plan. No cleanup is performed.";
    if (rows) {
      rows.removeAttribute("data-folder-cleanup-dry-run-rendered");
      rows.innerHTML = "";
    }
    if (box) box.removeAttribute("data-folder-cleanup-dry-run-rendered");
    if (selectedRows) selectedRows.innerHTML = "";
    if (reasonCodes) reasonCodes.innerHTML = "";
    if (json) {
      json.hidden = true;
      json.textContent = "";
      json.removeAttribute("data-folder-cleanup-dry-run-rendered");
    }
    if (copy) copy.disabled = true;
    settingsFolderCleanupClearApplyPreview(panel);
  }, true);
}

function settingsFolderParitySetActiveTab(panel, tabId){
  let next = String(tabId || "overview").trim() || "overview";
  if (!folderOperatorModeEnabled() && (next === "local-review" || next === "cleanup-review")) {
    next = "overview";
  }
  FOLDER_PARITY_SETTINGS_UI_STATE.activeTab = next;
  panel?.querySelectorAll?.("[data-folder-parity-panel]")?.forEach((el) => {
    const active = el.getAttribute("data-folder-parity-panel") === next;
    el.hidden = !active;
    el.style.display = active ? "flex" : "none";
  });
  panel?.querySelectorAll?.("[data-folder-parity-tab]")?.forEach((btn) => {
    const active = btn.getAttribute("data-folder-parity-tab") === next;
    btn.setAttribute("aria-selected", active ? "true" : "false");
    btn.style.cssText = settingsFolderParityPanelTabStyle(active);
  });
  settingsFolderParityUpdateActiveViewMarker(panel);
}

function settingsFolderCleanupSubtabStyle(active){
  return [
    "padding:6px 9px",
    "border-radius:7px",
    "border:1px solid " + (active ? "rgba(96,165,250,.42)" : "rgba(255,255,255,.10)"),
    "background:" + (active ? "rgba(96,165,250,.14)" : "rgba(255,255,255,.035)"),
    "color:inherit",
    "font:inherit",
    "font-size:12px",
    "cursor:pointer",
    "pointer-events:auto",
  ].join(";");
}

function settingsFolderSectionActive(scope, fallback){
  const key = String(scope || "").trim();
  const stored = key ? FOLDER_PARITY_SETTINGS_UI_STATE.sectionTabs[key] : "";
  return String(stored || fallback || "summary").trim() || "summary";
}

function settingsFolderSectionTabStyle(active){
  return [
    "padding:5px 8px",
    "border-radius:999px",
    "border:1px solid " + (active ? "rgba(96,165,250,.42)" : "rgba(255,255,255,.10)"),
    "background:" + (active ? "rgba(96,165,250,.14)" : "rgba(255,255,255,.025)"),
    "color:inherit",
    "font:inherit",
    "font-size:11px",
    "cursor:pointer",
    "pointer-events:auto",
  ].join(";");
}

function settingsFolderSectionTabsHtml(scope, tabs, fallback){
  const key = String(scope || "").trim();
  const rows = Array.isArray(tabs) ? tabs : [];
  const active = settingsFolderSectionActive(key, fallback || rows[0]?.id || "summary");
  return `
    <div role="tablist" aria-label="${esc(key || "Folder section")} sections" data-folder-section-tabs="${esc(key)}" style="display:flex;gap:6px;flex-wrap:wrap">
      ${rows.map((tab) => {
        const id = String(tab?.id || "").trim();
        const label = String(tab?.label || id || "Section");
        const isActive = id === active;
        return `<button type="button" role="tab" data-folder-section-scope="${esc(key)}" data-folder-section-tab="${esc(id)}" aria-selected="${isActive ? "true" : "false"}" style="${settingsFolderSectionTabStyle(isActive)}">${esc(label)}</button>`;
      }).join("")}
    </div>
  `;
}

function settingsFolderSectionPanelAttrs(scope, id, fallback){
  const key = String(scope || "").trim();
  const panelId = String(id || "").trim();
  const active = settingsFolderSectionActive(key, fallback || panelId);
  const isActive = panelId === active;
  return `data-folder-section-scope="${esc(key)}" data-folder-section-panel="${esc(panelId)}" ${isActive ? "" : "hidden"} style="display:${isActive ? "flex" : "none"};flex-direction:column;gap:8px"`;
}

function settingsFolderSectionSetActive(panel, scope, sectionId){
  const key = String(scope || "").trim();
  const next = String(sectionId || "").trim();
  if (!panel || !key || !next) return;
  FOLDER_PARITY_SETTINGS_UI_STATE.sectionTabs[key] = next;
  panel.querySelectorAll("[data-folder-section-panel]").forEach((el) => {
    if (el.getAttribute("data-folder-section-scope") !== key) return;
    const active = el.getAttribute("data-folder-section-panel") === next;
    el.hidden = !active;
    el.style.display = active ? "flex" : "none";
  });
  panel.querySelectorAll("[data-folder-section-tab]").forEach((btn) => {
    if (btn.getAttribute("data-folder-section-scope") !== key) return;
    const active = btn.getAttribute("data-folder-section-tab") === next;
    btn.setAttribute("aria-selected", active ? "true" : "false");
    btn.style.cssText = settingsFolderSectionTabStyle(active);
  });
  settingsFolderParityUpdateActiveViewMarker(panel);
}

function settingsFolderParityActiveViewId(){
  const main = String(FOLDER_PARITY_SETTINGS_UI_STATE.activeTab || "overview").trim() || "overview";
  const parts = [main];
  if (main === "cleanup-review") {
    const cleanup = String(FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab || "overview").trim() || "overview";
    parts.push(cleanup === "apply-preview" ? "preview-gate" : cleanup);
    const sectionScope = cleanup === "apply-preview" ? "cleanup-apply-preview" : `cleanup-${cleanup}`;
    const sectionFallback = cleanup === "apply-preview" ? "controls" : "summary";
    const section = settingsFolderSectionActive(sectionScope, sectionFallback);
    if (section) parts.push(section);
  } else {
    const section = settingsFolderSectionActive(`parity-${main}`, main === "canonical" ? "rows" : "summary");
    if (section) parts.push(section);
  }
  return parts.join(".");
}

function settingsFolderParityUpdateActiveViewMarker(panel){
  const root = panel?.querySelector?.("#wbSettingsFolderParityBox");
  if (!root) return;
  root.setAttribute("data-folder-parity-active-view", settingsFolderParityActiveViewId());
}

function settingsFolderParityScrollTo(panel, target){
  const container = panel || document.getElementById("viewSettingsPanel");
  const el = target || container?.querySelector?.("#wbSettingsFolderParityBox");
  if (!container || !el) return;
  try {
    const containerRect = container.getBoundingClientRect();
    const targetRect = el.getBoundingClientRect();
    const nextTop = Math.max(0, container.scrollTop + targetRect.top - containerRect.top - 10);
    if (typeof container.scrollTo === "function") container.scrollTo({ top: nextTop, behavior: "auto" });
    else container.scrollTop = nextTop;
  } catch {
    try { el.scrollIntoView({ block: "start", inline: "nearest" }); } catch {}
  }
}

function settingsFolderCleanupSetActiveSubtab(panel, subtabId){
  const next = String(subtabId || "overview").trim() || "overview";
  FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab = next;
  panel?.querySelectorAll?.("[data-folder-cleanup-subpanel]")?.forEach((el) => {
    const active = el.getAttribute("data-folder-cleanup-subpanel") === next;
    el.hidden = !active;
    el.style.display = active ? "flex" : "none";
  });
  panel?.querySelectorAll?.("[data-folder-cleanup-subtab]")?.forEach((btn) => {
    const active = btn.getAttribute("data-folder-cleanup-subtab") === next;
    btn.setAttribute("aria-selected", active ? "true" : "false");
    btn.style.cssText = settingsFolderCleanupSubtabStyle(active);
  });
  settingsFolderParityUpdateActiveViewMarker(panel);
  if (next === "apply-preview" && panel && !panel.__h2oFolderCleanupApplyPreview) {
    const preview = FOLDER_PARITY_SETTINGS_UI_STATE.cleanupApplyPreview
      || settingsFolderCleanupApplyPreviewNoDryRun(panel.__h2oFolderCleanupReviewPlan?.surface || "");
    panel.__h2oFolderCleanupApplyPreview = preview;
    settingsFolderCleanupRenderApplyPreview(panel, preview);
  }
}

function settingsFolderParityShortId(value){
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length <= 14 ? text : `${text.slice(0, 6)}...${text.slice(-5)}`;
}

function settingsFolderParityCanonicalColor(row){
  return String(row?.iconColor || row?.color || "").trim();
}

function settingsFolderParityCanonicalStatus(row){
  if (!row?.folderId && !row?.id) return "failed";
  if (!String(row?.name || "").trim()) return "failed";
  if (row?.badges?.includes?.("count-mismatch")) return "warning";
  return "works";
}

function settingsFolderParityRenderCanonicalRows(panel, report){
  const target = panel?.querySelector?.("#wbSettingsFolderParityCanonicalRows");
  if (!target) return;
  const displayRows = Array.isArray(report?.folderDisplayRows) ? report.folderDisplayRows : [];
  const rows = displayRows.filter((row) => row?.isCanonical)
    .concat(displayRows.some((row) => row?.isCanonical) ? [] : (Array.isArray(report?.canonicalFolders) ? report.canonicalFolders : []))
    .slice(0, 12);
  if (!rows.length) {
    target.innerHTML = `<div style="opacity:.72">Canonical folder rows unavailable. Run diagnostics again.</div>`;
    return;
  }
  target.innerHTML = rows.map((row) => {
    const folderId = String(row.folderId || row.id || "").trim();
    const color = settingsFolderParityCanonicalColor(row);
    const status = settingsFolderParityCanonicalStatus(row);
    const source = String(row.source || report?.canonicalSource || "").trim();
    return `
      <div style="display:grid;grid-template-columns:34px 1fr max-content max-content max-content;gap:10px;align-items:center;padding:9px 10px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:rgba(255,255,255,.025)">
        <span title="${esc(color || "no color")}" style="width:22px;height:22px;border-radius:6px;border:1px solid rgba(255,255,255,.18);background:${esc(color || "rgba(255,255,255,.08)")};display:inline-block"></span>
        <div style="min-width:0">
          <div style="font-weight:600">${esc(row.name || folderId || "Folder")}</div>
          <div style="opacity:.62;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace">${esc(settingsFolderParityShortId(folderId))}${source ? ` · ${esc(source)}` : ""}</div>
        </div>
        <div style="font-size:12px;opacity:.8">${esc(String(row.nativeMembershipCount ?? row.canonicalCount ?? 0))} native</div>
        <div style="font-size:12px;opacity:.8">${esc(String(row.knownStudioCount ?? row.knownCount ?? 0))} known here</div>
        ${settingsFolderParityStatusBadgeHtml(status)}
      </div>
    `;
  }).join("");
}

function settingsFolderParityRenderOverview(panel, report, selfCheck){
  const health = panel?.querySelector?.("#wbSettingsFolderParityHealth");
  const meta = panel?.querySelector?.("#wbSettingsFolderParityOverviewMeta");
  if (!health && !meta) return;
  const displayRows = Array.isArray(report?.folderDisplayRows) ? report.folderDisplayRows : [];
  const canonicalRows = displayRows.filter((row) => row?.isCanonical);
  const localReviewCount = displayRows.filter((row) => row && !row.isCanonical).length;
  const hasColor = canonicalRows.some((row) => !!settingsFolderParityCanonicalColor(row));
  const canonicalStatus = Number(report?.canonicalFolderCount || 0) >= 6 && !(report?.missingCanonicalFolders || []).length ? "works" : "warning";
  const colorStatus = hasColor ? "works" : "warning";
  const localReviewStatus = localReviewCount > 0 || (report?.extraLocalFolders || []).length ? "warning" : "works";
  const desktopMirrorStatus = STUDIO_isTauri() ? "warning" : "not-tested";
  const operationsStatus = "warning";
  if (health) {
    health.innerHTML = [
      settingsFolderParityStatusCardHtml("overviewCanonical", "Canonical", canonicalStatus, `${Number(report?.canonicalFolderCount || 0)} folders`),
      settingsFolderParityStatusCardHtml("overviewColors", "Colors", colorStatus, hasColor ? "canonical source" : "no color evidence"),
      settingsFolderParityStatusCardHtml("overviewLocalReview", "Local Review", localReviewStatus, localReviewCount ? `${localReviewCount} rows` : "separated"),
      settingsFolderParityStatusCardHtml("overviewDesktopMirror", "Desktop Mirror", desktopMirrorStatus, STUDIO_isTauri() ? "manual refresh path" : "Desktop only"),
      settingsFolderParityStatusCardHtml("overviewOperations", "Operations", operationsStatus, "rename/delete protected"),
    ].join("");
  }
  if (meta) {
    meta.innerHTML = settingsSyncRowsHtml([
      ["Last checked", report?.generatedAt || new Date().toISOString()],
      ["Surface", report?.surface || ""],
      ["Canonical source", report?.canonicalSource || ""],
      ["Self-check", selfCheck ? `${selfCheck.ok ? "ok" : "review"} · ${selfCheck.severity || ""}` : "unavailable"],
    ]);
  }
}

function settingsFolderParityRenderLocalReview(panel, report){
  const summary = panel?.querySelector?.("#wbSettingsFolderParityLocalReviewSummary");
  if (!summary) return;
  const displayRows = Array.isArray(report?.folderDisplayRows) ? report.folderDisplayRows : [];
  const reviewRows = displayRows.filter((row) => row && !row.isCanonical);
  const leakCount = displayRows.filter((row) => row?.isCanonical && row?.badges?.includes?.("extra")).length;
  const status = leakCount > 0 ? "failed" : (reviewRows.length ? "warning" : "works");
  const detail = leakCount > 0
    ? `${leakCount} possible main-list leakage`
    : reviewRows.length
      ? `${reviewRows.length} review row(s)`
      : "Separated correctly";
  summary.innerHTML = `${settingsFolderParityStatusBadgeHtml(status)} <span style="opacity:.72">${esc(detail)}</span>`;
}

function settingsFolderParityRenderOperationRows(panel){
  const target = panel?.querySelector?.("#wbSettingsFolderParityOperationsRows");
  if (!target) return;
  let diag = null;
  try { diag = W.H2O?.Studio?.sync?.folderMetadataOperations?.diagnose?.() || null; } catch {}
  const lastResultStatus = String(diag?.lastResultStatus || "");
  const lastRequestMode = String(diag?.lastRequestMode || "");
  const transportBlocker = String(diag?.transportBlocker || "");
  const bridgeStatus = transportBlocker ? "disabled" : (lastResultStatus === "ok" ? "works" : (lastResultStatus === "blocked" || lastResultStatus === "timeout" ? "failed" : "not-tested"));
  const previewStatus = lastRequestMode === "preview" && lastResultStatus === "ok" ? "works" : bridgeStatus === "failed" ? "failed" : "not-tested";
  const applyStatus = lastRequestMode === "apply" && lastResultStatus === "ok" ? "works" : "not-tested";
  const saved = (key, title, fallbackStatus, fallbackDetail) => {
    const entry = FOLDER_PARITY_SETTINGS_UI_STATE.statuses[key] || {};
    return [title, entry.status || fallbackStatus, entry.detail || fallbackDetail || ""];
  };
  const rows = [
    saved("folderDiagnostics", "Folder diagnostics", "not-tested", "run diagnostics"),
    saved("cleanupReview", "Cleanup candidate review", "not-tested", "review-only"),
    saved("conflictReview", "Same-name conflict review", "not-tested", "review-only"),
    saved("desktopReview", "Desktop cleanup review", STUDIO_isTauri() ? "not-tested" : "disabled", STUDIO_isTauri() ? "Desktop only" : "Desktop only"),
    saved("orphanBindingReview", "Orphan binding review", STUDIO_isTauri() ? "not-tested" : "disabled", STUDIO_isTauri() ? "Desktop only" : "Desktop only"),
    saved("mirrorRefresh", "Desktop mirror refresh", STUDIO_isTauri() ? "warning" : "disabled", STUDIO_isTauri() ? "manual reviewed refresh" : "Desktop only"),
    ["Native owner API", bridgeStatus, transportBlocker || (lastResultStatus === "ok" ? "last native result ok" : "available through bridge diagnostics")],
    ["Native color apply", applyStatus, applyStatus === "works" ? "last apply result ok" : "not run in this panel"],
    ["Chrome -> Native preview bridge", previewStatus, previewStatus === "works" ? "preview result received" : (transportBlocker || "not recently tested")],
    ["Chrome -> Native color sync", applyStatus, applyStatus === "works" ? "color apply result received" : "not recently tested"],
    ["Rename", "disabled", "planned; protected"],
    ["Delete", "disabled", "planned; protected"],
  ];
  target.innerHTML = rows.map(([name, status, detail]) => `
    <div style="display:grid;grid-template-columns:minmax(180px,1fr) max-content 1.4fr;gap:10px;align-items:center;padding:9px 10px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:rgba(255,255,255,.025)">
      <div style="font-weight:600">${esc(name)}</div>
      ${settingsFolderParityStatusBadgeHtml(status)}
      <div style="opacity:.72;font-size:12px">${esc(detail || "")}</div>
    </div>
  `).join("");
}

function settingsFolderCleanupNumber(value){
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function settingsFolderCleanupRowBindingCount(row){
  return Math.max(
    settingsFolderCleanupNumber(row?.bindingCount),
    settingsFolderCleanupNumber(row?.localBindingCount)
  );
}

function settingsFolderCleanupIsF5DReviewCandidate(row){
  const src = row && typeof row === "object" ? row : {};
  const parts = [
    src.folderId,
    src.id,
    src.name,
    src.normalizedName,
  ].map((value) => String(value || ""));
  return parts.some((value) => /f5d/i.test(value));
}

function settingsFolderCleanupReviewCandidate(row, classification, opts = {}){
  const src = row && typeof row === "object" ? row : {};
  const folderId = String(src.folderId || src.id || opts.folderId || "").trim();
  const name = String(src.name || opts.name || folderId || "Folder review item").trim();
  const knownCount = settingsFolderCleanupNumber(src.knownCount ?? src.knownStudioCount);
  const localBindingCount = settingsFolderCleanupRowBindingCount(src);
  const bindingCount = Math.max(localBindingCount, knownCount);
  const canonicalCount = settingsFolderCleanupNumber(src.canonicalCount ?? src.nativeMembershipCount);
  const orphanCount = settingsFolderCleanupNumber(src.orphanCount || opts.orphanCount);
  const warnings = Array.isArray(opts.warnings) ? opts.warnings.slice() : [];
  const badges = Array.isArray(src.badges) ? src.badges.map((badge) => String(badge || "").trim()).filter(Boolean) : [];
  const isCanonical = !!src.isCanonical || !!opts.isCanonical;
  const isConflict = !!src.isConflict || classification === "same-name-conflict";
  const isTestCandidate = !!src.isTestCandidate;
  const isExtra = !!src.isExtra;
  const nativePresence = isCanonical || !!opts.nativePresence;

  if (isCanonical) warnings.push("Protected canonical folder. Never a cleanup candidate.");
  if (isConflict) warnings.push("Same-name/different-ID conflict. Review-only; no automatic merge.");
  if (bindingCount > 0 && !isCanonical) warnings.push("Folder has local bindings or known rows. Review-only.");
  if (orphanCount > 0) warnings.push("Native memberships are not represented by known Studio rows.");
  if (settingsFolderCleanupIsF5DReviewCandidate(src)) {
    warnings.push("Desktop/F5D review required.");
    warnings.push("Not eligible for Chrome mirror P7b deletion.");
  }

  let proposedAction = "Review only. No P7a mutation is available.";
  let riskLevel = "review";
  let requiresApproval = true;
  if (classification === "safe-empty") {
    proposedAction = "Future P8i cleanup candidate only after explicit preview and typed approval.";
    riskLevel = "low-review-required";
  } else if (classification === "orphan-membership") {
    proposedAction = "Review membership coverage. Not a folder removal candidate.";
    riskLevel = "review-required";
  } else if (classification === "canonical-protected") {
    proposedAction = "Preserve canonical folder.";
    riskLevel = "protected";
    requiresApproval = false;
  } else if (classification === "bound-review") {
    proposedAction = "Inspect bindings before any future action.";
    riskLevel = "high-review-required";
  } else if (classification === "same-name-conflict") {
    proposedAction = "Resolve only through a future conflict review plan.";
    riskLevel = "high-review-required";
  } else if (classification === "unsafe-to-delete") {
    proposedAction = "Keep review-only until a later plan explains exact ownership and blockers.";
    riskLevel = "high-review-required";
  }

  return {
    folderId,
    name,
    normalizedName: String(src.normalizedName || name).trim().toLowerCase(),
    classification,
    source: String(src.source || opts.source || "").trim(),
    kind: String(src.kind || opts.kind || "").trim(),
    surface: String(opts.surface || src.surface || ""),
    isCanonical,
    isExtra,
    isTestCandidate,
    isConflict,
    bindingCount,
    canonicalCount,
    nativeMembershipCount: canonicalCount,
    knownCount,
    localBindingCount,
    savedCount: settingsFolderCleanupNumber(src.savedCount),
    linkedCount: settingsFolderCleanupNumber(src.linkedCount),
    orphanCount,
    badges,
    displayCountLabel: String(src.displayCountLabel || opts.displayCountLabel || "").trim(),
    nativePresence,
    proposedAction,
    riskLevel,
    requiresApproval,
    reversible: false,
    warnings: Array.from(new Set(warnings.filter(Boolean))),
  };
}

function settingsFolderCleanupBuildReviewPlan(selfCheck, displayModel){
  const rows = Array.isArray(displayModel?.rows) ? displayModel.rows : [];
  const surface = String(selfCheck?.surface || displayModel?.surface || "");
  const rowCandidate = (row, classification, opts = {}) => settingsFolderCleanupReviewCandidate(row, classification, { ...opts, surface });
  const isSafeEmpty = (row) => {
    const bindingCount = settingsFolderCleanupRowBindingCount(row);
    const knownCount = settingsFolderCleanupNumber(row?.knownCount);
    return !row?.isCanonical
      && (!!row?.isExtra || !!row?.isTestCandidate)
      && !row?.isConflict
      && !settingsFolderCleanupIsF5DReviewCandidate(row)
      && bindingCount === 0
      && knownCount === 0;
  };
  const safeEmptyCandidates = rows
    .filter(isSafeEmpty)
    .map((row) => rowCandidate(row, "safe-empty", { nativePresence: false }));
  const sameNameConflicts = rows
    .filter((row) => !row?.isCanonical && !!row?.isConflict)
    .map((row) => rowCandidate(row, "same-name-conflict", { nativePresence: false }));
  const boundReviewCandidates = rows
    .filter((row) => {
      const bindingCount = settingsFolderCleanupRowBindingCount(row);
      const knownCount = settingsFolderCleanupNumber(row?.knownCount);
      return !row?.isCanonical
        && (!!row?.isExtra || !!row?.isTestCandidate)
        && !row?.isConflict
        && (bindingCount > 0 || knownCount > 0 || settingsFolderCleanupIsF5DReviewCandidate(row));
    })
    .map((row) => rowCandidate(row, "bound-review", { nativePresence: false }));
  const orphanRows = rows
    .filter((row) => !!row?.isCanonical && settingsFolderCleanupNumber(row?.orphanCount) > 0)
    .map((row) => rowCandidate(row, "orphan-membership", {
      isCanonical: true,
      nativePresence: true,
      orphanCount: settingsFolderCleanupNumber(row?.orphanCount),
    }));
  const orphanCheck = (Array.isArray(selfCheck?.checks) ? selfCheck.checks : [])
    .find((check) => String(check?.id || "") === "folder.binding.orphan");
  const orphanCount = settingsFolderCleanupNumber(selfCheck?.summary?.orphanMembershipCount || orphanCheck?.details?.orphanMembershipCount);
  const orphanMemberships = orphanRows.length || orphanCount === 0
    ? orphanRows
    : [settingsFolderCleanupReviewCandidate({
      name: "Canonical orphan memberships",
      orphanCount,
      knownCount: settingsFolderCleanupNumber(orphanCheck?.details?.knownStudioRowTotal),
    }, "orphan-membership", {
      surface,
      orphanCount,
      nativePresence: true,
      warnings: ["Aggregate self-check item. It is not a folder deletion candidate."],
    })];
  const canonicalProtected = rows
    .filter((row) => !!row?.isCanonical)
    .map((row) => rowCandidate(row, "canonical-protected", { isCanonical: true, nativePresence: true }));
  const groupedIds = new Set([
    ...safeEmptyCandidates,
    ...sameNameConflicts,
    ...boundReviewCandidates,
  ].map((candidate) => String(candidate.folderId || "").trim()).filter(Boolean));
  const unsafeToDelete = rows
    .filter((row) => {
      const id = String(row?.folderId || row?.id || "").trim();
      return !row?.isCanonical && id && !groupedIds.has(id);
    })
    .map((row) => rowCandidate(row, "unsafe-to-delete", {
      nativePresence: false,
      warnings: ["Review row does not meet empty-test cleanup requirements."],
    }));

  const groups = {
    safeEmptyCandidates,
    sameNameConflicts,
    boundReviewCandidates,
    orphanMemberships,
    canonicalProtected,
    unsafeToDelete,
  };
  return {
    readOnly: true,
    noMutation: true,
    generatedAt: new Date().toISOString(),
    surface,
    selfCheckSummary: selfCheck?.summary || null,
    selfCheckSeverity: selfCheck?.severity || "",
    counts: {
      safeEmpty: safeEmptyCandidates.length,
      conflicts: sameNameConflicts.length,
      boundReview: boundReviewCandidates.length,
      orphanMemberships: orphanMemberships.length,
      canonicalProtected: canonicalProtected.length,
      unsafeToDelete: unsafeToDelete.length,
    },
    groups,
    safetyRules: [
      "P8i-c1 is review-only.",
      "No folder cleanup is performed.",
      "No Chrome storage, SQLite, or native folder-state writes are performed.",
      "Canonical f_* folders are protected.",
      "Conflicts and bound folders are review-only.",
      "Desktop/F5D test folders are review-only in P8i-c1.",
    ],
  };
}

async function settingsFolderCleanupLoadReviewInputs(){
  const parity = W.H2O?.Library?.FolderParity;
  if (!parity || typeof parity.selfCheck !== "function" || typeof parity.getDisplayModel !== "function") {
    throw new Error("FolderParity review APIs unavailable");
  }
  const selfCheck = await promiseWithTimeout(parity.selfCheck({ fresh: true }), STUDIO_BOOT_AUX_TIMEOUT_MS, "FolderParity.selfCheck");
  const displayModel = await promiseWithTimeout(parity.getDisplayModel({ fresh: true }), STUDIO_BOOT_AUX_TIMEOUT_MS, "FolderParity.getDisplayModel");
  return {
    selfCheck,
    displayModel,
    plan: settingsFolderCleanupBuildReviewPlan(selfCheck, displayModel),
  };
}

function settingsFolderCleanupIsChromeSurface(){
  return hasChromeStorage() && !STUDIO_isTauri();
}

function settingsFolderCleanupChromeGetStrict(keys){
  if (!settingsFolderCleanupIsChromeSurface()) return Promise.reject(new Error("Chrome storage unavailable for folder cleanup."));
  return new Promise((resolve, reject) => {
    try {
      W.chrome.storage.local.get(keys, (result) => {
        const lastError = W.chrome?.runtime?.lastError;
        if (lastError) { reject(new Error(String(lastError.message || lastError))); return; }
        resolve(result || {});
      });
    } catch (err) {
      reject(err);
    }
  });
}

function settingsFolderCleanupChromeSetStrict(obj){
  if (!settingsFolderCleanupIsChromeSurface()) return Promise.reject(new Error("Chrome storage unavailable for folder cleanup."));
  return new Promise((resolve, reject) => {
    try {
      W.chrome.storage.local.set(obj || {}, () => {
        const lastError = W.chrome?.runtime?.lastError;
        if (lastError) { reject(new Error(String(lastError.message || lastError))); return; }
        resolve(true);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function settingsFolderCleanupClone(value){
  if (value == null) return value;
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return value; }
}

function settingsFolderCleanupSelectedIds(panel){
  const boxes = Array.from(panel?.querySelectorAll?.("#wbSettingsFolderCleanupDeleteList input[data-folder-id]") || []);
  return boxes
    .filter((box) => !!box.checked)
    .map((box) => String(box.dataset.folderId || "").trim())
    .filter(Boolean);
}

function settingsFolderCleanupFolderStateSummary(stateObj){
  const src = stateObj && typeof stateObj === "object" ? stateObj : {};
  const folders = Array.isArray(src.folders) ? src.folders : [];
  const items = src.items && typeof src.items === "object" && !Array.isArray(src.items) ? src.items : {};
  const bindingCount = Object.values(items).reduce((sum, values) => sum + (Array.isArray(values) ? values.length : 0), 0);
  return {
    key: FOLDER_STATE_DATA_KEY,
    folderCount: folders.length,
    itemBucketCount: Object.keys(items).length,
    bindingCount,
  };
}

function settingsFolderMirrorStableStringify(value){
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(settingsFolderMirrorStableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${settingsFolderMirrorStableStringify(value[key])}`).join(",")}}`;
}

async function settingsFolderMirrorChecksum(value){
  const text = settingsFolderMirrorStableStringify(value);
  try {
    const bytes = new TextEncoder().encode(text);
    const digest = await W.crypto.subtle.digest("SHA-256", bytes);
    return "sha256:" + Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch (_) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `fnv32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }
}

function settingsFolderMirrorDecodeText(raw){
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return new TextDecoder("utf-8").decode(new Uint8Array(raw));
  if (ArrayBuffer.isView(raw)) return new TextDecoder("utf-8").decode(raw);
  if (Array.isArray(raw)) return new TextDecoder("utf-8").decode(new Uint8Array(raw));
  throw new Error("Unsupported file read result.");
}

async function settingsFolderMirrorReadTextFile(path){
  const invoke = STUDIO_getTauriInvoke();
  if (!invoke) throw new Error("Tauri file read unavailable.");
  try {
    return settingsFolderMirrorDecodeText(await invoke("plugin:fs|read_text_file", { path }));
  } catch (textErr) {
    try {
      return settingsFolderMirrorDecodeText(await invoke("plugin:fs|read_file", { path }));
    } catch (bytesErr) {
      throw new Error(String(textErr && (textErr.message || textErr)) + " / fallback read_file failed: " + String(bytesErr && (bytesErr.message || bytesErr)));
    }
  }
}

function settingsFolderMirrorFolderId(row){
  return String(row?.id || row?.folderId || "").trim();
}

function settingsFolderMirrorFolderName(row, fallback = ""){
  return String(row?.name || row?.title || fallback || "").trim();
}

function settingsFolderMirrorVisualColor(row){
  return String(row?.iconColor || row?.color || "").trim();
}

function settingsFolderMirrorCanonicalRowMap(stateObj){
  const folders = Array.isArray(stateObj?.folders) ? stateObj.folders : [];
  const byId = new Map();
  folders.forEach((row) => {
    const id = settingsFolderMirrorFolderId(row);
    if (id && !byId.has(id)) byId.set(id, row);
  });
  return byId;
}

function settingsFolderMirrorNormalizeState(raw, sourceKind){
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    sourceKind: String(sourceKind || "folder-state"),
    schemaVersion: Number(src.schemaVersion || src.version || 1) || 1,
    exportedFrom: String(src.exportedFrom || src.source || "").trim(),
    exportedAt: String(src.exportedAt || src.updatedAt || "").trim(),
    folders: Array.isArray(src.folders) ? src.folders.slice() : null,
    items: src.items && typeof src.items === "object" && !Array.isArray(src.items) ? src.items : null,
  };
}

function settingsFolderMirrorExtractState(payload){
  const raw = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  if (!raw) return { ok: false, error: "Folder-state JSON must be an object." };
  const csl = raw.chromeStorageLocal && typeof raw.chromeStorageLocal === "object" && !Array.isArray(raw.chromeStorageLocal)
    ? raw.chromeStorageLocal
    : null;
  if (csl && csl[FOLDER_STATE_DATA_KEY] && typeof csl[FOLDER_STATE_DATA_KEY] === "object") {
    return { ok: true, state: settingsFolderMirrorNormalizeState(csl[FOLDER_STATE_DATA_KEY], "chromeStorageLocal-wrapper") };
  }
  if (raw.folderState && typeof raw.folderState === "object" && !Array.isArray(raw.folderState)) {
    return { ok: true, state: settingsFolderMirrorNormalizeState(raw.folderState, "folderState-wrapper") };
  }
  if (raw.payload?.folderState && typeof raw.payload.folderState === "object" && !Array.isArray(raw.payload.folderState)) {
    return { ok: true, state: settingsFolderMirrorNormalizeState(raw.payload.folderState, "payload.folderState-wrapper") };
  }
  if (raw.value?.folderState && typeof raw.value.folderState === "object" && !Array.isArray(raw.value.folderState)) {
    return { ok: true, state: settingsFolderMirrorNormalizeState(raw.value.folderState, "value.folderState-wrapper") };
  }
  if (Array.isArray(raw.folders) || (raw.items && typeof raw.items === "object" && !Array.isArray(raw.items))) {
    return { ok: true, state: settingsFolderMirrorNormalizeState(raw, "raw-folder-state") };
  }
  return { ok: false, error: "Unrecognized folder-state shape." };
}

function settingsFolderMirrorSourceSummary(state){
  const folders = Array.isArray(state?.folders) ? state.folders : [];
  const items = state?.items && typeof state.items === "object" && !Array.isArray(state.items) ? state.items : {};
  return {
    sourceKind: state?.sourceKind || "",
    exportedAt: state?.exportedAt || "",
    exportedFrom: state?.exportedFrom || "",
    folderCount: folders.length,
    bindingCount: Object.values(items).reduce((sum, values) => sum + (Array.isArray(values) ? values.length : 0), 0),
    canonicalFolderCount: folders.filter((row) => FOLDER_DESKTOP_MIRROR_CANONICAL_ROWS.some((known) => known.folderId === settingsFolderMirrorFolderId(row))).length,
  };
}

function settingsFolderMirrorProjectCanonicalState(sourceState, opts = {}){
  const blockers = [];
  if (!Array.isArray(sourceState?.folders)) blockers.push("Source folders[] is missing or malformed.");
  if (!sourceState?.items || typeof sourceState.items !== "object" || Array.isArray(sourceState.items)) blockers.push("Source items object is missing or malformed.");
  if (blockers.length) return { ok: false, error: blockers.join(" "), blockers };
  const refreshedAt = String(opts?.refreshedAt || "").trim() || new Date().toISOString();

  const folders = sourceState.folders;
  const items = sourceState.items;
  const byId = new Map();
  folders.forEach((row) => {
    const id = settingsFolderMirrorFolderId(row);
    if (id && !byId.has(id)) byId.set(id, row);
  });
  const missing = FOLDER_DESKTOP_MIRROR_CANONICAL_ROWS.filter((known) => !byId.has(known.folderId));
  if (missing.length) blockers.push("Missing canonical folder row(s): " + missing.map((row) => row.name).join(", "));

  const projectedFolders = [];
  const projectedItems = {};
  FOLDER_DESKTOP_MIRROR_CANONICAL_ROWS.forEach((known, index) => {
    const row = byId.get(known.folderId);
    if (!row) return;
    const copy = settingsFolderCleanupClone(row) || {};
    copy.id = known.folderId;
    copy.name = settingsFolderMirrorFolderName(copy, known.name) || known.name;
    if (!Number.isFinite(Number(copy.sortOrder)) && !Number.isFinite(Number(copy.sort_order))) copy.sortOrder = index + 1;
    projectedFolders.push(copy);
    const bucket = items[known.folderId];
    if (bucket != null && !Array.isArray(bucket)) {
      blockers.push(`Items bucket for ${known.name} is not an array.`);
      projectedItems[known.folderId] = [];
      return;
    }
    projectedItems[known.folderId] = Array.from(new Set((Array.isArray(bucket) ? bucket : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)));
  });

  if (blockers.length) return { ok: false, error: blockers.join(" "), blockers };
  return {
    ok: true,
    ignoredFolderCount: Math.max(0, folders.length - projectedFolders.length),
    state: {
      schemaVersion: Number(sourceState.schemaVersion || 1) || 1,
      exportedFrom: sourceState.exportedFrom || sourceState.sourceKind || "desktop-folder-mirror-refresh",
      exportedAt: sourceState.exportedAt || refreshedAt,
      refreshedAt,
      folders: projectedFolders,
      items: projectedItems,
    },
  };
}

function settingsFolderMirrorSummary(stateObj){
  const src = stateObj && typeof stateObj === "object" ? stateObj : {};
  const folders = Array.isArray(src.folders) ? src.folders : [];
  const items = src.items && typeof src.items === "object" && !Array.isArray(src.items) ? src.items : {};
  const byId = settingsFolderMirrorCanonicalRowMap(src);
  const perFolder = FOLDER_DESKTOP_MIRROR_CANONICAL_ROWS.map((known) => {
    const folderRow = byId.get(known.folderId) || null;
    return {
      folderId: known.folderId,
      name: settingsFolderMirrorFolderName(folderRow, known.name) || known.name,
      membershipCount: Array.isArray(items[known.folderId]) ? items[known.folderId].length : 0,
      color: settingsFolderMirrorVisualColor(folderRow),
    };
  });
  return {
    key: FOLDER_STATE_DATA_KEY,
    folderCount: folders.length,
    itemBucketCount: Object.keys(items).length,
    bindingCount: Object.values(items).reduce((sum, values) => sum + (Array.isArray(values) ? values.length : 0), 0),
    studyBucketCount: perFolder.find((row) => row.folderId === "f_7050f49d3f341819dba53d547")?.membershipCount || 0,
    exportedAt: src.exportedAt || "",
    refreshedAt: src.refreshedAt || "",
    perFolder,
  };
}

function settingsFolderMirrorColorDeltaRows(beforeSummary, afterSummary){
  const beforeRows = new Map((beforeSummary?.perFolder || []).map((row) => [row.folderId, row]));
  const afterRows = new Map((afterSummary?.perFolder || []).map((row) => [row.folderId, row]));
  return FOLDER_DESKTOP_MIRROR_CANONICAL_ROWS.map((known) => {
    const before = beforeRows.get(known.folderId) || {};
    const after = afterRows.get(known.folderId) || {};
    const beforeColor = String(before.color || "").trim();
    const afterColor = String(after.color || "").trim();
    return {
      folderId: known.folderId,
      name: known.name,
      beforeColor,
      afterColor,
      colorChanged: beforeColor !== afterColor,
    };
  });
}

function settingsFolderMirrorNameDeltaRows(beforeSummary, afterSummary){
  const beforeRows = new Map((beforeSummary?.perFolder || []).map((row) => [row.folderId, row]));
  const afterRows = new Map((afterSummary?.perFolder || []).map((row) => [row.folderId, row]));
  return FOLDER_DESKTOP_MIRROR_CANONICAL_ROWS.map((known) => {
    const before = beforeRows.get(known.folderId) || {};
    const after = afterRows.get(known.folderId) || {};
    const beforeName = String(before.name || "").trim();
    const afterName = String(after.name || "").trim();
    return {
      folderId: known.folderId,
      name: known.name,
      beforeName,
      afterName,
      nameChanged: beforeName !== afterName,
    };
  });
}

async function settingsFolderMirrorReadSourceFromPanel(panel){
  const pasted = String(panel?.querySelector?.("#wbSettingsFolderMirrorRefreshJson")?.value || "").trim();
  const path = String(panel?.querySelector?.("#wbSettingsFolderMirrorRefreshPath")?.value || "").trim();
  FOLDER_DESKTOP_MIRROR_REFRESH_STATE.pastedJson = pasted;
  FOLDER_DESKTOP_MIRROR_REFRESH_STATE.path = path;
  const text = pasted || (path ? await settingsFolderMirrorReadTextFile(path) : "");
  if (!text) throw new Error("Paste folder-state JSON or choose a source file.");
  let payload;
  try { payload = JSON.parse(text); }
  catch (err) { throw new Error("Folder-state JSON parse failed: " + String(err && (err.message || err))); }
  const extracted = settingsFolderMirrorExtractState(payload);
  if (!extracted.ok) throw new Error(extracted.error || "Folder-state extraction failed.");
  return {
    sourceKind: pasted ? "pasted-json:" + extracted.state.sourceKind : "file:" + extracted.state.sourceKind,
    sourcePath: pasted ? "" : path,
    sourceState: extracted.state,
  };
}

async function settingsFolderMirrorBuildPreview(panel, opts = {}){
  if (!STUDIO_isTauri()) return { ok: false, error: "Desktop folder mirror refresh is only available in Desktop Studio." };
  const generatedAt = String(opts?.generatedAt || opts?.refreshedAt || "").trim() || new Date().toISOString();
  const source = await settingsFolderMirrorReadSourceFromPanel(panel);
  const projection = settingsFolderMirrorProjectCanonicalState(source.sourceState, { refreshedAt: generatedAt });
  if (!projection.ok) return { ok: false, error: projection.error || "Canonical projection failed.", blockers: projection.blockers || [] };
  const values = await settingsFolderDesktopStorageGetStrict([FOLDER_STATE_DATA_KEY]);
  const beforeState = settingsFolderCleanupClone(values?.[FOLDER_STATE_DATA_KEY] || {});
  const afterState = projection.state;
  const beforeSummary = settingsFolderMirrorSummary(beforeState);
  const afterSummary = settingsFolderMirrorSummary(afterState);
  const beforeChecksum = await settingsFolderMirrorChecksum(beforeState || {});
  const afterChecksum = await settingsFolderMirrorChecksum(afterState);
  const perFolderColorDeltas = settingsFolderMirrorColorDeltaRows(beforeSummary, afterSummary);
  const perFolderNameDeltas = settingsFolderMirrorNameDeltaRows(beforeSummary, afterSummary);
  const preview = {
    readOnly: false,
    noMutationUntilRefresh: true,
    generatedAt,
    refreshTimestamp: generatedAt,
    surface: "desktop-studio",
    action: "refresh-desktop-folder-state-mirror",
    targetKey: FOLDER_STATE_DATA_KEY,
    sourceKind: source.sourceKind,
    sourcePath: source.sourcePath,
    sourceSummary: settingsFolderMirrorSourceSummary(source.sourceState),
    importedRows: afterSummary.perFolder.map((row) => ({ folderId: row.folderId, name: row.name })),
    ignoredSourceFolderCount: projection.ignoredFolderCount,
    beforeSummary,
    afterSummary,
    perFolderMembershipCounts: FOLDER_DESKTOP_MIRROR_CANONICAL_ROWS.map((known) => ({
      folderId: known.folderId,
      name: known.name,
      before: beforeSummary.perFolder.find((row) => row.folderId === known.folderId)?.membershipCount || 0,
      after: afterSummary.perFolder.find((row) => row.folderId === known.folderId)?.membershipCount || 0,
      beforeName: beforeSummary.perFolder.find((row) => row.folderId === known.folderId)?.name || "",
      afterName: afterSummary.perFolder.find((row) => row.folderId === known.folderId)?.name || "",
      nameChanged: perFolderNameDeltas.find((row) => row.folderId === known.folderId)?.nameChanged || false,
      beforeColor: beforeSummary.perFolder.find((row) => row.folderId === known.folderId)?.color || "",
      afterColor: afterSummary.perFolder.find((row) => row.folderId === known.folderId)?.color || "",
      colorChanged: perFolderColorDeltas.find((row) => row.folderId === known.folderId)?.colorChanged || false,
    })),
    perFolderNameDeltas,
    perFolderColorDeltas,
    beforeChecksum,
    afterChecksum,
    confirmationText: FOLDER_DESKTOP_MIRROR_REFRESH_CONFIRM_TEXT,
    warnings: [
      "Desktop SQLite folders and folder_bindings are not changed.",
      "Native ChatGPT folder-state is not modified.",
      "Chrome storage is not modified.",
      "Only the Desktop mirror key is refreshed.",
    ],
  };
  return { ok: true, preview, beforeState, afterState };
}

function settingsFolderMirrorRenderDeltaSummary(panel, preview){
  const box = panel?.querySelector?.("#wbSettingsFolderMirrorRefreshDeltaSummary");
  if (!box) return;
  if (!preview) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  const nameRows = Array.isArray(preview.perFolderNameDeltas) ? preview.perFolderNameDeltas : [];
  const changedNameRows = nameRows.filter((row) => row?.nameChanged);
  const colorRows = Array.isArray(preview.perFolderColorDeltas) ? preview.perFolderColorDeltas : [];
  const changedColorRows = colorRows.filter((row) => row?.colorChanged);
  const membershipRows = Array.isArray(preview.perFolderMembershipCounts) ? preview.perFolderMembershipCounts : [];
  const nameLines = changedNameRows.length
    ? changedNameRows.map((row) => {
        const before = row.beforeName || "(blank)";
        const after = row.afterName || "(blank)";
        return `<div><strong>${esc(row.name || "Folder")} name:</strong> <code>${esc(before)}</code> -&gt; <code>${esc(after)}</code></div>`;
      }).join("")
    : `<div><strong>Name changes:</strong> none detected.</div>`;
  const colorLines = changedColorRows.length
    ? changedColorRows.map((row) => {
        const before = row.beforeColor || "(blank)";
        const after = row.afterColor || "(blank)";
        return `<div><strong>${esc(row.name || "Folder")} color:</strong> <code>${esc(before)}</code> -&gt; <code>${esc(after)}</code></div>`;
      }).join("")
    : `<div><strong>Color changes:</strong> none detected.</div>`;
  const memberLines = membershipRows.map((row) => (
    `<div><strong>${esc(row.name || "Folder")} members:</strong> ${Number(row.before || 0)} -&gt; ${Number(row.after || 0)}</div>`
  )).join("");
  box.hidden = false;
  box.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:4px;padding:8px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.035);border-radius:6px">
      <div style="font-weight:600">Refresh preview deltas</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:4px 12px">${nameLines}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:4px 12px">${colorLines}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:4px 12px;opacity:.78">${memberLines}</div>
    </div>
  `;
}

function settingsFolderMirrorSetPreview(panel, preview){
  panel.__h2oFolderMirrorRefreshPreview = preview || null;
  FOLDER_DESKTOP_MIRROR_REFRESH_STATE.preview = preview || null;
  settingsFolderMirrorRenderDeltaSummary(panel, preview);
  const pre = panel?.querySelector?.("#wbSettingsFolderMirrorRefreshPreviewOut");
  if (pre) {
    pre.hidden = !preview;
    pre.textContent = preview ? JSON.stringify(preview, null, 2) : "";
  }
}

function settingsFolderMirrorSetStatus(panel, message){
  const text = String(message || "");
  FOLDER_DESKTOP_MIRROR_REFRESH_STATE.status = text;
  const status = panel?.querySelector?.("#wbSettingsFolderMirrorRefreshStatus");
  if (status) status.textContent = text;
}

function settingsFolderMirrorUpdateControls(panel){
  const sourceAvailable = !!String(panel?.querySelector?.("#wbSettingsFolderMirrorRefreshJson")?.value || panel?.querySelector?.("#wbSettingsFolderMirrorRefreshPath")?.value || "").trim();
  const confirmation = String(panel?.querySelector?.("#wbSettingsFolderMirrorRefreshConfirm")?.value || "");
  FOLDER_DESKTOP_MIRROR_REFRESH_STATE.confirmation = confirmation;
  const preview = panel?.__h2oFolderMirrorRefreshPreview || FOLDER_DESKTOP_MIRROR_REFRESH_STATE.preview;
  const previewBtn = panel?.querySelector?.("#wbSettingsFolderMirrorRefreshPreview");
  const copyBtn = panel?.querySelector?.("#wbSettingsFolderMirrorRefreshCopyPlan");
  const runBtn = panel?.querySelector?.("#wbSettingsFolderMirrorRefreshRun");
  if (previewBtn) previewBtn.disabled = !STUDIO_isTauri() || !sourceAvailable;
  if (copyBtn) copyBtn.disabled = !preview;
  if (runBtn) runBtn.disabled = !STUDIO_isTauri() || !preview || confirmation !== FOLDER_DESKTOP_MIRROR_REFRESH_CONFIRM_TEXT;
}

async function settingsFolderMirrorAppendAudit(entry){
  const auditId = String(entry?.auditId || `folder-mirror-refresh:${Date.now()}:${Math.random().toString(36).slice(2)}`);
  const nextEntry = { ...(entry || {}), auditId };
  const values = await settingsFolderDesktopStorageGetStrict([FOLDER_MIRROR_REFRESH_AUDIT_KEY]);
  const existing = Array.isArray(values?.[FOLDER_MIRROR_REFRESH_AUDIT_KEY]) ? values[FOLDER_MIRROR_REFRESH_AUDIT_KEY] : [];
  const next = existing.concat([nextEntry]).slice(-50);
  await settingsFolderDesktopStorageSetStrict({ [FOLDER_MIRROR_REFRESH_AUDIT_KEY]: next });
  const verifyValues = await settingsFolderDesktopStorageGetStrict([FOLDER_MIRROR_REFRESH_AUDIT_KEY]);
  const verify = Array.isArray(verifyValues?.[FOLDER_MIRROR_REFRESH_AUDIT_KEY]) ? verifyValues[FOLDER_MIRROR_REFRESH_AUDIT_KEY] : [];
  if (!verify.some((item) => item?.auditId === auditId)) {
    throw new Error("Desktop mirror refresh audit write verification failed.");
  }
  return { length: verify.length, auditId };
}

async function previewSettingsFolderMirrorRefresh(panel){
  let result;
  settingsFolderParitySetOperationStatus(panel, "mirrorRefresh", "running", "Building preview");
  try {
    result = await settingsFolderMirrorBuildPreview(panel);
  } catch (err) {
    result = { ok: false, error: String(err && (err.stack || err.message || err)) };
  }
  if (!result.ok) {
    settingsFolderParitySetOperationStatus(panel, "mirrorRefresh", "failed", String(result.error || "Preview failed").slice(0, 96));
    settingsFolderMirrorSetPreview(panel, null);
    settingsFolderParityLog(panel, "Desktop mirror refresh preview blocked.\n" + String(result.error || "Unknown guard failure"));
    settingsFolderMirrorUpdateControls(panel);
    return result;
  }
  settingsFolderParitySetOperationStatus(panel, "mirrorRefresh", "warning", "Preview valid; confirmation required");
  settingsFolderMirrorSetPreview(panel, result.preview);
  const studyCounts = result.preview.perFolderMembershipCounts.find((row) => row.name === "Study") || {};
  const nameChangeCount = (result.preview.perFolderNameDeltas || []).filter((row) => row?.nameChanged).length;
  const colorChangeCount = (result.preview.perFolderColorDeltas || []).filter((row) => row?.colorChanged).length;
  const nameMessage = nameChangeCount ? `${nameChangeCount} name change${nameChangeCount === 1 ? "" : "s"} detected.` : "No canonical name changes detected.";
  const colorMessage = colorChangeCount ? `${colorChangeCount} color change${colorChangeCount === 1 ? "" : "s"} detected.` : "No canonical color changes detected.";
  const message = `Preview ready. Study members: ${studyCounts.before ?? 0} -> ${studyCounts.after ?? 0}. ${nameMessage} ${colorMessage} Desktop SQLite folders and folder_bindings are not changed.`;
  settingsFolderMirrorSetStatus(panel, message);
  settingsFolderMirrorUpdateControls(panel);
  return result;
}

async function copySettingsFolderMirrorRefreshPlan(panel){
  let preview = panel?.__h2oFolderMirrorRefreshPreview || FOLDER_DESKTOP_MIRROR_REFRESH_STATE.preview;
  if (!preview) {
    const result = await previewSettingsFolderMirrorRefresh(panel);
    preview = result?.preview || null;
  }
  if (!preview) return;
  const text = JSON.stringify(preview, null, 2);
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      settingsFolderParityLog(panel, "Desktop mirror refresh plan JSON copied to clipboard.");
      return;
    } catch (err) {
      console.info("H2O_DESKTOP_FOLDER_MIRROR_REFRESH_PLAN", preview);
      settingsFolderParityLog(panel, "Clipboard copy failed; Desktop mirror refresh plan printed to console.\n" + String(err && (err.message || err)));
      return;
    }
  }
  console.info("H2O_DESKTOP_FOLDER_MIRROR_REFRESH_PLAN", preview);
  settingsFolderParityLog(panel, "Clipboard unavailable; Desktop mirror refresh plan printed to console as H2O_DESKTOP_FOLDER_MIRROR_REFRESH_PLAN.");
}

async function refreshDesktopFolderMirror(panel){
  const confirmation = String(panel?.querySelector?.("#wbSettingsFolderMirrorRefreshConfirm")?.value || "");
  if (confirmation !== FOLDER_DESKTOP_MIRROR_REFRESH_CONFIRM_TEXT) {
    settingsFolderParitySetOperationStatus(panel, "mirrorRefresh", "warning", "Confirmation text does not match");
    settingsFolderMirrorSetStatus(panel, "Desktop mirror refresh blocked. Confirmation text does not match.");
    settingsFolderParityLog(panel, "Desktop mirror refresh blocked. Confirmation text does not match.");
    return;
  }
  const existingPreview = panel?.__h2oFolderMirrorRefreshPreview || FOLDER_DESKTOP_MIRROR_REFRESH_STATE.preview;
  if (!existingPreview) {
    settingsFolderParitySetOperationStatus(panel, "mirrorRefresh", "warning", "Generate a fresh preview first");
    settingsFolderMirrorSetStatus(panel, "Desktop mirror refresh blocked. Generate a fresh refresh preview first.");
    settingsFolderParityLog(panel, "Desktop mirror refresh blocked. Generate a fresh refresh preview first.");
    return;
  }
  settingsFolderParitySetOperationStatus(panel, "mirrorRefresh", "running", "Revalidating preview");
  settingsFolderMirrorSetStatus(panel, "Refreshing Desktop folder mirror: revalidating preview...");
  let fresh;
  try {
    fresh = await settingsFolderMirrorBuildPreview(panel, {
      generatedAt: existingPreview.refreshTimestamp || existingPreview.generatedAt,
    });
  } catch (err) {
    settingsFolderParitySetOperationStatus(panel, "mirrorRefresh", "failed", "Preview revalidation failed");
    settingsFolderMirrorSetStatus(panel, "Desktop mirror refresh aborted before mutation.");
    settingsFolderParityLog(panel, "Desktop mirror refresh aborted before mutation.\n" + String(err && (err.stack || err.message || err)));
    return;
  }
  if (!fresh.ok) {
    settingsFolderParitySetOperationStatus(panel, "mirrorRefresh", "failed", "Guard failed");
    settingsFolderMirrorSetStatus(panel, "Desktop mirror refresh aborted before mutation.");
    settingsFolderParityLog(panel, "Desktop mirror refresh aborted before mutation.\n" + String(fresh.error || "Guard failed"));
    return;
  }
  if (fresh.preview.afterChecksum !== existingPreview.afterChecksum || fresh.preview.beforeChecksum !== existingPreview.beforeChecksum) {
    settingsFolderParitySetOperationStatus(panel, "mirrorRefresh", "warning", "Source or mirror changed");
    settingsFolderMirrorSetPreview(panel, fresh.preview);
    settingsFolderMirrorUpdateControls(panel);
    settingsFolderMirrorSetStatus(panel, "Desktop mirror refresh aborted. Source or Desktop mirror changed since preview; review the new preview before refreshing.");
    settingsFolderParityLog(panel, "Desktop mirror refresh aborted. Source or Desktop mirror changed since preview; review the new preview before refreshing.");
    return;
  }
  const pending = {
    timestamp: new Date().toISOString(),
    surface: "desktop-studio",
    action: "refresh-desktop-folder-state-mirror",
    targetKey: FOLDER_STATE_DATA_KEY,
    sourceKind: fresh.preview.sourceKind,
    beforeSummary: fresh.preview.beforeSummary,
    afterSummary: fresh.preview.afterSummary,
    beforeChecksum: fresh.preview.beforeChecksum,
    afterChecksum: fresh.preview.afterChecksum,
    beforeSnapshot: settingsFolderCleanupClone(fresh.beforeState),
    result: "pending",
    errors: [],
  };
  try {
    settingsFolderParitySetOperationStatus(panel, "mirrorRefresh", "running", "Writing pending audit");
    settingsFolderMirrorSetStatus(panel, "Refreshing Desktop folder mirror: writing pending audit...");
    await settingsFolderMirrorAppendAudit(pending);
  } catch (auditErr) {
    settingsFolderParitySetOperationStatus(panel, "mirrorRefresh", "failed", "Audit write failed");
    settingsFolderMirrorSetStatus(panel, "Desktop mirror refresh aborted before mutation. Mirror refresh audit could not be written.");
    settingsFolderParityLog(panel, "Desktop mirror refresh aborted before mutation. Mirror refresh audit could not be written.\n" + String(auditErr && (auditErr.stack || auditErr.message || auditErr)));
    return;
  }
  try {
    settingsFolderParitySetOperationStatus(panel, "mirrorRefresh", "running", "Writing mirror key");
    settingsFolderMirrorSetStatus(panel, "Refreshing Desktop folder mirror: writing mirror key...");
    await settingsFolderDesktopStorageSetStrict({ [FOLDER_STATE_DATA_KEY]: fresh.afterState });
    const afterValues = await settingsFolderDesktopStorageGetStrict([FOLDER_STATE_DATA_KEY]);
    const verifiedChecksum = await settingsFolderMirrorChecksum(afterValues?.[FOLDER_STATE_DATA_KEY] || {});
    if (verifiedChecksum !== fresh.preview.afterChecksum) {
      throw new Error(`Desktop mirror write verification failed. Expected ${fresh.preview.afterChecksum}; got ${verifiedChecksum}.`);
    }
    const afterSummary = settingsFolderMirrorSummary(afterValues?.[FOLDER_STATE_DATA_KEY] || {});
    settingsFolderMirrorSetStatus(panel, "Refreshing Desktop folder mirror: writing result audit...");
    await settingsFolderMirrorAppendAudit({
      timestamp: new Date().toISOString(),
      surface: "desktop-studio",
      action: "refresh-desktop-folder-state-mirror",
      targetKey: FOLDER_STATE_DATA_KEY,
      sourceKind: fresh.preview.sourceKind,
      beforeSummary: fresh.preview.beforeSummary,
      afterSummary,
      beforeChecksum: fresh.preview.beforeChecksum,
      afterChecksum: await settingsFolderMirrorChecksum(afterValues?.[FOLDER_STATE_DATA_KEY] || {}),
      result: "ok",
      errors: [],
    });
    try { W.H2O?.LibraryWorkspace?._bustCaches?.("desktop-folder-mirror-refresh"); } catch {}
    try { state.folderCatalog = []; state.folderLocalReview = []; await fetchFolderCatalog(true); renderFolderSidebar(state.rowsCache || [], state.lastView, state.lastFolderId); } catch {}
    settingsFolderMirrorSetPreview(panel, null);
    const message = `Desktop folder mirror refreshed. Study is now ${afterSummary.studyBucketCount}. Desktop SQLite folders and folder_bindings were not changed.`;
    settingsFolderParitySetOperationStatus(panel, "mirrorRefresh", "works", "Refresh completed");
    settingsFolderMirrorSetStatus(panel, message);
    settingsFolderParityLog(panel, "Desktop folder mirror refreshed. Desktop SQLite folders, folder_bindings, native state, and Chrome storage were not modified.");
    await refreshSettingsFolderParity(panel);
    await refreshSettingsFolderDesktopReview(panel);
  } catch (err) {
    settingsFolderParitySetOperationStatus(panel, "mirrorRefresh", "failed", "Refresh failed after pending audit");
    try {
      await settingsFolderMirrorAppendAudit({
        timestamp: new Date().toISOString(),
        surface: "desktop-studio",
        action: "refresh-desktop-folder-state-mirror",
        targetKey: FOLDER_STATE_DATA_KEY,
        sourceKind: fresh.preview.sourceKind,
        beforeSummary: fresh.preview.beforeSummary,
        afterSummary: fresh.preview.afterSummary,
        beforeChecksum: fresh.preview.beforeChecksum,
        afterChecksum: fresh.preview.afterChecksum,
        result: "failed",
        errors: [String(err && (err.stack || err.message || err))],
      });
    } catch (_) { /* best-effort result audit after pending entry */ }
    settingsFolderMirrorSetStatus(panel, "Desktop mirror refresh failed after pending audit.");
    settingsFolderParityLog(panel, "Desktop mirror refresh failed after pending audit.\n" + String(err && (err.stack || err.message || err)));
  }
}

async function settingsFolderCleanupReadChromeMirror(){
  if (!settingsFolderCleanupIsChromeSurface()) {
    throw new Error("Chrome mirror cleanup is only available in Studio Launcher / MV3.");
  }
  const values = await settingsFolderCleanupChromeGetStrict([FOLDER_STATE_DATA_KEY]);
  const raw = values && values[FOLDER_STATE_DATA_KEY];
  const stateObj = settingsFolderCleanupClone(raw);
  if (!stateObj || typeof stateObj !== "object" || Array.isArray(stateObj)) {
    throw new Error("Chrome folder mirror is missing or malformed.");
  }
  if (!Array.isArray(stateObj.folders)) {
    throw new Error("Chrome folder mirror has no folders[] array.");
  }
  if (!stateObj.items || typeof stateObj.items !== "object" || Array.isArray(stateObj.items)) {
    stateObj.items = {};
  }
  return {
    state: stateObj,
    folders: stateObj.folders,
    items: stateObj.items,
    summary: settingsFolderCleanupFolderStateSummary(stateObj),
  };
}

function settingsFolderCleanupValidateDeletionSelection(selectedIds, reviewPlan, mirror){
  const ids = Array.from(new Set((Array.isArray(selectedIds) ? selectedIds : []).map((id) => String(id || "").trim()).filter(Boolean)));
  if (!settingsFolderCleanupIsChromeSurface()) {
    return { ok: false, error: "Chrome mirror cleanup is unavailable on this surface.", candidates: [], selectedFolderIds: ids };
  }
  if (!ids.length) return { ok: false, error: "Select at least one safe empty candidate.", candidates: [], selectedFolderIds: ids };
  const safeRows = Array.isArray(reviewPlan?.groups?.safeEmptyCandidates) ? reviewPlan.groups.safeEmptyCandidates : [];
  const safeById = new Map(safeRows.map((row) => [String(row.folderId || "").trim(), row]));
  const folders = Array.isArray(mirror?.folders) ? mirror.folders : [];
  const folderById = new Map(folders.map((folder) => [String(folder?.id || folder?.folderId || "").trim(), folder]));
  const items = mirror?.items && typeof mirror.items === "object" ? mirror.items : {};
  const candidates = [];
  for (const folderId of ids) {
    if (settingsFolderCleanupIsF5DReviewCandidate({ folderId })) {
      return { ok: false, error: `${folderId} is a Desktop/F5D review folder and is not eligible for Chrome mirror P7b deletion.`, candidates, selectedFolderIds: ids };
    }
    const candidate = safeById.get(folderId);
    if (!candidate) return { ok: false, error: `${folderId} is not in the current safe empty candidate group.`, candidates, selectedFolderIds: ids };
    if (settingsFolderCleanupIsF5DReviewCandidate(candidate)) {
      return { ok: false, error: `${folderId} is a Desktop/F5D review folder and is not eligible for Chrome mirror P7b deletion.`, candidates, selectedFolderIds: ids };
    }
    if (/^f_/.test(folderId)) return { ok: false, error: `${folderId} looks like a canonical native folder and cannot be deleted.`, candidates, selectedFolderIds: ids };
    if (folderId === "fld-case" || folderId === "fld-english") return { ok: false, error: `${folderId} is a same-name conflict and cannot be deleted in P7b.`, candidates, selectedFolderIds: ids };
    if (candidate.isCanonical) return { ok: false, error: `${folderId} is canonical and cannot be deleted.`, candidates, selectedFolderIds: ids };
    if (candidate.nativePresence) return { ok: false, error: `${folderId} is native-present and cannot be deleted.`, candidates, selectedFolderIds: ids };
    if (candidate.isConflict) return { ok: false, error: `${folderId} is a conflict and cannot be deleted in P7b.`, candidates, selectedFolderIds: ids };
    if (settingsFolderCleanupNumber(candidate.bindingCount) > 0
      || settingsFolderCleanupNumber(candidate.knownCount) > 0
      || settingsFolderCleanupNumber(candidate.localBindingCount) > 0) {
      return { ok: false, error: `${folderId} has bindings or known rows and cannot be deleted.`, candidates, selectedFolderIds: ids };
    }
    if (!folderById.has(folderId)) return { ok: false, error: `${folderId} is not present in the Chrome mirror folders[].`, candidates, selectedFolderIds: ids };
    const bucket = items[folderId];
    if (Array.isArray(bucket) && bucket.length > 0) {
      return { ok: false, error: `${folderId} has non-empty mirror items and cannot be deleted.`, candidates, selectedFolderIds: ids };
    }
    if (bucket != null && !Array.isArray(bucket)) {
      return { ok: false, error: `${folderId} has malformed mirror items and cannot be deleted safely.`, candidates, selectedFolderIds: ids };
    }
    candidates.push({
      folderId,
      name: candidate.name,
      normalizedName: candidate.normalizedName,
      badges: candidate.badges || [],
      nativePresence: !!candidate.nativePresence,
      bindingCount: settingsFolderCleanupNumber(candidate.bindingCount),
      knownCount: settingsFolderCleanupNumber(candidate.knownCount),
      localBindingCount: settingsFolderCleanupNumber(candidate.localBindingCount),
      riskLevel: candidate.riskLevel || "low-review-required",
      eligibilityReason: "Empty local extra/test folder in Chrome mirror; no native presence, conflict, bindings, known rows, or mirror items.",
    });
  }
  return { ok: true, candidates, selectedFolderIds: ids };
}

function settingsFolderCleanupBuildDeletionPreview(selectedIds, reviewPlan, mirror){
  const validation = settingsFolderCleanupValidateDeletionSelection(selectedIds, reviewPlan, mirror);
  if (!validation.ok) return { ok: false, error: validation.error, selectedFolderIds: validation.selectedFolderIds || [] };
  const beforeSummary = settingsFolderCleanupFolderStateSummary(mirror.state);
  return {
    ok: true,
    readOnly: false,
    noMutation: true,
    mutation: "preview-only",
    generatedAt: new Date().toISOString(),
    surface: "chrome-studio",
    action: "delete-empty-chrome-mirror-folders",
    key: FOLDER_STATE_DATA_KEY,
    selectedFolderIds: validation.selectedFolderIds,
    selectedFolders: validation.candidates,
    beforeFolderCount: beforeSummary.folderCount,
    predictedAfterFolderCount: beforeSummary.folderCount - validation.selectedFolderIds.length,
    beforeFolderStateSummary: beforeSummary,
    confirmationText: FOLDER_CLEANUP_CONFIRM_TEXT,
  };
}

async function settingsFolderCleanupAppendAudit(entry){
  const values = await settingsFolderCleanupChromeGetStrict([FOLDER_CLEANUP_AUDIT_KEY]);
  const existing = Array.isArray(values?.[FOLDER_CLEANUP_AUDIT_KEY]) ? values[FOLDER_CLEANUP_AUDIT_KEY] : [];
  const next = existing.concat([entry]).slice(-50);
  await settingsFolderCleanupChromeSetStrict({ [FOLDER_CLEANUP_AUDIT_KEY]: next });
  return next.length;
}

function settingsFolderCleanupBuildNextState(mirror, folderIds){
  const ids = new Set((Array.isArray(folderIds) ? folderIds : []).map((id) => String(id || "").trim()).filter(Boolean));
  const before = settingsFolderCleanupClone(mirror.state);
  const next = {
    ...before,
    folders: (Array.isArray(before.folders) ? before.folders : []).filter((folder) => {
      const id = String(folder?.id || folder?.folderId || "").trim();
      return !ids.has(id);
    }),
    items: { ...(before.items && typeof before.items === "object" && !Array.isArray(before.items) ? before.items : {}) },
  };
  for (const id of ids) {
    const bucket = next.items[id];
    if (bucket == null || (Array.isArray(bucket) && bucket.length === 0)) delete next.items[id];
  }
  return next;
}

function settingsFolderCleanupChip(label, value){
  return `<span style="display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);border-radius:999px;padding:4px 8px"><strong>${esc(label)}</strong><span>${esc(value)}</span></span>`;
}

function settingsFolderCleanupBadgesHtml(candidate){
  const badges = Array.isArray(candidate?.badges) ? candidate.badges : [];
  const withClass = [settingsFolderCleanupClassLabel(candidate?.classification), ...badges].filter(Boolean);
  if (!withClass.length) return "";
  return withClass.map((badge) => `<span style="display:inline-flex;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);border-radius:999px;padding:2px 6px;font-size:11px">${esc(badge)}</span>`).join(" ");
}

function settingsFolderCleanupClassLabel(classification){
  const c = String(classification || "").trim();
  if (c === "canonical-protected") return "preserve canonical";
  if (c === "same-name-conflict") return "same-name conflict / review only";
  if (c === "safe-empty") return "empty test cleanup candidate";
  if (c === "bound-review") return "bound review";
  if (c === "orphan-membership") return "orphan risk";
  if (c === "unsafe-to-delete") return "unsafe to delete";
  return c;
}

function settingsFolderCleanupCandidateSelectable(candidate){
  const id = String(candidate?.folderId || "").trim();
  if (!id || candidate?.isCanonical) return false;
  return [
    "same-name-conflict",
    "safe-empty",
    "bound-review",
    "unsafe-to-delete",
    "orphan-membership",
  ].includes(String(candidate?.classification || "").trim());
}

function settingsFolderCleanupCandidateHtml(candidate, selectedIds = new Set()){
  const warnings = Array.isArray(candidate?.warnings) ? candidate.warnings : [];
  const sourceKind = [candidate?.source, candidate?.kind].map((value) => String(value || "").trim()).filter(Boolean).join(" / ");
  const id = String(candidate?.folderId || "").trim();
  const selectable = settingsFolderCleanupCandidateSelectable(candidate);
  const checked = selectable && selectedIds.has(id) ? " checked" : "";
  return `
    <div style="border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.035);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          ${selectable ? `<label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;opacity:.86"><input type="checkbox" data-folder-cleanup-dry-run-select="1" data-folder-id="${esc(id)}"${checked} /> Select</label>` : ""}
          <strong>${esc(candidate?.name || "(unnamed)")}</strong>
        </div>
        <span>${settingsFolderCleanupBadgesHtml(candidate)}</span>
      </div>
      <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;opacity:.72">${esc(candidate?.folderId || "(no folder id)")}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:4px 12px;font-size:12px">
        <span>native ${esc(candidate?.nativeMembershipCount ?? candidate?.canonicalCount ?? 0)}</span>
        <span>known ${esc(candidate?.knownCount ?? 0)}</span>
        <span>local bindings ${esc(candidate?.localBindingCount ?? candidate?.bindingCount ?? 0)}</span>
        <span>orphan ${esc(candidate?.orphanCount ?? 0)}</span>
      </div>
      ${sourceKind ? `<div style="font-size:12px;opacity:.72"><strong>Source:</strong> ${esc(sourceKind)}</div>` : ""}
      ${candidate?.displayCountLabel ? `<div style="font-size:12px;opacity:.72"><strong>Count label:</strong> ${esc(candidate.displayCountLabel)}</div>` : ""}
      <div style="font-size:12px"><strong>Review:</strong> ${esc(candidate?.proposedAction || "Review only.")}</div>
      <div style="font-size:12px"><strong>Risk:</strong> ${esc(candidate?.riskLevel || "review")}</div>
      ${warnings.length ? `<div style="font-size:12px;opacity:.78"><strong>Why:</strong> ${esc(warnings.join(" "))}</div>` : ""}
    </div>
  `;
}

function settingsFolderCleanupGroupHtml(title, candidates, emptyText, selectedIds = new Set()){
  const rows = Array.isArray(candidates) ? candidates : [];
  return `
    <details open style="border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:8px;background:rgba(255,255,255,.025)">
      <summary style="cursor:pointer;font-weight:600">${esc(title)} <span style="opacity:.65">(${rows.length})</span></summary>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
        ${rows.length ? rows.map((candidate) => settingsFolderCleanupCandidateHtml(candidate, selectedIds)).join("") : `<div style="opacity:.65;font-size:12px">${esc(emptyText || "No candidates.")}</div>`}
      </div>
    </details>
  `;
}

function settingsFolderCleanupEnsureStableTitle(panel){
  const root = panel?.querySelector("#wbSettingsFolderCleanupReview");
  if (!root) return null;
  let title = root.querySelector("#wbSettingsFolderCleanupReviewTitle, [data-h2o-folder-cleanup-review-title='1']");
  if (!title) {
    title = document.createElement("h4");
    title.id = "wbSettingsFolderCleanupReviewTitle";
    title.style.margin = "0";
    title.style.fontSize = "14px";
    title.style.fontWeight = "600";
    root.insertBefore(title, root.firstChild);
  }
  title.setAttribute("data-h2o-folder-cleanup-review-title", "1");
  title.textContent = "Folder Cleanup Review";
  return title;
}

function settingsFolderCleanupRenderPlan(panel, plan){
  settingsFolderCleanupEnsureStableTitle(panel);
  const summary = panel?.querySelector("#wbSettingsFolderCleanupReviewSummary");
  const chips = panel?.querySelector("#wbSettingsFolderCleanupReviewChips");
  const groups = panel?.querySelector("#wbSettingsFolderCleanupReviewGroups");
  const conflictGroups = panel?.querySelector("#wbSettingsFolderCleanupReviewGroupsConflicts");
  const testGroups = panel?.querySelector("#wbSettingsFolderCleanupReviewGroupsTests");
  const preserveGroups = panel?.querySelector("#wbSettingsFolderCleanupReviewGroupsPreserve");
  const blockedGroups = panel?.querySelector("#wbSettingsFolderCleanupReviewGroupsBlocked");
  const copyBtn = panel?.querySelector("#wbSettingsFolderCleanupReviewCopy");
  const selectedIds = new Set(Array.isArray(panel?.__h2oFolderCleanupDryRunSelectedIds) ? panel.__h2oFolderCleanupDryRunSelectedIds : []);
  if (summary) {
    summary.textContent = `Review-only cleanup plan generated. Severity: ${plan?.selfCheckSeverity || "unknown"}. No cleanup performed.`;
  }
  if (chips) {
    chips.innerHTML = [
      settingsFolderCleanupChip("preserve canonical", plan?.counts?.canonicalProtected || 0),
      settingsFolderCleanupChip("conflicts", plan?.counts?.conflicts || 0),
      settingsFolderCleanupChip("empty test", plan?.counts?.safeEmpty || 0),
      settingsFolderCleanupChip("bound review", plan?.counts?.boundReview || 0),
      settingsFolderCleanupChip("orphan memberships", plan?.counts?.orphanMemberships || 0),
      settingsFolderCleanupChip("unsafe", plan?.counts?.unsafeToDelete || 0),
    ].join("");
  }
  if (groups) {
    groups.innerHTML = [
      settingsFolderCleanupGroupHtml("Preserve canonical", plan?.groups?.canonicalProtected, "No canonical rows available.", selectedIds),
      settingsFolderCleanupGroupHtml("Same-name conflict / review only", plan?.groups?.sameNameConflicts, "No same-name conflicts detected.", selectedIds),
      settingsFolderCleanupGroupHtml("Empty test cleanup candidates", plan?.groups?.safeEmptyCandidates, "No empty extra/test candidates are currently safe for a future reviewed cleanup.", selectedIds),
      settingsFolderCleanupGroupHtml("Bound review", plan?.groups?.boundReviewCandidates, "No bound extra/test candidates detected.", selectedIds),
      settingsFolderCleanupGroupHtml("Orphan risk", plan?.groups?.orphanMemberships, "No orphan native memberships detected.", selectedIds),
      settingsFolderCleanupGroupHtml("Unsafe to delete", plan?.groups?.unsafeToDelete, "No additional unsafe review rows detected.", selectedIds),
    ].join("");
  }
  if (conflictGroups) {
    conflictGroups.innerHTML = settingsFolderCleanupGroupHtml(
      "Same-name conflict / review only",
      plan?.groups?.sameNameConflicts,
      "No same-name conflicts detected.",
      selectedIds
    );
  }
  if (testGroups) {
    testGroups.innerHTML = settingsFolderCleanupGroupHtml(
      "Empty test cleanup candidates",
      plan?.groups?.safeEmptyCandidates,
      "No empty extra/test candidates are currently safe for a future reviewed cleanup.",
      selectedIds
    );
  }
  if (preserveGroups) {
    preserveGroups.innerHTML = settingsFolderCleanupGroupHtml(
      "Preserve canonical",
      plan?.groups?.canonicalProtected,
      "No canonical rows available.",
      selectedIds
    );
  }
  if (blockedGroups) {
    blockedGroups.innerHTML = [
      settingsFolderCleanupGroupHtml("Bound review", plan?.groups?.boundReviewCandidates, "No bound extra/test candidates detected.", selectedIds),
      settingsFolderCleanupGroupHtml("Orphan risk", plan?.groups?.orphanMemberships, "No orphan native memberships detected.", selectedIds),
      settingsFolderCleanupGroupHtml("Unsafe to delete", plan?.groups?.unsafeToDelete, "No additional unsafe review rows detected.", selectedIds),
    ].join("");
  }
  if (copyBtn) copyBtn.disabled = false;
  const counts = plan?.counts || {};
  const reviewCount = settingsFolderCleanupNumber(counts.safeEmpty)
    + settingsFolderCleanupNumber(counts.conflicts)
    + settingsFolderCleanupNumber(counts.boundReview)
    + settingsFolderCleanupNumber(counts.orphanMemberships)
    + settingsFolderCleanupNumber(counts.unsafeToDelete);
  settingsFolderParitySetOperationStatus(panel, "cleanupReview", reviewCount ? "warning" : "works", reviewCount ? `${reviewCount} review item(s)` : "No unsafe candidates");
  settingsFolderParityRenderOperationRows(panel);
}

function settingsFolderCleanupDryRunCandidateList(plan){
  const groups = plan?.groups || {};
  return [
    ...(Array.isArray(groups.sameNameConflicts) ? groups.sameNameConflicts : []),
    ...(Array.isArray(groups.safeEmptyCandidates) ? groups.safeEmptyCandidates : []),
    ...(Array.isArray(groups.boundReviewCandidates) ? groups.boundReviewCandidates : []),
    ...(Array.isArray(groups.unsafeToDelete) ? groups.unsafeToDelete : []),
    ...(Array.isArray(groups.orphanMemberships) ? groups.orphanMemberships.filter((candidate) => !candidate?.isCanonical) : []),
  ].filter((candidate) => settingsFolderCleanupCandidateSelectable(candidate));
}

function settingsFolderCleanupDryRunSelectedIds(panel){
  const ids = [...(panel?.querySelectorAll("[data-folder-cleanup-dry-run-select='1']:checked") || [])]
    .map((input) => String(input.getAttribute("data-folder-id") || "").trim())
    .filter(Boolean);
  const unique = Array.from(new Set(ids));
  if (panel) panel.__h2oFolderCleanupDryRunSelectedIds = unique;
  return unique;
}

function settingsFolderCleanupClearApplyPreview(panel){
  if (!panel) return;
  panel.__h2oFolderCleanupApplyPreview = null;
  FOLDER_PARITY_SETTINGS_UI_STATE.cleanupApplyPreview = null;
  const summary = panel.querySelector("#wbSettingsFolderCleanupApplyPreviewSummary");
  const rows = panel.querySelector("#wbSettingsFolderCleanupApplyPreviewRows");
  const blockers = panel.querySelector("#wbSettingsFolderCleanupApplyPreviewBlockers");
  const confirmation = panel.querySelector("#wbSettingsFolderCleanupApplyPreviewConfirmation");
  const json = panel.querySelector("#wbSettingsFolderCleanupApplyPreviewJson");
  const copy = panel.querySelector("#wbSettingsFolderCleanupApplyPreviewCopy");
  const box = panel.querySelector("#wbSettingsFolderCleanupApplyPreviewBox");
  if (summary) summary.textContent = "Preview only: no cleanup is applied.";
  if (rows) {
    rows.innerHTML = "";
    rows.removeAttribute("data-folder-cleanup-apply-preview-rendered");
  }
  if (blockers) blockers.innerHTML = "";
  if (confirmation) confirmation.innerHTML = "";
  if (json) {
    json.hidden = true;
    json.textContent = "";
    json.removeAttribute("data-folder-cleanup-apply-preview-rendered");
  }
  if (copy) copy.disabled = true;
  if (box) box.removeAttribute("data-folder-cleanup-apply-preview-rendered");
}

function settingsFolderCleanupDryRunDecision(candidate, staleDiagnostics){
  const classification = String(candidate?.classification || "").trim();
  const folderId = String(candidate?.folderId || "").trim();
  const nativeMembershipCount = candidate?.nativeMembershipCount == null
    ? null
    : settingsFolderCleanupNumber(candidate.nativeMembershipCount);
  const knownCount = candidate?.knownCount == null ? null : settingsFolderCleanupNumber(candidate.knownCount);
  const localBindingCount = candidate?.localBindingCount == null
    ? null
    : settingsFolderCleanupNumber(candidate.localBindingCount);
  const orphanCount = settingsFolderCleanupNumber(candidate?.orphanCount);
  const badges = Array.isArray(candidate?.badges) ? candidate.badges.slice() : [];
  const reasonCodes = [];

  if (!folderId) reasonCodes.push("missing-folder-id");
  if (staleDiagnostics) reasonCodes.push("stale-diagnostics");
  if (candidate?.isCanonical || classification === "canonical-protected") reasonCodes.push("preserve-canonical");
  if (classification === "same-name-conflict") reasonCodes.push("same-name-conflict-review-only");
  if (classification === "safe-empty") reasonCodes.push("empty-test-candidate");
  if (settingsFolderCleanupNumber(localBindingCount) > 0) reasonCodes.push("binding-count-nonzero");
  if (settingsFolderCleanupNumber(knownCount) > 0) reasonCodes.push("known-count-nonzero");
  if (orphanCount > 0 || classification === "orphan-membership") reasonCodes.push("orphan-risk-review-required");
  if (!["safe-empty", "same-name-conflict", "bound-review", "unsafe-to-delete", "orphan-membership"].includes(classification)) {
    reasonCodes.push("source-class-unsafe");
  }

  const allowed = !!folderId
    && !staleDiagnostics
    && !candidate?.isCanonical
    && classification === "safe-empty"
    && settingsFolderCleanupNumber(nativeMembershipCount) === 0
    && settingsFolderCleanupNumber(knownCount) === 0
    && settingsFolderCleanupNumber(localBindingCount) === 0
    && orphanCount === 0;

  if (!allowed && classification === "unsafe-to-delete") reasonCodes.push("source-class-unsafe");
  reasonCodes.push("dry-run-only", "no-mutation-phase");

  return {
    folderId,
    name: String(candidate?.name || folderId || "Folder review item"),
    source: String(candidate?.source || ""),
    className: settingsFolderCleanupClassLabel(classification),
    risk: String(candidate?.riskLevel || "review"),
    decision: allowed ? "allowed" : "blocked",
    reasonCodes: Array.from(new Set(reasonCodes.filter(Boolean))),
    facts: {
      nativeMembershipCount,
      knownCount,
      localBindingCount,
      badges,
      displayCountLabel: String(candidate?.displayCountLabel || ""),
    },
  };
}

function settingsFolderCleanupBuildDryRunPlan(reviewPlan, selectedFolderIds){
  const selectedIds = Array.isArray(selectedFolderIds) ? selectedFolderIds.map((id) => String(id || "").trim()).filter(Boolean) : [];
  const generatedAt = new Date().toISOString();
  const planGeneratedAt = Date.parse(String(reviewPlan?.generatedAt || ""));
  const diagnosticsFreshnessMs = Number.isFinite(planGeneratedAt) ? Math.max(0, Date.now() - planGeneratedAt) : null;
  const staleDiagnostics = diagnosticsFreshnessMs == null || diagnosticsFreshnessMs > FOLDER_CLEANUP_DRY_RUN_FRESHNESS_MS;
  const byId = new Map(settingsFolderCleanupDryRunCandidateList(reviewPlan).map((candidate) => [String(candidate.folderId || "").trim(), candidate]));
  const candidates = selectedIds.map((id) => {
    const candidate = byId.get(id);
    if (!candidate) {
      return {
        folderId: id,
        name: id,
        source: "",
        className: "unsafe to delete",
        risk: "high-review-required",
        decision: "blocked",
        reasonCodes: Array.from(new Set(["stale-diagnostics", "dry-run-only", "no-mutation-phase"])),
        facts: {
          nativeMembershipCount: null,
          knownCount: null,
          localBindingCount: null,
          badges: [],
          displayCountLabel: "",
        },
      };
    }
    return settingsFolderCleanupDryRunDecision(candidate, staleDiagnostics);
  });
  const allowedCount = candidates.filter((candidate) => candidate.decision === "allowed").length;
  const blockedCount = candidates.length - allowedCount;
  const reasonCodes = Array.from(new Set((candidates.length
    ? candidates.flatMap((candidate) => Array.isArray(candidate.reasonCodes) ? candidate.reasonCodes : [])
    : ["no-selection", "dry-run-only", "no-mutation-phase"]).filter(Boolean)));
  return {
    schema: "h2o.folder-cleanup-dry-run.v1",
    surface: String(reviewPlan?.surface || ""),
    generatedAt,
    noMutation: true,
    diagnosticsFreshnessMs,
    selectedCount: selectedIds.length,
    allowedCount,
    blockedCount,
    reasonCodes,
    reasonCodeExamples: [
      "empty-test-candidate",
      "same-name-conflict-review-only",
      "dry-run-only",
      "no-mutation-phase",
    ],
    candidates,
  };
}

function settingsFolderCleanupRenderDryRunPlan(panel, dryRunPlan){
  const box = panel?.querySelector("#wbSettingsFolderCleanupDryRunBox");
  const summary = panel?.querySelector("#wbSettingsFolderCleanupDryRunSummary");
  const rowsEl = panel?.querySelector("#wbSettingsFolderCleanupDryRunRows");
  const selectedRowsEl = panel?.querySelector("#wbSettingsFolderCleanupDryRunSelectedRows");
  const reasonCodesEl = panel?.querySelector("#wbSettingsFolderCleanupDryRunReasonCodes");
  const jsonEl = panel?.querySelector("#wbSettingsFolderCleanupDryRunJson");
  const copyBtn = panel?.querySelector("#wbSettingsFolderCleanupDryRunCopy");
  const rows = Array.isArray(dryRunPlan?.candidates) ? dryRunPlan.candidates : [];
  if (box) box.setAttribute("data-folder-cleanup-dry-run-rendered", "1");
  if (summary) {
    summary.textContent = `schema: ${dryRunPlan?.schema || "h2o.folder-cleanup-dry-run.v1"} · selectedCount: ${dryRunPlan?.selectedCount || 0} · allowedCount: ${dryRunPlan?.allowedCount || 0} · blockedCount: ${dryRunPlan?.blockedCount || 0} · reasonCodes: ${(dryRunPlan?.reasonCodes || []).join(", ") || "dry-run-only, no-mutation-phase"} · No cleanup is performed.`;
  }
  if (rowsEl) {
    const metaHtml = `
      <div style="display:grid;grid-template-columns:max-content 1fr;gap:5px 12px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.035);border-radius:8px;padding:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace">
        <strong>Dry-run result</strong><span data-folder-cleanup-dry-run-rendered="1">rendered</span>
        <strong>schema</strong><span>${esc(dryRunPlan?.schema || "h2o.folder-cleanup-dry-run.v1")}</span>
        <strong>selectedCount</strong><span>${esc(dryRunPlan?.selectedCount ?? 0)}</span>
        <strong>allowedCount</strong><span>${esc(dryRunPlan?.allowedCount ?? 0)}</span>
        <strong>blockedCount</strong><span>${esc(dryRunPlan?.blockedCount ?? 0)}</span>
        <strong>reasonCodes</strong><span>${esc((dryRunPlan?.reasonCodes || []).join(", ") || "dry-run-only, no-mutation-phase")}</span>
        <strong>examples</strong><span>${esc((dryRunPlan?.reasonCodeExamples || []).join(", "))}</span>
      </div>
    `;
    const rowHtml = rows.length ? rows.map((candidate) => `
      <div style="display:grid;grid-template-columns:minmax(140px,1fr) max-content minmax(180px,2fr);gap:8px;align-items:start;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.025);border-radius:8px;padding:8px">
        <div>
          <div style="font-weight:600">${esc(candidate.name || candidate.folderId || "(unnamed)")}</div>
          <div style="opacity:.68;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace">${esc(candidate.folderId || "(missing folder id)")}</div>
        </div>
        <span style="border:1px solid ${candidate.decision === "allowed" ? "rgba(34,197,94,.45)" : "rgba(234,179,8,.45)"};background:${candidate.decision === "allowed" ? "rgba(34,197,94,.13)" : "rgba(234,179,8,.12)"};border-radius:999px;padding:2px 8px;font-size:11px">${esc(candidate.decision)}</span>
        <div style="font-size:12px;opacity:.78">${esc((candidate.reasonCodes || []).join(", "))}</div>
      </div>
    `).join("") : `<div style="border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.025);border-radius:8px;padding:8px;opacity:.78">No rows selected. reasonCodes: no-selection, dry-run-only, no-mutation-phase.</div>`;
    rowsEl.innerHTML = metaHtml + rowHtml;
    rowsEl.setAttribute("data-folder-cleanup-dry-run-rendered", "1");
  }
  if (selectedRowsEl) {
    selectedRowsEl.innerHTML = rows.length ? rows.map((candidate) => `
      <div style="display:grid;grid-template-columns:minmax(140px,1fr) max-content;gap:8px;align-items:start;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.025);border-radius:8px;padding:8px">
        <div>
          <div style="font-weight:600">${esc(candidate.name || candidate.folderId || "(unnamed)")}</div>
          <div style="opacity:.68;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace">${esc(candidate.folderId || "(missing folder id)")}</div>
        </div>
        <span style="border:1px solid ${candidate.decision === "allowed" ? "rgba(34,197,94,.45)" : "rgba(234,179,8,.45)"};background:${candidate.decision === "allowed" ? "rgba(34,197,94,.13)" : "rgba(234,179,8,.12)"};border-radius:999px;padding:2px 8px;font-size:11px">${esc(candidate.decision)}</span>
      </div>
    `).join("") : `<div style="border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.025);border-radius:8px;padding:8px;opacity:.78">No rows selected. selectedCount: 0.</div>`;
  }
  if (reasonCodesEl) {
    const codes = Array.isArray(dryRunPlan?.reasonCodes) && dryRunPlan.reasonCodes.length
      ? dryRunPlan.reasonCodes
      : ["no-selection", "dry-run-only", "no-mutation-phase"];
    reasonCodesEl.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${codes.map((code) => `<span style="border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.035);border-radius:999px;padding:3px 8px;font-size:11px">${esc(code)}</span>`).join("")}
      </div>
    `;
  }
  if (jsonEl) {
    jsonEl.hidden = false;
    jsonEl.textContent = JSON.stringify(dryRunPlan || {}, null, 2);
    jsonEl.setAttribute("data-folder-cleanup-dry-run-rendered", "1");
  }
  if (copyBtn) copyBtn.disabled = !dryRunPlan;
}

async function generateSettingsFolderCleanupDryRunPlan(panel){
  if (!panel) return null;
  let reviewPlan = panel.__h2oFolderCleanupReviewPlan;
  if (!reviewPlan) reviewPlan = await refreshSettingsFolderCleanupReview(panel);
  const selectedIds = settingsFolderCleanupDryRunSelectedIds(panel);
  const dryRunPlan = settingsFolderCleanupBuildDryRunPlan(reviewPlan, selectedIds);
  panel.__h2oFolderCleanupDryRunPlan = dryRunPlan;
  FOLDER_PARITY_SETTINGS_UI_STATE.cleanupDryRunPlan = dryRunPlan;
  settingsFolderCleanupClearApplyPreview(panel);
  settingsFolderCleanupSetActiveSubtab(panel, "dry-run");
  settingsFolderCleanupRenderDryRunPlan(panel, dryRunPlan);
  settingsFolderSectionSetActive(panel, "cleanup-dry-run", "result");
  settingsFolderParityLog(panel, "Dry-run folder cleanup plan generated. No cleanup performed.");
  return dryRunPlan;
}

async function copySettingsFolderCleanupDryRunPlan(panel){
  if (!panel) return;
  let plan = panel.__h2oFolderCleanupDryRunPlan;
  if (!plan) plan = await generateSettingsFolderCleanupDryRunPlan(panel);
  const text = JSON.stringify(plan || {}, null, 2);
  try {
    if (W.navigator?.clipboard?.writeText) {
      await W.navigator.clipboard.writeText(text);
      settingsFolderParityLog(panel, "Dry-run folder cleanup plan JSON copied to clipboard.");
      return;
    }
  } catch (err) {
    settingsFolderParityLog(panel, "Clipboard copy failed; dry-run plan printed to console.\n" + String(err && (err.message || err)));
  }
  try { console.log("H2O_FOLDER_CLEANUP_DRY_RUN_PLAN", plan); } catch {}
  settingsFolderParityLog(panel, "Clipboard unavailable; dry-run folder cleanup plan printed to console as H2O_FOLDER_CLEANUP_DRY_RUN_PLAN.");
}

function settingsFolderCleanupApplyPreviewRows(dryRunPlan, staleDiagnostics, missingHash){
  const candidates = Array.isArray(dryRunPlan?.candidates) ? dryRunPlan.candidates : [];
  return candidates.map((candidate) => {
    const baseCodes = Array.isArray(candidate?.reasonCodes) ? candidate.reasonCodes : [];
    const reasonCodes = new Set(baseCodes);
    reasonCodes.add("preview-only");
    reasonCodes.add("no-mutation-phase");
    reasonCodes.add("confirmation-required");
    if (!candidate?.folderId) reasonCodes.add("exact-id-required");
    if (staleDiagnostics) reasonCodes.add("stale-diagnostics");
    if (missingHash) reasonCodes.add("missing-dry-run-hash");
    if (/preserve canonical/i.test(String(candidate?.className || ""))) reasonCodes.add("preserve-canonical");
    if (/same-name conflict/i.test(String(candidate?.className || ""))) reasonCodes.add("same-name-conflict-review-only");
    const facts = candidate?.facts && typeof candidate.facts === "object" ? candidate.facts : {};
    if (settingsFolderCleanupNumber(facts.localBindingCount) > 0) reasonCodes.add("binding-count-nonzero");
    if (settingsFolderCleanupNumber(facts.knownCount) > 0) reasonCodes.add("known-count-nonzero");
    if (baseCodes.includes("orphan-risk-review-required")) reasonCodes.add("orphan-risk-review-required");
    const previewAllowed = candidate?.decision === "allowed" && !staleDiagnostics && !missingHash && !!candidate?.folderId;
    return {
      folderId: String(candidate?.folderId || ""),
      name: String(candidate?.name || candidate?.folderId || "Folder review item"),
      decision: previewAllowed ? "preview-allowed" : "preview-blocked",
      reasonCodes: Array.from(reasonCodes).filter(Boolean),
      facts: {
        source: String(candidate?.source || ""),
        className: String(candidate?.className || ""),
        risk: String(candidate?.risk || ""),
        nativeMembershipCount: facts.nativeMembershipCount ?? null,
        knownCount: facts.knownCount ?? null,
        localBindingCount: facts.localBindingCount ?? null,
        badges: Array.isArray(facts.badges) ? facts.badges : [],
      },
    };
  });
}

function settingsFolderCleanupApplyPreviewNoDryRun(surface = ""){
  return {
    schema: "h2o.folder-cleanup-apply-preview.v1",
    surface: String(surface || ""),
    generatedAt: new Date().toISOString(),
    noMutation: true,
    applyAllowed: false,
    dryRunRequired: true,
    dryRunPlanHash: "",
    selectedCount: 0,
    allowedPreviewCount: 0,
    blockedPreviewCount: 0,
    confirmationRequired: true,
    requiredConfirmationText: FOLDER_CLEANUP_APPLY_PREVIEW_CONFIRM_TEXT,
    blockers: ["dry-run-required", "missing-dry-run-hash", "preview-only", "no-mutation-phase"],
    reasonCodes: ["dry-run-required", "missing-dry-run-hash", "preview-only", "no-mutation-phase", "confirmation-required"],
    rows: [],
  };
}

function settingsFolderCleanupDryRunPlanHash(dryRunPlan){
  const text = settingsFolderMirrorStableStringify(dryRunPlan || {});
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function settingsFolderCleanupBuildApplyPreview(dryRunPlan){
  if (!dryRunPlan) return settingsFolderCleanupApplyPreviewNoDryRun("");
  const diagnosticsFreshnessMs = dryRunPlan?.diagnosticsFreshnessMs == null
    ? null
    : settingsFolderCleanupNumber(dryRunPlan.diagnosticsFreshnessMs);
  const staleDiagnostics = diagnosticsFreshnessMs == null || diagnosticsFreshnessMs > FOLDER_CLEANUP_DRY_RUN_FRESHNESS_MS;
  const dryRunPlanHash = settingsFolderCleanupDryRunPlanHash(dryRunPlan);
  const missingHash = !dryRunPlanHash;
  const rows = settingsFolderCleanupApplyPreviewRows(dryRunPlan, staleDiagnostics, missingHash);
  const allowedPreviewCount = rows.filter((row) => row.decision === "preview-allowed").length;
  const blockedPreviewCount = rows.length - allowedPreviewCount;
  const reasonCodes = Array.from(new Set([
    ...rows.flatMap((row) => Array.isArray(row.reasonCodes) ? row.reasonCodes : []),
    "preview-only",
    "no-mutation-phase",
    "confirmation-required",
    ...(staleDiagnostics ? ["stale-diagnostics"] : []),
    ...(missingHash ? ["missing-dry-run-hash"] : []),
  ].filter(Boolean)));
  const blockers = Array.from(new Set([
    "preview-only",
    "no-mutation-phase",
    ...(staleDiagnostics ? ["stale-diagnostics"] : []),
    ...(missingHash ? ["missing-dry-run-hash"] : []),
  ]));
  return {
    schema: "h2o.folder-cleanup-apply-preview.v1",
    surface: String(dryRunPlan?.surface || ""),
    generatedAt: new Date().toISOString(),
    noMutation: true,
    applyAllowed: false,
    dryRunRequired: false,
    dryRunPlanHash,
    selectedCount: settingsFolderCleanupNumber(dryRunPlan?.selectedCount),
    allowedPreviewCount,
    blockedPreviewCount,
    confirmationRequired: true,
    requiredConfirmationText: FOLDER_CLEANUP_APPLY_PREVIEW_CONFIRM_TEXT,
    blockers,
    reasonCodes,
    rows,
  };
}

function settingsFolderCleanupRenderApplyPreview(panel, preview){
  const box = panel?.querySelector("#wbSettingsFolderCleanupApplyPreviewBox");
  const summary = panel?.querySelector("#wbSettingsFolderCleanupApplyPreviewSummary");
  const rowsEl = panel?.querySelector("#wbSettingsFolderCleanupApplyPreviewRows");
  const blockersEl = panel?.querySelector("#wbSettingsFolderCleanupApplyPreviewBlockers");
  const confirmationEl = panel?.querySelector("#wbSettingsFolderCleanupApplyPreviewConfirmation");
  const jsonEl = panel?.querySelector("#wbSettingsFolderCleanupApplyPreviewJson");
  const copyBtn = panel?.querySelector("#wbSettingsFolderCleanupApplyPreviewCopy");
  const rows = Array.isArray(preview?.rows) ? preview.rows : [];
  if (box) box.setAttribute("data-folder-cleanup-apply-preview-rendered", "1");
  if (summary) {
    summary.textContent = `schema: ${preview?.schema || "h2o.folder-cleanup-apply-preview.v1"} · noMutation: true · applyAllowed: false · selectedCount: ${preview?.selectedCount || 0} · allowedPreviewCount: ${preview?.allowedPreviewCount || 0} · blockedPreviewCount: ${preview?.blockedPreviewCount || 0} · requiredConfirmationText: ${preview?.requiredConfirmationText || FOLDER_CLEANUP_APPLY_PREVIEW_CONFIRM_TEXT} · reasonCodes: ${(preview?.reasonCodes || []).join(", ") || "preview-only, no-mutation-phase"} · blockers: ${(preview?.blockers || []).join(", ") || "preview-only, no-mutation-phase"}`;
  }
  if (rowsEl) {
    const metaHtml = `
      <div style="display:grid;grid-template-columns:max-content 1fr;gap:5px 12px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.035);border-radius:8px;padding:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace">
        <strong>Apply preview result</strong><span data-folder-cleanup-apply-preview-rendered="1">rendered</span>
        <strong>schema:</strong><span>${esc(preview?.schema || "h2o.folder-cleanup-apply-preview.v1")}</span>
        <strong>noMutation:</strong><span>true</span>
        <strong>applyAllowed:</strong><span>false</span>
        <strong>selectedCount:</strong><span>${esc(preview?.selectedCount ?? 0)}</span>
        <strong>allowedPreviewCount:</strong><span>${esc(preview?.allowedPreviewCount ?? 0)}</span>
        <strong>blockedPreviewCount:</strong><span>${esc(preview?.blockedPreviewCount ?? 0)}</span>
        <strong>requiredConfirmationText:</strong><span>${esc(preview?.requiredConfirmationText || FOLDER_CLEANUP_APPLY_PREVIEW_CONFIRM_TEXT)}</span>
        <strong>reasonCodes:</strong><span>${esc((preview?.reasonCodes || []).join(", ") || "preview-only, no-mutation-phase")}</span>
        <strong>blockers:</strong><span>${esc((preview?.blockers || []).join(", ") || "none")}</span>
      </div>
    `;
    const rowHtml = rows.length ? rows.map((row) => `
      <div style="display:grid;grid-template-columns:minmax(140px,1fr) max-content minmax(180px,2fr);gap:8px;align-items:start;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.025);border-radius:8px;padding:8px">
        <div>
          <div style="font-weight:600">${esc(row.name || row.folderId || "(unnamed)")}</div>
          <div style="opacity:.68;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace">${esc(row.folderId || "(missing folder id)")}</div>
        </div>
        <span style="border:1px solid ${row.decision === "preview-allowed" ? "rgba(34,197,94,.45)" : "rgba(234,179,8,.45)"};background:${row.decision === "preview-allowed" ? "rgba(34,197,94,.13)" : "rgba(234,179,8,.12)"};border-radius:999px;padding:2px 8px;font-size:11px">${esc(row.decision)}</span>
        <div style="font-size:12px;opacity:.78">${esc((row.reasonCodes || []).join(", "))}</div>
      </div>
    `).join("") : `<div style="border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.025);border-radius:8px;padding:8px;opacity:.78">No dry-run rows available. blockers: ${(preview?.blockers || []).join(", ") || "dry-run-required"}.</div>`;
    rowsEl.innerHTML = metaHtml + rowHtml;
    rowsEl.setAttribute("data-folder-cleanup-apply-preview-rendered", "1");
  }
  if (blockersEl) {
    const blockers = Array.isArray(preview?.blockers) && preview.blockers.length
      ? preview.blockers
      : ["preview-only", "no-mutation-phase"];
    const reasonCodes = Array.isArray(preview?.reasonCodes) && preview.reasonCodes.length
      ? preview.reasonCodes
      : ["preview-only", "no-mutation-phase"];
    blockersEl.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:8px">
        <div><strong>blockers:</strong> ${esc(blockers.join(", "))}</div>
        <div><strong>reasonCodes:</strong> ${esc(reasonCodes.join(", "))}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${reasonCodes.map((code) => `<span style="border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.035);border-radius:999px;padding:3px 8px;font-size:11px">${esc(code)}</span>`).join("")}
        </div>
      </div>
    `;
  }
  if (confirmationEl) {
    confirmationEl.innerHTML = `
      <div style="display:grid;grid-template-columns:max-content 1fr;gap:5px 12px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.035);border-radius:8px;padding:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace">
        <strong>requiredConfirmationText:</strong><span>${esc(preview?.requiredConfirmationText || FOLDER_CLEANUP_APPLY_PREVIEW_CONFIRM_TEXT)}</span>
        <strong>confirmationRequired:</strong><span>${esc(preview?.confirmationRequired !== false)}</span>
        <strong>applyAllowed:</strong><span>false</span>
        <strong>noMutation:</strong><span>true</span>
      </div>
    `;
  }
  if (jsonEl) {
    jsonEl.hidden = false;
    jsonEl.textContent = JSON.stringify(preview || {}, null, 2);
    jsonEl.setAttribute("data-folder-cleanup-apply-preview-rendered", "1");
  }
  if (copyBtn) copyBtn.disabled = !preview;
}

function settingsFolderCleanupEnsurePreviewGateVisible(panel, preview){
  const currentPanel = document.getElementById("viewSettingsPanel") || panel;
  if (!currentPanel) return;
  currentPanel.hidden = false;
  if (preview) {
    currentPanel.__h2oFolderCleanupApplyPreview = preview;
    FOLDER_PARITY_SETTINGS_UI_STATE.cleanupApplyPreview = preview;
  }
  settingsFolderParitySetActiveTab(currentPanel, "cleanup-review");
  settingsFolderCleanupSetActiveSubtab(currentPanel, "apply-preview");
  if (preview) settingsFolderCleanupRenderApplyPreview(currentPanel, preview);
  settingsFolderSectionSetActive(currentPanel, "cleanup-apply-preview", "result");
  settingsFolderParityUpdateActiveViewMarker(currentPanel);
  const target = currentPanel.querySelector("#wbSettingsFolderCleanupApplyPreviewRows")
    || currentPanel.querySelector("[data-folder-section-scope='cleanup-apply-preview'][data-folder-section-panel='result']")
    || currentPanel.querySelector("#wbSettingsFolderCleanupApplyPreviewBox")
    || currentPanel.querySelector("#wbSettingsFolderParityBox")
    || currentPanel;
  settingsFolderParityScrollTo(currentPanel, target);
  try { target.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch {}
}

async function generateSettingsFolderCleanupApplyPreview(panel){
  if (!panel) return null;
  const dryRunPlan = panel.__h2oFolderCleanupDryRunPlan || FOLDER_PARITY_SETTINGS_UI_STATE.cleanupDryRunPlan || null;
  const preview = dryRunPlan
    ? settingsFolderCleanupBuildApplyPreview(dryRunPlan)
    : settingsFolderCleanupApplyPreviewNoDryRun(panel.__h2oFolderCleanupReviewPlan?.surface || "");
  panel.__h2oFolderCleanupApplyPreview = preview;
  FOLDER_PARITY_SETTINGS_UI_STATE.cleanupApplyPreview = preview;
  FOLDER_PARITY_SETTINGS_UI_STATE.activeTab = "cleanup-review";
  FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab = "apply-preview";
  settingsFolderCleanupEnsurePreviewGateVisible(panel, preview);
  settingsFolderParityLog(panel, "Preview-only cleanup apply gate generated. No cleanup performed.");
  return preview;
}

async function copySettingsFolderCleanupApplyPreview(panel){
  if (!panel) return;
  let preview = panel.__h2oFolderCleanupApplyPreview;
  if (!preview) preview = await generateSettingsFolderCleanupApplyPreview(panel);
  const text = JSON.stringify(preview || {}, null, 2);
  try {
    if (W.navigator?.clipboard?.writeText) {
      await W.navigator.clipboard.writeText(text);
      settingsFolderParityLog(panel, "Preview-only cleanup apply JSON copied to clipboard.");
      return;
    }
  } catch (err) {
    settingsFolderParityLog(panel, "Clipboard copy failed; preview-only apply JSON printed to console.\n" + String(err && (err.message || err)));
  }
  try { console.log("H2O_FOLDER_CLEANUP_APPLY_PREVIEW", preview); } catch {}
  settingsFolderParityLog(panel, "Clipboard unavailable; preview-only cleanup apply JSON printed to console as H2O_FOLDER_CLEANUP_APPLY_PREVIEW.");
}

function settingsFolderCleanupRenderDeletePanel(panel, plan){
  const summary = panel?.querySelector("#wbSettingsFolderCleanupDeleteSummary");
  const list = panel?.querySelector("#wbSettingsFolderCleanupDeleteList");
  const previewEl = panel?.querySelector("#wbSettingsFolderCleanupDeletePreview");
  const copyBtn = panel?.querySelector("#wbSettingsFolderCleanupCopyDeletePlan");
  const candidates = Array.isArray(plan?.groups?.safeEmptyCandidates) ? plan.groups.safeEmptyCandidates : [];
  const chromeSurface = settingsFolderCleanupIsChromeSurface();
  const previousSelected = new Set(Array.isArray(panel?.__h2oFolderCleanupDeleteSelectedIds) ? panel.__h2oFolderCleanupDeleteSelectedIds : []);

  panel.__h2oFolderCleanupDeletionPreview = null;
  if (previewEl) {
    previewEl.hidden = true;
    previewEl.textContent = "";
  }
  if (copyBtn) copyBtn.disabled = true;
  if (summary) {
    summary.textContent = chromeSurface
      ? "Chrome mirror only. Native folders and Desktop SQLite are not modified. F5D/Desktop test folders are review-only in this phase."
      : "Chrome mirror cleanup is only available in Studio Launcher. Desktop cleanup is separate and not performed.";
  }
  if (list) {
    if (!chromeSurface) {
      list.innerHTML = `<div style="opacity:.72;font-size:12px">Unavailable on this surface. No SQLite writes are performed.</div>`;
    } else if (!candidates.length) {
      list.innerHTML = `<div style="opacity:.72;font-size:12px">No currently eligible safe empty Chrome mirror candidates.</div>`;
    } else {
      list.innerHTML = candidates.map((candidate) => {
        const id = String(candidate.folderId || "").trim();
        const checked = previousSelected.has(id) ? " checked" : "";
        return `
          <label style="display:grid;grid-template-columns:max-content 1fr;gap:8px;align-items:start;border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:8px;background:rgba(255,255,255,.025)">
            <input type="checkbox" data-folder-id="${esc(id)}"${checked} />
            <span style="display:flex;flex-direction:column;gap:3px">
              <strong>${esc(candidate.name || id)}</strong>
              <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;opacity:.72">${esc(id)}</span>
              <span style="font-size:12px;opacity:.76">${esc(candidate.knownCount || 0)} known · ${esc(candidate.localBindingCount || 0)} local bindings · Chrome mirror only</span>
            </span>
          </label>
        `;
      }).join("");
    }
  }
  settingsFolderCleanupUpdateDeleteControls(panel);
}

function settingsFolderConflictNormalizeName(row){
  const src = row && typeof row === "object" ? row : {};
  return String(src.normalizedName || src.name || "").trim().toLowerCase();
}

function settingsFolderConflictBucketSummary(mirror, folderId){
  const id = String(folderId || "").trim();
  const items = mirror?.items && typeof mirror.items === "object" ? mirror.items : null;
  if (!items || !id) return { state: "unavailable", count: 0, bindings: [] };
  if (!Object.prototype.hasOwnProperty.call(items, id)) return { state: "missing", count: 0, bindings: [] };
  const bucket = items[id];
  if (Array.isArray(bucket)) {
    return {
      state: "array",
      count: bucket.length,
      bindings: settingsFolderCleanupClone(bucket) || [],
    };
  }
  return { state: "malformed", count: 0, bindings: [] };
}

function settingsFolderConflictFolderFromRow(row, role, mirror){
  const src = row && typeof row === "object" ? row : {};
  const folderId = String(src.folderId || src.id || "").trim();
  const bucket = settingsFolderConflictBucketSummary(mirror, folderId);
  const badges = Array.isArray(src.badges) ? src.badges.slice() : [];
  if (role === "canonical" && !badges.includes("canonical")) badges.push("canonical");
  if (role === "duplicate") {
    if (!badges.includes("extra")) badges.push("extra");
    if (!badges.includes("conflict")) badges.push("conflict");
    if (!badges.includes("review")) badges.push("review");
  }
  return {
    folderId,
    name: String(src.name || folderId || "Folder").trim(),
    canonicalCount: settingsFolderCleanupNumber(src.canonicalCount),
    knownCount: settingsFolderCleanupNumber(src.knownCount),
    localBindingCount: Math.max(settingsFolderCleanupRowBindingCount(src), bucket.count),
    nativePresence: !!src.isCanonical,
    bindings: bucket.bindings,
    bucketState: bucket.state,
    bucketCount: bucket.count,
    isExtra: !!src.isExtra,
    isConflict: !!src.isConflict,
    isTestCandidate: !!src.isTestCandidate,
    badges,
    riskLevel: role === "canonical" ? "protected" : "high-review-required",
    proposedAction: role === "canonical"
      ? "Preserve canonical folder."
      : "Review-only. Keep both until bindings and intent are confirmed.",
    warnings: role === "canonical"
      ? ["Canonical native folder. Not a conflict cleanup target."]
      : ["Same-name/different-ID conflict.", "No merge/delete/move performed."],
  };
}

function settingsFolderConflictBuildPlan(selfCheck, displayModel, mirror = null, mirrorWarning = ""){
  const rows = Array.isArray(displayModel?.rows) ? displayModel.rows : [];
  const surface = String(selfCheck?.surface || displayModel?.surface || "");
  const groups = new Map();
  for (const row of rows) {
    const normalizedName = settingsFolderConflictNormalizeName(row);
    if (!normalizedName) continue;
    if (!groups.has(normalizedName)) groups.set(normalizedName, []);
    groups.get(normalizedName).push(row);
  }

  const conflicts = [];
  for (const [normalizedName, groupRows] of groups.entries()) {
    const canonicalRows = groupRows.filter((row) => !!row?.isCanonical);
    const duplicateRows = groupRows.filter((row) => !row?.isCanonical && (!!row?.isConflict || canonicalRows.length > 0));
    if (!canonicalRows.length || !duplicateRows.length) continue;
    const canonicalRow = canonicalRows[0];
    conflicts.push({
      normalizedName,
      canonicalFolder: settingsFolderConflictFolderFromRow(canonicalRow, "canonical", mirror),
      duplicateFolders: duplicateRows.map((row) => settingsFolderConflictFolderFromRow(row, "duplicate", mirror)),
      proposedResolution: "keep-both-until-reviewed",
      allowedActions: ["keep-both", "copy-conflict-plan"],
      blockedActions: [
        "delete-duplicate",
        "merge-duplicate-into-canonical",
        "move-bindings-to-canonical",
        "merge-metadata-to-canonical",
      ],
      requiresApproval: true,
    });
  }

  conflicts.sort((a, b) => String(a.normalizedName).localeCompare(String(b.normalizedName)));
  return {
    readOnly: true,
    noMutation: true,
    generatedAt: new Date().toISOString(),
    surface,
    conflictCount: conflicts.length,
    mirrorAvailable: !!mirror,
    mirrorWarning: String(mirrorWarning || ""),
    conflicts,
    safetyRules: [
      "P7c-a is review-only.",
      "No merge/delete/move is performed.",
      "No Chrome storage, SQLite, or native folder-state writes are performed.",
      "Canonical f_* folders are protected.",
      "Same-name conflicts require explicit future approval before any action.",
    ],
    futurePhases: [
      "P7c-b may later remove an empty duplicate only after explicit confirmation and audit.",
      "P7c-c may later reassign bindings only after exact binding review and audit.",
      "P7d handles Desktop cleanup separately.",
    ],
  };
}

function settingsFolderConflictFolderHtml(folder, label){
  const bindings = Array.isArray(folder?.bindings) ? folder.bindings : [];
  const bindingSample = bindings.length
    ? `<div style="font-size:12px;opacity:.72"><strong>Binding sample:</strong> ${esc(bindings.slice(0, 3).map((item) => typeof item === "string" ? item : JSON.stringify(item)).join(", "))}${bindings.length > 3 ? "…" : ""}</div>`
    : "";
  return `
    <div style="border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.035);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <strong>${esc(label)}: ${esc(folder?.name || "(unnamed)")}</strong>
        <span>${settingsFolderCleanupBadgesHtml(folder)}</span>
      </div>
      <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;opacity:.72">${esc(folder?.folderId || "(no folder id)")}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:4px 12px;font-size:12px">
        <span>native ${esc(folder?.canonicalCount ?? 0)}</span>
        <span>known ${esc(folder?.knownCount ?? 0)}</span>
        <span>local bindings ${esc(folder?.localBindingCount ?? 0)}</span>
        <span>bucket ${esc(folder?.bucketState || "unavailable")} (${esc(folder?.bucketCount ?? 0)})</span>
      </div>
      <div style="font-size:12px"><strong>Review:</strong> ${esc(folder?.proposedAction || "Review only.")}</div>
      <div style="font-size:12px"><strong>Risk:</strong> ${esc(folder?.riskLevel || "review")}</div>
      ${Array.isArray(folder?.warnings) && folder.warnings.length ? `<div style="font-size:12px;opacity:.78"><strong>Why:</strong> ${esc(folder.warnings.join(" "))}</div>` : ""}
      ${bindingSample}
    </div>
  `;
}

function settingsFolderConflictHtml(conflict){
  const duplicateRows = Array.isArray(conflict?.duplicateFolders) ? conflict.duplicateFolders : [];
  return `
    <details open style="border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:8px;background:rgba(255,255,255,.025)">
      <summary style="cursor:pointer;font-weight:600">${esc(conflict?.normalizedName || "folder")} <span style="opacity:.65">(${duplicateRows.length} duplicate${duplicateRows.length === 1 ? "" : "s"})</span></summary>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
        <div style="font-size:12px;opacity:.76">Recommendation: Review-only. Keep both until bindings and intent are confirmed. No merge/delete/move performed.</div>
        ${settingsFolderConflictFolderHtml(conflict?.canonicalFolder, "Canonical")}
        ${duplicateRows.map((folder) => settingsFolderConflictFolderHtml(folder, "Duplicate")).join("")}
      </div>
    </details>
  `;
}

function settingsFolderConflictRenderPlan(panel, plan){
  const summary = panel?.querySelector("#wbSettingsFolderConflictSummary");
  const groups = panel?.querySelector("#wbSettingsFolderConflictGroups");
  const englishGroups = panel?.querySelector("#wbSettingsFolderConflictGroupsEnglish");
  const copyBtn = panel?.querySelector("#wbSettingsFolderConflictCopy");
  const conflicts = Array.isArray(plan?.conflicts) ? plan.conflicts : [];
  const conflictName = (conflict) => String(conflict?.normalizedName || conflict?.name || "").trim().toLowerCase();
  const caseConflicts = conflicts.filter((conflict) => conflictName(conflict) === "case");
  const englishConflicts = conflicts.filter((conflict) => conflictName(conflict) === "english");
  if (summary) {
    const mirrorText = plan?.mirrorWarning ? ` Mirror buckets unavailable: ${plan.mirrorWarning}` : "";
    summary.textContent = `${conflicts.length} same-name conflict group${conflicts.length === 1 ? "" : "s"}. Review-only. No merge or deletion performed.${mirrorText}`;
  }
  if (groups) {
    const rows = caseConflicts.length ? caseConflicts : conflicts;
    groups.innerHTML = rows.length
      ? rows.map(settingsFolderConflictHtml).join("")
      : `<div style="opacity:.72;font-size:12px">No Case conflict detected.</div>`;
  }
  if (englishGroups) {
    englishGroups.innerHTML = englishConflicts.length
      ? englishConflicts.map(settingsFolderConflictHtml).join("")
      : `<div style="opacity:.72;font-size:12px">No English conflict detected.</div>`;
  }
  if (copyBtn) copyBtn.disabled = false;
  settingsFolderConflictRenderDeletePanel(panel, plan);
}

async function settingsFolderConflictLoadInputs(seed = null){
  const parity = W.H2O?.Library?.FolderParity;
  if (!parity || typeof parity.selfCheck !== "function" || typeof parity.getDisplayModel !== "function") {
    throw new Error("FolderParity conflict review APIs unavailable");
  }
  const selfCheck = seed?.selfCheck || await promiseWithTimeout(parity.selfCheck({ fresh: true }), STUDIO_BOOT_AUX_TIMEOUT_MS, "FolderParity.selfCheck");
  const displayModel = seed?.displayModel || await promiseWithTimeout(parity.getDisplayModel({ fresh: true }), STUDIO_BOOT_AUX_TIMEOUT_MS, "FolderParity.getDisplayModel");
  let mirror = null;
  let mirrorWarning = "";
  if (settingsFolderCleanupIsChromeSurface()) {
    try { mirror = await settingsFolderCleanupReadChromeMirror(); }
    catch (err) { mirrorWarning = String(err && (err.message || err)); }
  }
  return {
    selfCheck,
    displayModel,
    mirror,
    plan: settingsFolderConflictBuildPlan(selfCheck, displayModel, mirror, mirrorWarning),
  };
}

async function refreshSettingsFolderConflictReview(panel, seed = null){
  if (!panel) return null;
  const summary = panel.querySelector("#wbSettingsFolderConflictSummary");
  const copyBtn = panel.querySelector("#wbSettingsFolderConflictCopy");
  settingsFolderParitySetOperationStatus(panel, "conflictReview", "running", "Refreshing");
  if (summary) summary.textContent = "Refreshing same-name conflict review…";
  if (copyBtn) copyBtn.disabled = true;
  const loaded = await settingsFolderConflictLoadInputs(seed);
  panel.__h2oFolderConflictReviewPlan = loaded.plan;
  settingsFolderConflictRenderPlan(panel, loaded.plan);
  settingsFolderParitySetOperationStatus(panel, "conflictReview", loaded.plan?.conflictCount ? "warning" : "works", loaded.plan?.conflictCount ? `${loaded.plan.conflictCount} conflict(s)` : "No same-name conflicts");
  settingsFolderParityRenderOperationRows(panel);
  return loaded.plan;
}

async function copySettingsFolderConflictPlan(panel){
  if (!panel) return;
  let plan = panel.__h2oFolderConflictReviewPlan;
  if (!plan) plan = await refreshSettingsFolderConflictReview(panel);
  const text = JSON.stringify(plan || {}, null, 2);
  try {
    if (W.navigator?.clipboard?.writeText) {
      await W.navigator.clipboard.writeText(text);
      settingsFolderParityLog(panel, "Folder conflict review plan JSON copied to clipboard.");
      return;
    }
  } catch (err) {
    settingsFolderParityLog(panel, "Clipboard copy failed; conflict review plan printed to console.\n" + String(err && (err.message || err)));
  }
  try { console.log("H2O_FOLDER_CONFLICT_REVIEW_PLAN", plan); } catch {}
  settingsFolderParityLog(panel, "Clipboard unavailable; folder conflict review plan printed to console as H2O_FOLDER_CONFLICT_REVIEW_PLAN.");
}

function settingsFolderConflictDeletionRows(plan){
  const conflicts = Array.isArray(plan?.conflicts) ? plan.conflicts : [];
  const rows = [];
  for (const conflict of conflicts) {
    const canonical = conflict?.canonicalFolder || null;
    const duplicates = Array.isArray(conflict?.duplicateFolders) ? conflict.duplicateFolders : [];
    for (const duplicate of duplicates) {
      rows.push({
        ...duplicate,
        normalizedName: String(conflict?.normalizedName || duplicate?.normalizedName || duplicate?.name || "").trim().toLowerCase(),
        canonicalFolderId: String(canonical?.folderId || "").trim(),
        canonicalFolderName: String(canonical?.name || "").trim(),
        canonicalFolder: canonical,
      });
    }
  }
  return rows;
}

function settingsFolderConflictDeletionBlockers(row, mirror = null){
  const candidate = row && typeof row === "object" ? row : {};
  const folderId = String(candidate.folderId || "").trim();
  const blockers = [];
  if (!folderId) blockers.push("missing duplicate folder ID");
  if (!candidate.canonicalFolderId) blockers.push("missing canonical counterpart");
  if (candidate.isCanonical) blockers.push("duplicate marked canonical");
  if (/^f_/.test(folderId)) blockers.push("duplicate has canonical native ID prefix");
  if (candidate.nativePresence) blockers.push("duplicate native-present");
  if (settingsFolderCleanupIsF5DReviewCandidate(candidate)) blockers.push("F5D/Desktop review item");
  if (settingsFolderCleanupNumber(candidate.knownCount) > 0) blockers.push("known rows present");
  if (settingsFolderCleanupNumber(candidate.localBindingCount) > 0) blockers.push("local bindings present");
  if (!mirror) blockers.push("Chrome mirror unavailable");
  if (mirror) {
    const folders = Array.isArray(mirror.folders) ? mirror.folders : [];
    const folderExists = folders.some((folder) => String(folder?.id || folder?.folderId || "").trim() === folderId);
    if (!folderExists) blockers.push("duplicate not present in Chrome mirror folders[]");
    const items = mirror.items && typeof mirror.items === "object" ? mirror.items : {};
    const bucket = items[folderId];
    if (Array.isArray(bucket) && bucket.length > 0) blockers.push("items bucket non-empty");
    if (bucket != null && !Array.isArray(bucket)) blockers.push("items bucket malformed");
  }
  return blockers;
}

function settingsFolderConflictEligibleDeletionRows(plan, mirror = null){
  return settingsFolderConflictDeletionRows(plan)
    .map((row) => ({
      ...row,
      deletionBlockers: settingsFolderConflictDeletionBlockers(row, mirror),
    }))
    .filter((row) => row.deletionBlockers.length === 0);
}

function settingsFolderConflictLooksEmptyDuplicate(row){
  const candidate = row && typeof row === "object" ? row : {};
  const folderId = String(candidate.folderId || "").trim();
  if (!folderId || !candidate.canonicalFolderId) return false;
  if (candidate.isCanonical || /^f_/.test(folderId) || candidate.nativePresence) return false;
  if (settingsFolderCleanupIsF5DReviewCandidate(candidate)) return false;
  if (settingsFolderCleanupNumber(candidate.knownCount) > 0) return false;
  if (settingsFolderCleanupNumber(candidate.localBindingCount) > 0) return false;
  return candidate.bucketState === "missing"
    || (candidate.bucketState === "array" && settingsFolderCleanupNumber(candidate.bucketCount) === 0);
}

function settingsFolderConflictSelectedIds(panel){
  const boxes = Array.from(panel?.querySelectorAll?.("#wbSettingsFolderConflictDeleteList input[data-folder-id]") || []);
  return boxes
    .filter((box) => !!box.checked)
    .map((box) => String(box.dataset.folderId || "").trim())
    .filter(Boolean);
}

function settingsFolderConflictRenderDeletePanel(panel, plan){
  const summary = panel?.querySelector("#wbSettingsFolderConflictDeleteSummary");
  const list = panel?.querySelector("#wbSettingsFolderConflictDeleteList");
  const previewEl = panel?.querySelector("#wbSettingsFolderConflictDeletePreview");
  const copyBtn = panel?.querySelector("#wbSettingsFolderConflictCopyDeletePlan");
  const chromeSurface = settingsFolderCleanupIsChromeSurface();
  const mirrorUnavailable = !!plan?.mirrorWarning || !plan?.mirrorAvailable;
  const candidates = chromeSurface && !mirrorUnavailable
    ? settingsFolderConflictDeletionRows(plan).filter(settingsFolderConflictLooksEmptyDuplicate)
    : [];
  const previousSelected = new Set(Array.isArray(panel?.__h2oFolderConflictDeleteSelectedIds) ? panel.__h2oFolderConflictDeleteSelectedIds : []);

  panel.__h2oFolderConflictDeletionPreview = null;
  if (previewEl) {
    previewEl.hidden = true;
    previewEl.textContent = "";
  }
  if (copyBtn) copyBtn.disabled = true;
  if (summary) {
    summary.textContent = chromeSurface
      ? "Chrome mirror only. Canonical folders, Desktop SQLite, and native folder-state are not modified."
      : "Duplicate conflict cleanup is only available in Studio Launcher. Desktop cleanup is separate and not performed.";
  }
  if (list) {
    if (!chromeSurface) {
      list.innerHTML = `<div style="opacity:.72;font-size:12px">Unavailable on this surface. No SQLite writes are performed.</div>`;
    } else if (mirrorUnavailable) {
      list.innerHTML = `<div style="opacity:.72;font-size:12px">Chrome mirror buckets are unavailable, so duplicate deletion is disabled.</div>`;
    } else if (!candidates.length) {
      list.innerHTML = `<div style="opacity:.72;font-size:12px">No empty duplicate conflict folders are currently eligible for deletion.</div>`;
    } else {
      list.innerHTML = candidates.map((candidate) => {
        const id = String(candidate.folderId || "").trim();
        const checked = previousSelected.has(id) ? " checked" : "";
        return `
          <label style="display:grid;grid-template-columns:max-content 1fr;gap:8px;align-items:start;border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:8px;background:rgba(255,255,255,.025)">
            <input type="checkbox" data-folder-id="${esc(id)}"${checked} />
            <span style="display:flex;flex-direction:column;gap:3px">
              <strong>${esc(candidate.name || id)}</strong>
              <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;opacity:.72">${esc(id)}</span>
              <span style="font-size:12px;opacity:.76">Canonical counterpart ${esc(candidate.canonicalFolderId || "missing")} · ${esc(candidate.knownCount || 0)} known · ${esc(candidate.localBindingCount || 0)} local bindings</span>
            </span>
          </label>
        `;
      }).join("");
    }
  }
  settingsFolderConflictUpdateDeleteControls(panel);
}

function settingsFolderConflictValidateDeletionSelection(selectedIds, plan, mirror){
  const ids = Array.from(new Set((Array.isArray(selectedIds) ? selectedIds : []).map((id) => String(id || "").trim()).filter(Boolean)));
  if (!settingsFolderCleanupIsChromeSurface()) {
    return { ok: false, error: "Duplicate conflict cleanup is unavailable on this surface.", candidates: [], selectedDuplicateFolderIds: ids };
  }
  if (!ids.length) return { ok: false, error: "Select at least one empty duplicate conflict folder.", candidates: [], selectedDuplicateFolderIds: ids };
  const duplicateRows = settingsFolderConflictDeletionRows(plan);
  const byId = new Map(duplicateRows.map((row) => [String(row.folderId || "").trim(), row]));
  const candidates = [];
  for (const folderId of ids) {
    const candidate = byId.get(folderId);
    if (!candidate) return { ok: false, error: `${folderId} is not in the current same-name conflict model.`, candidates, selectedDuplicateFolderIds: ids };
    const blockers = settingsFolderConflictDeletionBlockers(candidate, mirror);
    if (blockers.length) {
      return { ok: false, error: `${folderId} is not eligible: ${blockers.join(", ")}.`, candidates, selectedDuplicateFolderIds: ids };
    }
    candidates.push({
      folderId,
      name: candidate.name,
      normalizedName: candidate.normalizedName,
      canonicalFolderId: candidate.canonicalFolderId,
      canonicalFolderName: candidate.canonicalFolderName,
      bucketState: candidate.bucketState,
      bucketCount: settingsFolderCleanupNumber(candidate.bucketCount),
      knownCount: settingsFolderCleanupNumber(candidate.knownCount),
      localBindingCount: settingsFolderCleanupNumber(candidate.localBindingCount),
      nativePresence: !!candidate.nativePresence,
      riskLevel: candidate.riskLevel || "high-review-required",
      eligibilityReason: "Empty non-canonical same-name duplicate in Chrome mirror; canonical counterpart exists and no native presence, known rows, local bindings, F5D marker, or mirror items were found.",
    });
  }
  return { ok: true, candidates, selectedDuplicateFolderIds: ids };
}

function settingsFolderConflictBuildDeletionPreview(selectedIds, plan, mirror){
  const validation = settingsFolderConflictValidateDeletionSelection(selectedIds, plan, mirror);
  if (!validation.ok) return { ok: false, error: validation.error, selectedDuplicateFolderIds: validation.selectedDuplicateFolderIds || [] };
  const beforeSummary = settingsFolderCleanupFolderStateSummary(mirror.state);
  return {
    ok: true,
    readOnly: false,
    noMutation: true,
    mutation: "preview-only",
    generatedAt: new Date().toISOString(),
    surface: "chrome-studio",
    action: "delete-empty-duplicate-conflict-folders",
    key: FOLDER_STATE_DATA_KEY,
    selectedDuplicateFolderIds: validation.selectedDuplicateFolderIds,
    canonicalCounterpartIds: Array.from(new Set(validation.candidates.map((row) => row.canonicalFolderId).filter(Boolean))),
    selectedDuplicates: validation.candidates,
    beforeFolderCount: beforeSummary.folderCount,
    predictedAfterFolderCount: beforeSummary.folderCount - validation.selectedDuplicateFolderIds.length,
    beforeFolderStateSummary: beforeSummary,
    confirmationText: FOLDER_DUPLICATE_CLEANUP_CONFIRM_TEXT,
  };
}

function settingsFolderConflictUpdateDeleteControls(panel){
  const operatorMode = folderOperatorModeEnabled();
  const chromeSurface = settingsFolderCleanupIsChromeSurface();
  const selectedIds = settingsFolderConflictSelectedIds(panel);
  panel.__h2oFolderConflictDeleteSelectedIds = selectedIds;
  const preview = panel?.__h2oFolderConflictDeletionPreview;
  const previewBtn = panel?.querySelector("#wbSettingsFolderConflictPreviewDelete");
  const copyBtn = panel?.querySelector("#wbSettingsFolderConflictCopyDeletePlan");
  const confirmInput = panel?.querySelector("#wbSettingsFolderConflictDeleteConfirm");
  const deleteBtn = panel?.querySelector("#wbSettingsFolderConflictDeleteSelected");
  const confirmationOk = String(confirmInput?.value || "") === FOLDER_DUPLICATE_CLEANUP_CONFIRM_TEXT;
  const selectedMatchesPreview = !!preview?.ok
    && JSON.stringify((preview.selectedDuplicateFolderIds || []).slice().sort()) === JSON.stringify(selectedIds.slice().sort());
  if (previewBtn) previewBtn.disabled = !operatorMode || !chromeSurface || selectedIds.length === 0;
  if (copyBtn) copyBtn.disabled = !operatorMode || !preview?.ok;
  if (deleteBtn) deleteBtn.disabled = !operatorMode || !chromeSurface || !selectedMatchesPreview || !confirmationOk;
}

async function previewSettingsFolderConflictDeletion(panel){
  if (!panel) return null;
  const previewEl = panel.querySelector("#wbSettingsFolderConflictDeletePreview");
  const selectedIds = settingsFolderConflictSelectedIds(panel);
  const loaded = await settingsFolderConflictLoadInputs();
  if (!loaded.mirror) throw new Error(loaded.plan?.mirrorWarning || "Chrome mirror unavailable.");
  const preview = settingsFolderConflictBuildDeletionPreview(selectedIds, loaded.plan, loaded.mirror);
  panel.__h2oFolderConflictReviewPlan = loaded.plan;
  panel.__h2oFolderConflictDeletionPreview = preview.ok ? preview : null;
  if (previewEl) {
    previewEl.hidden = false;
    previewEl.textContent = JSON.stringify(preview, null, 2);
  }
  if (!preview.ok) settingsFolderParityLog(panel, "Folder conflict deletion preview blocked.\n" + String(preview.error || "Unknown guard failure"));
  settingsFolderConflictUpdateDeleteControls(panel);
  return preview;
}

async function copySettingsFolderConflictDeletionPlan(panel){
  if (!panel) return;
  let preview = panel.__h2oFolderConflictDeletionPreview;
  if (!preview) preview = await previewSettingsFolderConflictDeletion(panel);
  const text = JSON.stringify(preview || {}, null, 2);
  try {
    if (W.navigator?.clipboard?.writeText) {
      await W.navigator.clipboard.writeText(text);
      settingsFolderParityLog(panel, "Folder conflict deletion plan JSON copied to clipboard.");
      return;
    }
  } catch (err) {
    settingsFolderParityLog(panel, "Clipboard copy failed; conflict deletion plan printed to console.\n" + String(err && (err.message || err)));
  }
  try { console.log("H2O_FOLDER_CONFLICT_DELETE_PLAN", preview); } catch {}
  settingsFolderParityLog(panel, "Clipboard unavailable; folder conflict deletion plan printed to console as H2O_FOLDER_CONFLICT_DELETE_PLAN.");
}

async function deleteSelectedEmptyDuplicateConflictFolders(panel){
  if (!panel) return;
  if (!folderOperatorModeEnabled()) {
    settingsFolderParityLog(panel, "Folder operator mode is required for cleanup mutation.");
    settingsFolderConflictUpdateDeleteControls(panel);
    return;
  }
  const previewEl = panel.querySelector("#wbSettingsFolderConflictDeletePreview");
  const confirmValue = String(panel.querySelector("#wbSettingsFolderConflictDeleteConfirm")?.value || "");
  if (confirmValue !== FOLDER_DUPLICATE_CLEANUP_CONFIRM_TEXT) {
    settingsFolderParityLog(panel, "Duplicate deletion blocked. Confirmation text does not match.");
    settingsFolderConflictUpdateDeleteControls(panel);
    return;
  }
  const selectedIds = settingsFolderConflictSelectedIds(panel);
  const existingPreview = panel.__h2oFolderConflictDeletionPreview;
  const previewMatchesSelection = !!existingPreview?.ok
    && JSON.stringify((existingPreview.selectedDuplicateFolderIds || []).slice().sort()) === JSON.stringify(selectedIds.slice().sort());
  if (!previewMatchesSelection) {
    settingsFolderParityLog(panel, "Duplicate deletion blocked. Generate a fresh deletion preview for the selected folders first.");
    settingsFolderConflictUpdateDeleteControls(panel);
    return;
  }

  const loaded = await settingsFolderConflictLoadInputs();
  if (!loaded.mirror) throw new Error(loaded.plan?.mirrorWarning || "Chrome mirror unavailable.");
  const validation = settingsFolderConflictValidateDeletionSelection(selectedIds, loaded.plan, loaded.mirror);
  if (!validation.ok) {
    settingsFolderParityLog(panel, "Duplicate deletion aborted before mutation.\n" + String(validation.error || "Guard failed"));
    settingsFolderConflictUpdateDeleteControls(panel);
    return;
  }

  const beforeSummary = settingsFolderCleanupFolderStateSummary(loaded.mirror.state);
  const canonicalCounterpartIds = Array.from(new Set(validation.candidates.map((row) => row.canonicalFolderId).filter(Boolean)));
  const pendingAudit = {
    timestamp: new Date().toISOString(),
    surface: "chrome-studio",
    action: "delete-empty-duplicate-conflict-folders",
    selectedDuplicateFolderIds: validation.selectedDuplicateFolderIds,
    canonicalCounterpartIds,
    beforeSelfCheck: loaded.selfCheck,
    beforeConflictModel: loaded.plan,
    beforeFolderStateSummary: beforeSummary,
    beforeFolderStateSnapshot: settingsFolderCleanupClone(loaded.mirror.state),
    result: "pending",
    errors: [],
  };

  await settingsFolderCleanupAppendAudit(pendingAudit);

  let resultAudit = {
    ...pendingAudit,
    timestamp: new Date().toISOString(),
    beforeFolderStateSnapshot: null,
  };
  try {
    const nextState = settingsFolderCleanupBuildNextState(loaded.mirror, validation.selectedDuplicateFolderIds);
    await settingsFolderCleanupChromeSetStrict({ [FOLDER_STATE_DATA_KEY]: nextState });
    try { W.H2O?.LibraryWorkspace?._bustCaches?.("folder-conflict-delete-empty-duplicates"); } catch {}
    try { await W.H2O?.LibraryIndex?.refresh?.("folder-conflict-delete-empty-duplicates"); } catch {}

    const afterLoaded = await settingsFolderConflictLoadInputs();
    resultAudit = {
      ...resultAudit,
      result: "ok",
      afterSelfCheck: afterLoaded.selfCheck,
      afterFolderStateSummary: afterLoaded.mirror ? settingsFolderCleanupFolderStateSummary(afterLoaded.mirror.state) : null,
      errors: [],
    };
    try { await settingsFolderCleanupAppendAudit(resultAudit); }
    catch (auditErr) {
      resultAudit.errors = ["Result audit append failed: " + String(auditErr && (auditErr.message || auditErr))];
    }
    const result = {
      ok: true,
      action: "delete-empty-duplicate-conflict-folders",
      selectedDuplicateFolderIds: validation.selectedDuplicateFolderIds,
      canonicalCounterpartIds,
      beforeFolderStateSummary: beforeSummary,
      afterFolderStateSummary: resultAudit.afterFolderStateSummary,
      auditWarning: resultAudit.errors[0] || "",
      auditKey: FOLDER_CLEANUP_AUDIT_KEY,
    };
    if (previewEl) {
      previewEl.hidden = false;
      previewEl.textContent = JSON.stringify(result, null, 2);
    }
    settingsFolderParityLog(panel, "Selected empty duplicate conflict folder(s) deleted. Canonical folders, native folder-state, and Desktop SQLite were not modified.");
    panel.__h2oFolderConflictDeletionPreview = null;
    panel.__h2oFolderConflictDeleteSelectedIds = [];
    const input = panel.querySelector("#wbSettingsFolderConflictDeleteConfirm");
    if (input) input.value = "";
    await refreshSettingsFolderParity(panel);
    const refreshedPreviewEl = panel.querySelector("#wbSettingsFolderConflictDeletePreview");
    if (refreshedPreviewEl) {
      refreshedPreviewEl.hidden = false;
      refreshedPreviewEl.textContent = JSON.stringify(result, null, 2);
    }
  } catch (err) {
    resultAudit = {
      ...resultAudit,
      result: "failed",
      afterSelfCheck: null,
      afterFolderStateSummary: null,
      errors: [String(err && (err.stack || err.message || err))],
    };
    try { await settingsFolderCleanupAppendAudit(resultAudit); } catch {}
    settingsFolderParityLog(panel, "Duplicate deletion failed after pending audit.\n" + String(err && (err.stack || err.message || err)));
    throw err;
  } finally {
    settingsFolderConflictUpdateDeleteControls(panel);
  }
}

function settingsFolderDesktopFolderIdOf(row){
  return String(row?.folderId || row?.id || row?.folder_id || "").trim();
}

function settingsFolderDesktopNameOf(row){
  const id = settingsFolderDesktopFolderIdOf(row);
  return String(row?.name || row?.title || row?.label || id || "Folder").trim();
}

function settingsFolderDesktopNormalizeFolder(row){
  const src = row && typeof row === "object" ? row : {};
  const folderId = settingsFolderDesktopFolderIdOf(src);
  if (!folderId) return null;
  return {
    folderId,
    id: folderId,
    name: settingsFolderDesktopNameOf(src),
    source: String(src.source || src.originSource || "").trim(),
    color: String(src.color || src.iconColor || "").trim(),
    sortOrder: settingsFolderCleanupNumber(src.sortOrder ?? src.sort_order),
    createdAt: src.createdAt ?? src.created_at ?? null,
    updatedAt: src.updatedAt ?? src.updated_at ?? null,
    raw: settingsFolderCleanupClone(src),
  };
}

async function settingsFolderDesktopCallMaybe(obj, names, ...args){
  const list = Array.isArray(names) ? names : [];
  for (const name of list) {
    if (typeof obj?.[name] !== "function") continue;
    try {
      return { method: name, ok: true, value: await obj[name](...args) };
    } catch (err) {
      return { method: name, ok: false, error: String(err && (err.stack || err.message || err)) };
    }
  }
  return { method: null, ok: false, error: "no method available" };
}

async function settingsFolderDesktopSqlSelect(query, values = []){
  if (!STUDIO_isTauri()) {
    return { ok: false, error: "not desktop runtime", rows: [] };
  }
  const invoke = STUDIO_getTauriInvoke();
  if (typeof invoke !== "function") {
    return { ok: false, error: "Tauri invoke unavailable", rows: [] };
  }
  try {
    const rows = await invoke("plugin:sql|select", {
      db: "sqlite:studio-v1.db",
      query: String(query || ""),
      values: Array.isArray(values) ? values : [],
    });
    return { ok: true, rows: Array.isArray(rows) ? rows : [] };
  } catch (err) {
    return { ok: false, error: String(err && (err.stack || err.message || err)), rows: [] };
  }
}

async function settingsFolderDesktopListFolders(){
  const foldersStore = W.H2O?.Studio?.store?.folders;
  const viaStore = await settingsFolderDesktopCallMaybe(foldersStore, ["list", "getAll", "listFolders"]);
  if (viaStore.ok && Array.isArray(viaStore.value)) {
    return {
      source: `store.folders.${viaStore.method}`,
      folders: viaStore.value.map(settingsFolderDesktopNormalizeFolder).filter(Boolean),
      warnings: [],
    };
  }
  const sql = await settingsFolderDesktopSqlSelect(
    "SELECT id, name, source, color, sort_order, created_at, updated_at, meta_json FROM folders ORDER BY id",
    []
  );
  if (sql.ok) {
    return {
      source: "sqlite-readonly",
      folders: sql.rows.map(settingsFolderDesktopNormalizeFolder).filter(Boolean),
      warnings: viaStore.error && viaStore.error !== "no method available" ? [`Store folder list failed: ${viaStore.error}`] : [],
    };
  }
  return {
    source: "unavailable",
    folders: [],
    warnings: [
      viaStore.error ? `Store folder list unavailable: ${viaStore.error}` : "Store folder list unavailable.",
      sql.error ? `SQLite folder list unavailable: ${sql.error}` : "SQLite folder list unavailable.",
    ],
  };
}

function settingsFolderDesktopNormalizeBinding(row, folderId = ""){
  const src = row && typeof row === "object" ? row : {};
  const chatId = String(src.chatId || src.chat_id || src.id || "").trim();
  const fid = String(src.folderId || src.folder_id || folderId || "").trim();
  if (!chatId || !fid) return null;
  return {
    chatId,
    folderId: fid,
    assignedAt: src.assignedAt ?? src.assigned_at ?? null,
    raw: settingsFolderCleanupClone(src),
  };
}

async function settingsFolderDesktopBindingsForFolder(folderId){
  const id = String(folderId || "").trim();
  if (!id) return { source: "missing-folder-id", bindings: [], warnings: ["Missing folder ID."] };
  const foldersStore = W.H2O?.Studio?.store?.folders;
  const direct = await settingsFolderDesktopCallMaybe(foldersStore, [
    "listBindings",
    "getBindings",
    "listFolderBindings",
    "bindingsForFolder",
    "getFolderBindings",
  ], id);
  if (direct.ok && Array.isArray(direct.value)) {
    return {
      source: `store.folders.${direct.method}`,
      bindings: direct.value.map((row) => settingsFolderDesktopNormalizeBinding(row, id)).filter(Boolean),
      warnings: [],
    };
  }
  const sql = await settingsFolderDesktopSqlSelect(
    "SELECT chat_id, folder_id, assigned_at FROM folder_bindings WHERE folder_id = ? ORDER BY assigned_at DESC",
    [id]
  );
  if (sql.ok) {
    return {
      source: "sqlite-readonly",
      bindings: sql.rows.map((row) => settingsFolderDesktopNormalizeBinding(row, id)).filter(Boolean),
      warnings: direct.error && direct.error !== "no method available" ? [`Store binding read failed: ${direct.error}`] : [],
    };
  }
  const listChats = await settingsFolderDesktopCallMaybe(foldersStore, ["listChats"], id);
  if (listChats.ok && Array.isArray(listChats.value)) {
    return {
      source: "store.folders.listChats",
      bindings: listChats.value.map((chat) => settingsFolderDesktopNormalizeBinding({
        chatId: chat?.id || chat?.chatId || chat?.sourceId || chat?.source_id,
        folderId: id,
      }, id)).filter(Boolean),
      warnings: [
        "Binding source hydrated known chats only; orphan bindings may be hidden.",
        sql.error ? `SQLite binding read unavailable: ${sql.error}` : "",
      ].filter(Boolean),
    };
  }
  return {
    source: "unavailable",
    bindings: [],
    warnings: [
      direct.error ? `Store binding API unavailable: ${direct.error}` : "Store binding API unavailable.",
      sql.error ? `SQLite binding read unavailable: ${sql.error}` : "SQLite binding read unavailable.",
      listChats.error ? `Known-chat fallback unavailable: ${listChats.error}` : "",
    ].filter(Boolean),
  };
}

function settingsFolderDesktopNormalizeKnownChat(row){
  const src = row && typeof row === "object" ? row : {};
  const id = String(src.id || src.chatId || src.source_id || src.sourceId || "").trim();
  if (!id) return null;
  return {
    id,
    sourceId: String(src.sourceId || src.source_id || "").trim(),
    title: String(src.title || "").trim(),
    folderId: String(src.folderId || src.folder_id || "").trim(),
    isSaved: !!(src.isSaved ?? src.is_saved),
    isLinked: !!(src.isLinked ?? src.is_linked),
    href: String(src.href || "").trim(),
  };
}

async function settingsFolderDesktopKnownRowsForBindings(bindings){
  const chatsStore = W.H2O?.Studio?.store?.chats;
  const out = [];
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    const chatId = String(binding?.chatId || "").trim();
    if (!chatId) continue;
    let known = null;
    if (typeof chatsStore?.get === "function") {
      try { known = settingsFolderDesktopNormalizeKnownChat(await chatsStore.get(chatId)); }
      catch { known = null; }
    }
    if (!known) {
      const sql = await settingsFolderDesktopSqlSelect(
        "SELECT id, source_id, title, folder_id, is_saved, is_linked, href, normalized_href FROM chats WHERE id = ? OR source_id = ? LIMIT 1",
        [chatId, chatId]
      );
      if (sql.ok && sql.rows[0]) known = settingsFolderDesktopNormalizeKnownChat(sql.rows[0]);
    }
    out.push({
      chatId,
      folderId: binding.folderId,
      assignedAt: binding.assignedAt ?? null,
      known: !!known,
      chat: known,
    });
  }
  return out;
}

function settingsFolderDesktopRegistryFolderMatches(folderId){
  const id = String(folderId || "").trim();
  if (!id) return [];
  let rows = [];
  try { rows = W.H2O?.LibraryIndex?.getAll?.() || []; } catch { rows = []; }
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const values = [
      row?.folderId,
      row?.folder_id,
      row?.sourceId,
      row?.source_id,
      row?.id,
      row?.chatId,
      row?.snapshotId,
    ].map((value) => String(value || "").trim());
    return values.includes(id);
  }).slice(0, 8).map((row) => ({
    chatId: String(row?.chatId || "").trim(),
    sourceId: String(row?.sourceId || row?.source_id || "").trim(),
    snapshotId: String(row?.snapshotId || row?.id || "").trim(),
    title: String(row?.title || "").trim(),
    folderId: String(row?.folderId || row?.folder_id || "").trim(),
    view: String(row?.view || "").trim(),
  }));
}

async function settingsFolderDesktopDependenciesForFolder(folderId){
  const id = String(folderId || "").trim();
  if (!id) {
    return {
      folderRows: [],
      chatsByFolder: [],
      snapshotsByChatId: [],
      libraryRows: [],
      warnings: ["Missing folder ID."],
    };
  }
  const [folderResult, chatsResult, snapshotsResult] = await Promise.all([
    settingsFolderDesktopSqlSelect(
      "SELECT id, name, source, color, sort_order, created_at, updated_at, meta_json FROM folders WHERE id = ?",
      [id]
    ),
    settingsFolderDesktopSqlSelect(
      "SELECT id, source_id, title, folder_id, is_saved, is_linked, href, normalized_href FROM chats WHERE folder_id = ?",
      [id]
    ),
    settingsFolderDesktopSqlSelect(
      "SELECT id, chat_id, title FROM snapshots WHERE chat_id = ? LIMIT 10",
      [id]
    ),
  ]);
  const warnings = [];
  if (!folderResult.ok) warnings.push(`Folder row preflight failed: ${folderResult.error || "unknown error"}`);
  if (!chatsResult.ok) warnings.push(`Chat dependency preflight failed: ${chatsResult.error || "unknown error"}`);
  if (!snapshotsResult.ok) warnings.push(`Snapshot dependency preflight failed: ${snapshotsResult.error || "unknown error"}`);
  return {
    folderRows: settingsFolderDesktopSqlOkRows(folderResult).map(settingsFolderDesktopNormalizeFolder).filter(Boolean),
    chatsByFolder: settingsFolderDesktopSqlOkRows(chatsResult).map(settingsFolderDesktopNormalizeKnownChat).filter(Boolean),
    snapshotsByChatId: settingsFolderDesktopSqlOkRows(snapshotsResult).map((row) => ({
      id: String(row?.id || "").trim(),
      chatId: String(row?.chat_id || row?.chatId || "").trim(),
      title: String(row?.title || "").trim(),
    })),
    libraryRows: settingsFolderDesktopRegistryFolderMatches(id),
    warnings,
  };
}

async function settingsFolderDesktopLoadFacts(){
  if (!STUDIO_isTauri()) {
    return {
      available: false,
      surface: "chrome-studio",
      source: "not-desktop",
      folders: [],
      f5dFolders: [],
      bindingsByFolder: {},
      knownRowsByFolder: {},
      dependenciesByFolder: {},
      warnings: ["Desktop SQLite review is available only in Desktop Studio."],
      diagnose: null,
      storeMethods: [],
      deleteMethodsAvailable: [],
    };
  }
  const foldersStore = W.H2O?.Studio?.store?.folders;
  const listResult = await settingsFolderDesktopListFolders();
  const f5dFolders = listResult.folders.filter(settingsFolderCleanupIsF5DReviewCandidate);
  const bindingsByFolder = {};
  const knownRowsByFolder = {};
  const dependenciesByFolder = {};
  const warnings = listResult.warnings.slice();
  for (const folder of f5dFolders) {
    const bindingResult = await settingsFolderDesktopBindingsForFolder(folder.folderId);
    bindingsByFolder[folder.folderId] = bindingResult.bindings;
    if (bindingResult.warnings.length) {
      warnings.push(...bindingResult.warnings.map((msg) => `${folder.folderId}: ${msg}`));
    }
    knownRowsByFolder[folder.folderId] = await settingsFolderDesktopKnownRowsForBindings(bindingResult.bindings);
    dependenciesByFolder[folder.folderId] = await settingsFolderDesktopDependenciesForFolder(folder.folderId);
    if (dependenciesByFolder[folder.folderId].warnings.length) {
      warnings.push(...dependenciesByFolder[folder.folderId].warnings.map((msg) => `${folder.folderId}: ${msg}`));
    }
  }
  let diagnose = null;
  try { diagnose = typeof foldersStore?.diagnose === "function" ? await foldersStore.diagnose() : null; } catch {}
  const storeMethods = Object.keys(foldersStore || {}).filter((key) => typeof foldersStore[key] === "function").sort();
  return {
    available: true,
    surface: "desktop-studio",
    source: listResult.source,
    folders: listResult.folders,
    f5dFolders,
    bindingsByFolder,
    knownRowsByFolder,
    dependenciesByFolder,
    warnings: Array.from(new Set(warnings.filter(Boolean))),
    diagnose,
    storeMethods,
    deleteMethodsAvailable: storeMethods.filter((key) => /delete|remove/i.test(key)),
  };
}

function settingsFolderDesktopReadChromeStorage(keys){
  if (!hasChromeStorage()) return Promise.resolve({ ok: false, values: {}, error: "chrome.storage.local unavailable" });
  return new Promise((resolve) => {
    try {
      W.chrome.storage.local.get(keys, (result) => {
        const lastError = W.chrome?.runtime?.lastError;
        if (lastError) {
          resolve({ ok: false, values: {}, error: String(lastError.message || lastError) });
          return;
        }
        resolve({ ok: true, values: result || {}, error: "" });
      });
    } catch (err) {
      resolve({ ok: false, values: {}, error: String(err && (err.stack || err.message || err)) });
    }
  });
}

async function settingsFolderDesktopLoadChromeFacts(){
  const storage = await settingsFolderDesktopReadChromeStorage([FOLDER_STATE_DATA_KEY, FOLDER_CLEANUP_AUDIT_KEY]);
  if (!storage.ok) {
    return {
      available: false,
      source: "unavailable",
      state: null,
      f5dFolders: [],
      auditTail: [],
      warnings: [storage.error],
      summary: null,
    };
  }
  const stateObj = storage.values?.[FOLDER_STATE_DATA_KEY] || {};
  const state = stateObj && typeof stateObj === "object" && !Array.isArray(stateObj) ? stateObj : {};
  const folders = Array.isArray(state.folders) ? state.folders : [];
  const items = state.items && typeof state.items === "object" && !Array.isArray(state.items) ? state.items : {};
  const f5dFolders = folders.filter(settingsFolderCleanupIsF5DReviewCandidate).map((folder) => {
    const id = String(folder?.id || folder?.folderId || "").trim();
    const bucket = items[id];
    const bucketExists = Object.prototype.hasOwnProperty.call(items, id);
    return {
      folderId: id,
      id,
      name: settingsFolderDesktopNameOf(folder),
      raw: settingsFolderCleanupClone(folder),
      bucketExists,
      bucketIsArray: Array.isArray(bucket),
      bucketCount: Array.isArray(bucket) ? bucket.length : 0,
      bucket: Array.isArray(bucket) ? settingsFolderCleanupClone(bucket) : (bucket == null ? null : settingsFolderCleanupClone(bucket)),
    };
  }).filter((folder) => !!folder.folderId);
  const auditRaw = storage.values?.[FOLDER_CLEANUP_AUDIT_KEY];
  const auditTail = Array.isArray(auditRaw) ? auditRaw.slice(-10).map((entry) => ({
    timestamp: entry?.timestamp || "",
    action: entry?.action || "",
    surface: entry?.surface || "",
    result: entry?.result || "",
    selectedFolderIds: entry?.selectedFolderIds || entry?.selectedDuplicateFolderIds || [],
  })) : auditRaw;
  return {
    available: true,
    source: STUDIO_isTauri() ? "desktop-storage-shim" : "chrome.storage.local",
    state,
    f5dFolders,
    auditTail,
    warnings: [],
    summary: settingsFolderCleanupFolderStateSummary(state),
  };
}

function settingsFolderDesktopSurfaceBadges(candidate){
  const badges = [];
  if (candidate?.existsInDesktopSqlite) badges.push("Desktop SQLite");
  if (candidate?.existsInChromeMirror) badges.push("Chrome mirror");
  if (candidate?.surface === "cross-surface") badges.push("cross-surface");
  if (candidate?.bindingCount > 0) badges.push("bound");
  if (candidate?.orphanBindingCount > 0) badges.push("orphan");
  badges.push("review");
  return badges;
}

function settingsFolderDesktopBuildCandidate({ folderId, name, desktopFolder = null, chromeFolder = null, displayRow = null, desktopFacts = null }){
  const id = String(folderId || "").trim();
  const bindings = Array.isArray(desktopFacts?.bindingsByFolder?.[id]) ? desktopFacts.bindingsByFolder[id] : [];
  const knownChatRows = Array.isArray(desktopFacts?.knownRowsByFolder?.[id]) ? desktopFacts.knownRowsByFolder[id] : [];
  const dependencies = desktopFacts?.dependenciesByFolder?.[id] || {};
  const folderRows = Array.isArray(dependencies.folderRows) ? dependencies.folderRows : (desktopFolder ? [desktopFolder] : []);
  const chatsByFolder = Array.isArray(dependencies.chatsByFolder) ? dependencies.chatsByFolder : [];
  const snapshotsByChatId = Array.isArray(dependencies.snapshotsByChatId) ? dependencies.snapshotsByChatId : [];
  const libraryRows = Array.isArray(dependencies.libraryRows) ? dependencies.libraryRows : [];
  const dependencyCount = chatsByFolder.length + snapshotsByChatId.length + libraryRows.length;
  const orphanBindings = knownChatRows.filter((row) => row && row.known === false);
  const existsInDesktopSqlite = !!desktopFolder;
  const existsInChromeMirror = !!chromeFolder;
  const existsInNative = !!displayRow?.isCanonical;
  const bindingCount = bindings.length;
  const blockers = [];
  const warnings = [];
  if (id !== FOLDER_DESKTOP_FINAL_F5D_FOLDER_ID) blockers.push("P7d-d only targets f5d1-test-folder-b");
  if (existsInDesktopSqlite && folderRows.length !== 1) blockers.push(`Desktop folder row count is ${folderRows.length}`);
  if (existsInNative) blockers.push("native/canonical folder");
  if (bindingCount > 0) blockers.push("Desktop SQLite binding exists");
  if (orphanBindings.length > 0) blockers.push("binding does not resolve to a known chat row");
  if (chatsByFolder.length > 0) blockers.push("chat rows reference this folder");
  if (snapshotsByChatId.length > 0) blockers.push("snapshot rows reference this folder id");
  if (libraryRows.length > 0) blockers.push("LibraryIndex rows reference this folder");
  if (existsInChromeMirror) warnings.push("Also present in Chrome mirror; Desktop cleanup does not remove Chrome mirror rows.");
  if (!existsInDesktopSqlite && !existsInChromeMirror) blockers.push("folder not found in Desktop or Chrome facts");
  if (settingsFolderCleanupIsF5DReviewCandidate({ folderId: id, name })) {
    warnings.push("F5D/Desktop test folder. Desktop mutation requires P7d-b guards, typed confirmation, and audit.");
  }
  if (id === "f5d1-test-folder-b" && bindingCount > 0) {
    warnings.push("Known bound review candidate: f5d1-test-chat-001 has been observed on this folder.");
  }
  const surface = existsInDesktopSqlite && existsInChromeMirror
    ? "cross-surface"
    : (existsInDesktopSqlite ? "desktop" : "chrome-studio");
  const store = existsInDesktopSqlite ? "sqlite" : "chrome-storage";
  const className = bindingCount > 0
    ? "desktop-bound-review-candidate"
    : (existsInDesktopSqlite && existsInChromeMirror
      ? "cross-surface-candidate"
      : (existsInDesktopSqlite ? "desktop-empty-test-candidate" : "chrome-only-extra-candidate"));
  const futureEligible = !existsInNative
    && existsInDesktopSqlite
    && id === FOLDER_DESKTOP_FINAL_F5D_FOLDER_ID
    && folderRows.length === 1
    && bindingCount === 0
    && knownChatRows.length === 0
    && dependencyCount === 0;
  return {
    folderId: id,
    name: String(name || desktopFolder?.name || chromeFolder?.name || id).trim() || id,
    normalizedName: String(displayRow?.normalizedName || name || id).trim().toLowerCase(),
    classification: className,
    surface,
    store,
    storeBadges: settingsFolderDesktopSurfaceBadges({
      existsInDesktopSqlite,
      existsInChromeMirror,
      surface,
      bindingCount,
      orphanBindingCount: orphanBindings.length,
    }),
    existsInNative,
    existsInChromeMirror,
    existsInDesktopSqlite,
    bindingCount,
    bindings,
    knownChatRows,
    dependencyCount,
    folderRows,
    chatsByFolder,
    snapshotsByChatId,
    libraryRows,
    chromeBucket: chromeFolder ? {
      bucketExists: !!chromeFolder.bucketExists,
      bucketIsArray: !!chromeFolder.bucketIsArray,
      bucketCount: settingsFolderCleanupNumber(chromeFolder.bucketCount),
      bucket: chromeFolder.bucket,
    } : null,
    proposedAction: bindingCount > 0
      ? "Review exact binding before any future Desktop action."
      : "P7d-d Desktop deletion is allowed only for f5d1-test-folder-b after explicit preview, typed confirmation, fresh revalidation, and audit.",
    riskLevel: bindingCount > 0 || orphanBindings.length > 0 ? "high-review-required" : "review-required",
    requiresApproval: true,
    warnings,
    deletionEligible: false,
    futureDeletionEligible: futureEligible,
    blockers: Array.from(new Set([
      ...blockers,
      ...(futureEligible ? [] : ["not eligible for a future empty Desktop action until blockers are resolved"]),
    ].filter(Boolean))),
  };
}

function settingsFolderDesktopBuildReviewReport(selfCheck, displayModel, desktopFacts, chromeFacts){
  const displayRows = Array.isArray(displayModel?.rows) ? displayModel.rows : [];
  const displayById = new Map(displayRows.map((row) => [String(row?.folderId || row?.id || "").trim(), row]));
  const desktopById = new Map((Array.isArray(desktopFacts?.f5dFolders) ? desktopFacts.f5dFolders : []).map((folder) => [folder.folderId, folder]));
  const chromeById = new Map((Array.isArray(chromeFacts?.f5dFolders) ? chromeFacts.f5dFolders : []).map((folder) => [folder.folderId, folder]));
  const ids = Array.from(new Set([...desktopById.keys(), ...chromeById.keys()])).filter(Boolean).sort();
  const allCandidates = ids.map((id) => settingsFolderDesktopBuildCandidate({
    folderId: id,
    name: desktopById.get(id)?.name || chromeById.get(id)?.name || id,
    desktopFolder: desktopById.get(id) || null,
    chromeFolder: chromeById.get(id) || null,
    displayRow: displayById.get(id) || null,
    desktopFacts,
  }));
  const desktopCandidates = allCandidates.filter((row) => row.existsInDesktopSqlite);
  const chromeCandidates = allCandidates.filter((row) => row.existsInChromeMirror);
  const crossSurfaceCandidates = allCandidates.filter((row) => row.existsInDesktopSqlite && row.existsInChromeMirror);
  const boundReviewCandidates = allCandidates.filter((row) => row.bindingCount > 0);
  const orphanBindings = [];
  for (const candidate of allCandidates) {
    const rows = Array.isArray(candidate.knownChatRows) ? candidate.knownChatRows : [];
    for (const row of rows) {
      if (row && row.known === false) {
        orphanBindings.push({
          folderId: candidate.folderId,
          name: candidate.name,
          chatId: row.chatId,
          binding: `${row.chatId} -> ${row.folderId}`,
          surface: "desktop",
          store: "sqlite",
          riskLevel: "high-review-required",
          proposedAction: "Review orphan binding before any future folder action.",
          blockers: ["Binding exists in Desktop SQLite but no matching chat row was found."],
        });
      }
    }
  }
  return {
    readOnly: true,
    noMutation: true,
    generatedAt: new Date().toISOString(),
    surface: STUDIO_isTauri() ? "desktop-studio" : "chrome-studio",
    selfCheckSummary: selfCheck?.summary || null,
    desktopAvailable: !!desktopFacts?.available,
    chromeMirrorAvailable: !!chromeFacts?.available,
    desktopSource: desktopFacts?.source || "",
    chromeSource: chromeFacts?.source || "",
    counts: {
      desktopCandidates: desktopCandidates.length,
      chromeCandidates: chromeCandidates.length,
      crossSurface: crossSurfaceCandidates.length,
      boundReview: boundReviewCandidates.length,
      orphanBindings: orphanBindings.length,
    },
    desktopCandidates,
    chromeCandidates,
    crossSurfaceCandidates,
    boundReviewCandidates,
    orphanBindings,
    diagnostics: {
      desktopWarnings: desktopFacts?.warnings || [],
      chromeWarnings: chromeFacts?.warnings || [],
      desktopDiagnose: desktopFacts?.diagnose || null,
      desktopStoreMethods: desktopFacts?.storeMethods || [],
      desktopDeleteMethodsAvailable: desktopFacts?.deleteMethodsAvailable || [],
      chromeFolderStateSummary: chromeFacts?.summary || null,
      chromeAuditTail: chromeFacts?.auditTail || [],
    },
    safetyRules: [
      "Desktop review refresh is read-only.",
      "Desktop deletion is available only in the Delete Empty Desktop Folders subsection after preview, typed confirmation, fresh revalidation, and audit.",
      "No Chrome storage writes are performed.",
      "No native ChatGPT folder-state mutation is performed.",
      "Chrome and Desktop cleanup must remain separate future actions.",
      "Folders with bindings are never candidates for empty-folder cleanup.",
    ],
    futurePhases: [
      "P7d-c may later review bound test folder bindings.",
      "P7d-d may later compare Chrome/Desktop consistency after Desktop review.",
    ],
  };
}

function settingsFolderDesktopTargetOrphanBinding(){
  return {
    chatId: FOLDER_DESKTOP_ORPHAN_BINDING_CHAT_ID,
    folderId: FOLDER_DESKTOP_ORPHAN_BINDING_FOLDER_ID,
  };
}

function settingsFolderDesktopSqlOkRows(result){
  return result?.ok && Array.isArray(result.rows) ? result.rows : [];
}

function settingsFolderDesktopRegistryMatches(chatId){
  const id = String(chatId || "").trim();
  if (!id) return [];
  let rows = [];
  try { rows = W.H2O?.LibraryIndex?.getAll?.() || []; } catch { rows = []; }
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const values = [
      row?.chatId,
      row?.sourceId,
      row?.source_id,
      row?.id,
      row?.snapshotId,
      row?.href,
    ].map((value) => String(value || "").trim());
    return values.includes(id);
  }).slice(0, 8).map((row) => ({
    chatId: String(row?.chatId || "").trim(),
    sourceId: String(row?.sourceId || row?.source_id || "").trim(),
    snapshotId: String(row?.snapshotId || row?.id || "").trim(),
    title: String(row?.title || "").trim(),
    folderId: String(row?.folderId || row?.folder_id || "").trim(),
    view: String(row?.view || "").trim(),
  }));
}

async function settingsFolderDesktopLoadOrphanBindingReview(seed = null){
  const target = settingsFolderDesktopTargetOrphanBinding();
  const foldersStore = W.H2O?.Studio?.store?.folders;
  const storeMethods = Object.keys(foldersStore || {}).filter((key) => typeof foldersStore[key] === "function").sort();
  const selfCheck = seed?.selfCheck || (typeof W.H2O?.Library?.FolderParity?.selfCheck === "function"
    ? await promiseWithTimeout(W.H2O.Library.FolderParity.selfCheck({ fresh: true }), STUDIO_BOOT_AUX_TIMEOUT_MS, "FolderParity.selfCheck")
    : null);

  if (!STUDIO_isTauri()) {
    const review = {
      ...target,
      folderName: "",
      bindingExists: false,
      chatExistsById: false,
      chatExistsBySourceId: false,
      knownChatRows: [],
      folderExists: false,
      otherBindingsForFolder: [],
      classification: "not-eligible",
      classifications: ["not-eligible"],
      proposedAction: "Open Desktop Studio to review Desktop SQLite folder bindings.",
      riskLevel: "unavailable",
      requiresApproval: true,
      blockers: ["Desktop runtime required."],
      warnings: ["Review-only. No binding removed.", "Folder deletion is blocked until this binding is reviewed."],
    };
    return settingsFolderDesktopOrphanBindingReport(review, selfCheck, { storeMethods });
  }

  const [bindingResult, folderResult, chatByIdResult, chatBySourceIdResult, folderBindingsResult, chatBindingsResult] = await Promise.all([
    settingsFolderDesktopSqlSelect(
      "SELECT chat_id, folder_id, assigned_at FROM folder_bindings WHERE chat_id = ? AND folder_id = ? ORDER BY assigned_at DESC",
      [target.chatId, target.folderId]
    ),
    settingsFolderDesktopSqlSelect(
      "SELECT id, name, source, color, sort_order, created_at, updated_at, meta_json FROM folders WHERE id = ? LIMIT 1",
      [target.folderId]
    ),
    settingsFolderDesktopSqlSelect(
      "SELECT id, source_id, title, folder_id, is_saved, is_linked, href, normalized_href FROM chats WHERE id = ? LIMIT 1",
      [target.chatId]
    ),
    settingsFolderDesktopSqlSelect(
      "SELECT id, source_id, title, folder_id, is_saved, is_linked, href, normalized_href FROM chats WHERE source_id = ? LIMIT 1",
      [target.chatId]
    ),
    settingsFolderDesktopSqlSelect(
      "SELECT chat_id, folder_id, assigned_at FROM folder_bindings WHERE folder_id = ? ORDER BY assigned_at DESC",
      [target.folderId]
    ),
    settingsFolderDesktopSqlSelect(
      "SELECT chat_id, folder_id, assigned_at FROM folder_bindings WHERE chat_id = ? ORDER BY assigned_at DESC",
      [target.chatId]
    ),
  ]);
  let snapshotsResult = await settingsFolderDesktopSqlSelect(
    "SELECT * FROM snapshots WHERE chat_id = ? OR source_id = ? OR id = ? LIMIT 5",
    [target.chatId, target.chatId, target.chatId]
  );
  if (!snapshotsResult.ok) {
    snapshotsResult = await settingsFolderDesktopSqlSelect(
      "SELECT * FROM snapshots WHERE chat_id = ? LIMIT 5",
      [target.chatId]
    );
  }

  const bindingRows = settingsFolderDesktopSqlOkRows(bindingResult).map((row) => settingsFolderDesktopNormalizeBinding(row, target.folderId)).filter(Boolean);
  const folderRows = settingsFolderDesktopSqlOkRows(folderResult).map(settingsFolderDesktopNormalizeFolder).filter(Boolean);
  const chatByIdRows = settingsFolderDesktopSqlOkRows(chatByIdResult).map(settingsFolderDesktopNormalizeKnownChat).filter(Boolean);
  const chatBySourceIdRows = settingsFolderDesktopSqlOkRows(chatBySourceIdResult).map(settingsFolderDesktopNormalizeKnownChat).filter(Boolean);
  const snapshotRows = settingsFolderDesktopSqlOkRows(snapshotsResult).map((row) => ({
    id: String(row?.id || row?.snapshot_id || "").trim(),
    chatId: String(row?.chat_id || row?.chatId || "").trim(),
    sourceId: String(row?.source_id || row?.sourceId || "").trim(),
    title: String(row?.title || "").trim(),
  }));
  const registryRows = settingsFolderDesktopRegistryMatches(target.chatId);
  const otherBindings = settingsFolderDesktopSqlOkRows(folderBindingsResult)
    .map((row) => settingsFolderDesktopNormalizeBinding(row, target.folderId))
    .filter(Boolean);
  const chatBindings = settingsFolderDesktopSqlOkRows(chatBindingsResult)
    .map((row) => settingsFolderDesktopNormalizeBinding(row, target.folderId))
    .filter(Boolean);

  const bindingExists = bindingRows.length > 0;
  const folderExists = folderRows.length > 0;
  const chatExistsById = chatByIdRows.length > 0;
  const chatExistsBySourceId = chatBySourceIdRows.length > 0;
  const hasSnapshotOrRegistryMatch = snapshotRows.length > 0 || registryRows.length > 0;
  const knownChatRows = [
    ...chatByIdRows.map((row) => ({ source: "chats.id", known: true, chat: row })),
    ...chatBySourceIdRows.map((row) => ({ source: "chats.source_id", known: true, chat: row })),
    ...snapshotRows.map((row) => ({ source: "snapshots", known: true, chat: row })),
    ...registryRows.map((row) => ({ source: "LibraryIndex", known: true, chat: row })),
  ];
  const warnings = ["Review-only. No binding removed.", "Folder deletion is blocked until this binding is reviewed."];
  const blockers = [];
  const classifications = [];
  let classification = "not-eligible";
  let proposedAction = "No action available until the binding state can be trusted.";
  let riskLevel = "review-required";
  const sqlErrors = [bindingResult, folderResult, chatByIdResult, chatBySourceIdResult, folderBindingsResult, chatBindingsResult, snapshotsResult]
    .filter((result) => result && result.ok === false)
    .map((result) => result.error)
    .filter(Boolean);

  if (!bindingExists) {
    classification = "not-eligible";
    blockers.push("Target binding row was not found.");
  } else if (bindingRows.length !== 1) {
    classification = "ambiguous-binding";
    classifications.push(classification);
    blockers.push(`Target binding row count is ${bindingRows.length}.`);
    proposedAction = "Rerun review and do not remove until the exact binding is singular.";
  } else if (!folderExists) {
    classification = "orphan-binding-folder-missing";
    classifications.push(classification);
    riskLevel = "high-review-required";
    proposedAction = "Review the missing folder before any binding change.";
  } else if (chatExistsById || chatExistsBySourceId || hasSnapshotOrRegistryMatch) {
    classification = "valid-binding";
    classifications.push(classification);
    blockers.push("Chat resolves to an existing row or registry/snapshot match.");
    proposedAction = "Keep binding unless a future review proves it should move or be removed.";
  } else if (chatBindings.some((row) => String(row?.folderId || "").trim() !== target.folderId)) {
    classification = "ambiguous-binding";
    classifications.push(classification);
    blockers.push("Target chat has another folder binding.");
    proposedAction = "Do not remove until same-chat binding state is reviewed.";
  } else if (sqlErrors.length) {
    classification = "ambiguous-binding";
    classifications.push(classification);
    blockers.push("One or more read-only lookups failed.");
    proposedAction = "Rerun review after lookup errors are resolved.";
  } else {
    classification = "orphan-binding-chat-missing";
    classifications.push(classification);
    proposedAction = "Future P7d-c-b may remove only this exact binding after typed confirmation and audit.";
  }
  if (/f5d/i.test(`${target.chatId} ${target.folderId} ${folderRows[0]?.name || ""}`) && bindingExists && !knownChatRows.length) {
    classifications.push("test-binding-candidate");
    warnings.push("F5D/test binding candidate. Review before any removal.");
  }
  if (!classifications.length) classifications.push(classification);

  const review = {
    chatId: target.chatId,
    folderId: target.folderId,
    folderName: folderRows[0]?.name || target.folderId,
    bindingExists,
    chatExistsById,
    chatExistsBySourceId,
    knownChatRows,
    folderExists,
    otherBindingsForFolder: otherBindings,
    classification,
    classifications: Array.from(new Set(classifications)),
    proposedAction,
    riskLevel,
    requiresApproval: true,
    blockers: Array.from(new Set(blockers.filter(Boolean))),
    warnings: Array.from(new Set(warnings.filter(Boolean))),
    lookupResults: {
      exactBinding: { ok: !!bindingResult.ok, rows: bindingRows, error: bindingResult.error || "" },
      folder: { ok: !!folderResult.ok, rows: folderRows, error: folderResult.error || "" },
      chatsById: { ok: !!chatByIdResult.ok, rows: chatByIdRows, error: chatByIdResult.error || "" },
      chatsBySourceId: { ok: !!chatBySourceIdResult.ok, rows: chatBySourceIdRows, error: chatBySourceIdResult.error || "" },
      snapshots: { ok: !!snapshotsResult.ok, rows: snapshotRows, error: snapshotsResult.error || "" },
      registryRows,
      folderBindings: { ok: !!folderBindingsResult.ok, rows: otherBindings, error: folderBindingsResult.error || "" },
      chatBindings: { ok: !!chatBindingsResult.ok, rows: chatBindings, error: chatBindingsResult.error || "" },
    },
    storeApi: {
      storeMethods,
      hasUnbindChat: typeof foldersStore?.unbindChat === "function",
      futureMutationMethod: "H2O.Studio.store.folders.unbindChat(folderId, chatId)",
    },
  };
  return settingsFolderDesktopOrphanBindingReport(review, selfCheck, { storeMethods });
}

function settingsFolderDesktopOrphanBindingReport(review, selfCheck, extra = {}){
  return {
    readOnly: true,
    noMutation: true,
    generatedAt: new Date().toISOString(),
    surface: STUDIO_isTauri() ? "desktop-studio" : "chrome-studio",
    selfCheck: selfCheck || null,
    review,
    selfCheckSummary: selfCheck?.summary || null,
    diagnostics: {
      storeMethods: extra.storeMethods || [],
    },
    safetyRules: [
      "P7d-c-a is review-only.",
      "No Desktop SQLite writes are performed.",
      "No binding is removed.",
      "No folder is deleted.",
      "No Chrome storage, sync folder, or native folder-state mutation is performed.",
    ],
    futurePhases: [
      "P7d-c-b may later remove this exact orphan binding with typed confirmation and audit.",
      "P7d-d may later delete the now-empty folder after binding removal, as a separate action.",
    ],
  };
}

async function settingsFolderDesktopLoadReviewInputs(seed = null){
  const parity = W.H2O?.Library?.FolderParity;
  const selfCheck = seed?.selfCheck || (typeof parity?.selfCheck === "function" ? await promiseWithTimeout(parity.selfCheck({ fresh: true }), STUDIO_BOOT_AUX_TIMEOUT_MS, "FolderParity.selfCheck") : null);
  const displayModel = seed?.displayModel || (typeof parity?.getDisplayModel === "function" ? await promiseWithTimeout(parity.getDisplayModel({ fresh: true }), STUDIO_BOOT_AUX_TIMEOUT_MS, "FolderParity.getDisplayModel") : { rows: [], canonicalRows: [], localReviewRows: [] });
  const desktopFacts = await settingsFolderDesktopLoadFacts();
  const chromeFacts = await settingsFolderDesktopLoadChromeFacts();
  return {
    selfCheck,
    displayModel,
    desktopFacts,
    chromeFacts,
    report: settingsFolderDesktopBuildReviewReport(selfCheck, displayModel, desktopFacts, chromeFacts),
  };
}

function settingsFolderDesktopBindingHtml(candidate){
  const bindings = Array.isArray(candidate?.bindings) ? candidate.bindings : [];
  if (!bindings.length) return `<div style="font-size:12px;opacity:.72"><strong>Bindings:</strong> none</div>`;
  const knownRows = Array.isArray(candidate?.knownChatRows) ? candidate.knownChatRows : [];
  return `
    <div style="display:flex;flex-direction:column;gap:3px;font-size:12px">
      <strong>Bindings:</strong>
      ${bindings.map((binding) => {
        const known = knownRows.find((row) => row?.chatId === binding.chatId);
        const resolution = known?.known ? `known chat${known.chat?.title ? `: ${known.chat.title}` : ""}` : "no matching chat row";
        return `<span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace">${esc(binding.chatId)} -&gt; ${esc(binding.folderId)} <span style="opacity:.68">(${esc(resolution)})</span></span>`;
      }).join("")}
    </div>
  `;
}

function settingsFolderDesktopCandidateHtml(candidate){
  const blockers = Array.isArray(candidate?.blockers) ? candidate.blockers : [];
  const warnings = Array.isArray(candidate?.warnings) ? candidate.warnings : [];
  const chromeBucket = candidate?.chromeBucket;
  const bucketText = chromeBucket
    ? `${chromeBucket.bucketExists ? "present" : "missing"} · ${chromeBucket.bucketIsArray ? "array" : "not-array"} · ${chromeBucket.bucketCount || 0} item(s)`
    : "not present";
  const badges = Array.isArray(candidate?.storeBadges) ? candidate.storeBadges : [];
  return `
    <div style="border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.035);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <strong>${esc(candidate?.name || "(unnamed)")}</strong>
        <span>${settingsFolderCleanupBadgesHtml({ badges, classification: candidate?.classification })}</span>
      </div>
      <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;opacity:.72">${esc(candidate?.folderId || "(no folder id)")}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:4px 12px;font-size:12px">
        <span>surface ${esc(candidate?.surface || "unknown")}</span>
        <span>store ${esc(candidate?.store || "unknown")}</span>
        <span>Desktop ${candidate?.existsInDesktopSqlite ? "yes" : "no"}</span>
        <span>Chrome ${candidate?.existsInChromeMirror ? "yes" : "no"}</span>
        <span>native ${candidate?.existsInNative ? "yes" : "no"}</span>
        <span>bindings ${esc(candidate?.bindingCount || 0)}</span>
      </div>
      <div style="font-size:12px"><strong>Chrome bucket:</strong> ${esc(bucketText)}</div>
      ${settingsFolderDesktopBindingHtml(candidate)}
      <div style="font-size:12px"><strong>Review:</strong> ${esc(candidate?.proposedAction || "Review only.")}</div>
      <div style="font-size:12px"><strong>Risk:</strong> ${esc(candidate?.riskLevel || "review")}</div>
      <div style="font-size:12px"><strong>P7d-b empty-folder eligibility:</strong> ${candidate?.futureDeletionEligible ? "possible after guards" : "not eligible"}</div>
      ${warnings.length ? `<div style="font-size:12px;opacity:.78"><strong>Warnings:</strong> ${esc(warnings.join(" "))}</div>` : ""}
      ${blockers.length ? `<div style="font-size:12px;opacity:.78"><strong>Blockers:</strong> ${esc(blockers.join(" "))}</div>` : ""}
    </div>
  `;
}

function settingsFolderDesktopGroupHtml(title, candidates, emptyText){
  const rows = Array.isArray(candidates) ? candidates : [];
  return `
    <details open style="border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:8px;background:rgba(255,255,255,.025)">
      <summary style="cursor:pointer;font-weight:600">${esc(title)} <span style="opacity:.65">(${rows.length})</span></summary>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
        ${rows.length ? rows.map(settingsFolderDesktopCandidateHtml).join("") : `<div style="opacity:.65;font-size:12px">${esc(emptyText || "No candidates.")}</div>`}
      </div>
    </details>
  `;
}

function settingsFolderDesktopOrphanHtml(item){
  const blockers = Array.isArray(item?.blockers) ? item.blockers : [];
  return `
    <div style="border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.035);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px">
      <strong>${esc(item?.binding || "orphan binding")}</strong>
      <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;opacity:.72">${esc(item?.folderId || "")}</div>
      <div style="font-size:12px"><strong>Review:</strong> ${esc(item?.proposedAction || "Review only.")}</div>
      <div style="font-size:12px"><strong>Risk:</strong> ${esc(item?.riskLevel || "review")}</div>
      ${blockers.length ? `<div style="font-size:12px;opacity:.78"><strong>Blockers:</strong> ${esc(blockers.join(" "))}</div>` : ""}
    </div>
  `;
}

function settingsFolderDesktopOrphanBindingRow(label, value){
  return `<span style="display:flex;gap:6px;min-width:0"><strong>${esc(label)}:</strong> <span style="min-width:0;word-break:break-word">${esc(value)}</span></span>`;
}

function settingsFolderDesktopOrphanBindingRenderLookup(title, rows, emptyText){
  const list = Array.isArray(rows) ? rows : [];
  return `
    <details style="border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:8px;background:rgba(255,255,255,.025)">
      <summary style="cursor:pointer;font-weight:600">${esc(title)} <span style="opacity:.65">(${list.length})</span></summary>
      <div style="display:flex;flex-direction:column;gap:4px;margin-top:8px;font-size:12px">
        ${list.length ? list.map((row) => `<code style="white-space:pre-wrap;word-break:break-word">${esc(JSON.stringify(row))}</code>`).join("") : `<span style="opacity:.65">${esc(emptyText || "No rows.")}</span>`}
      </div>
    </details>
  `;
}

function settingsFolderDesktopOrphanBindingRemovalBlockers(report){
  const target = settingsFolderDesktopTargetOrphanBinding();
  const review = report?.review || {};
  const lookups = review.lookupResults || {};
  const exactRows = Array.isArray(lookups.exactBinding?.rows) ? lookups.exactBinding.rows : [];
  const folderRows = Array.isArray(lookups.folder?.rows) ? lookups.folder.rows : [];
  const snapshotRows = Array.isArray(lookups.snapshots?.rows) ? lookups.snapshots.rows : [];
  const registryRows = Array.isArray(lookups.registryRows) ? lookups.registryRows : [];
  const chatBindings = Array.isArray(lookups.chatBindings?.rows) ? lookups.chatBindings.rows : [];
  const knownRows = Array.isArray(review.knownChatRows) ? review.knownChatRows : [];
  const blockers = [];
  if (!STUDIO_isTauri()) blockers.push("Desktop runtime required.");
  if (!review.storeApi?.hasUnbindChat) blockers.push("H2O.Studio.store.folders.unbindChat unavailable.");
  if (String(review.chatId || "") !== target.chatId || String(review.folderId || "") !== target.folderId) blockers.push("review target does not match exact binding.");
  if (exactRows.length !== 1) blockers.push(`exact binding row count is ${exactRows.length}.`);
  if (folderRows.length !== 1) blockers.push(`folder row count is ${folderRows.length}.`);
  if (review.chatExistsById) blockers.push("chat resolves by chats.id.");
  if (review.chatExistsBySourceId) blockers.push("chat resolves by chats.source_id.");
  if (snapshotRows.length) blockers.push("chat resolves in snapshots.");
  if (registryRows.length) blockers.push("chat resolves in LibraryIndex.");
  if (knownRows.some((row) => row && row.known)) blockers.push("known chat row exists.");
  if (!/f5d/i.test(`${review.chatId || ""} ${review.folderId || ""} ${review.folderName || ""}`)) blockers.push("target is not an F5D/test binding.");
  if (chatBindings.some((row) => String(row?.folderId || "").trim() !== target.folderId)) blockers.push("same chat has another folder binding.");
  if (review.classification !== "orphan-binding-chat-missing") blockers.push(`classification is ${review.classification || "unknown"}.`);
  return Array.from(new Set(blockers.filter(Boolean)));
}

function settingsFolderDesktopOrphanBindingTargetSelection(){
  return {
    chatId: FOLDER_DESKTOP_ORPHAN_BINDING_CHAT_ID,
    folderId: FOLDER_DESKTOP_ORPHAN_BINDING_FOLDER_ID,
  };
}

function settingsFolderDesktopOrphanBindingSelected(panel){
  const box = panel?.querySelector?.("#wbSettingsFolderDesktopOrphanBindingRemoveList input[data-chat-id][data-folder-id]");
  if (box) {
    if (!box.checked) return null;
    return {
      chatId: String(box.dataset.chatId || "").trim(),
      folderId: String(box.dataset.folderId || "").trim(),
    };
  }
  return FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.selected
    ? settingsFolderDesktopOrphanBindingTargetSelection()
    : null;
}

function settingsFolderDesktopOrphanBindingRemovalRowHtml(report){
  const target = settingsFolderDesktopTargetOrphanBinding();
  const review = report?.review || {};
  const blockers = settingsFolderDesktopOrphanBindingRemovalBlockers(report);
  const eligible = blockers.length === 0;
  const checked = eligible && !!FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.selected;
  const badges = settingsFolderCleanupBadgesHtml({ badges: ["Desktop SQLite", "orphan", "review"], classification: eligible ? "orphan-removal-eligible" : "review-required" });
  return `
    <label style="display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:flex-start;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.035);border-radius:8px;padding:8px">
      <input type="checkbox" data-chat-id="${esc(target.chatId)}" data-folder-id="${esc(target.folderId)}" ${checked ? "checked" : ""} ${eligible ? "" : "disabled"} />
      <span style="display:flex;flex-direction:column;gap:4px;min-width:0">
        <span style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <strong>${esc(target.chatId)} -&gt; ${esc(target.folderId)}</strong>
          <span>${badges}</span>
        </span>
        <span style="font-size:12px;opacity:.78">Folder: ${esc(review.folderName || target.folderId)}</span>
        <span style="font-size:12px;opacity:.72">Target API: <code>H2O.Studio.store.folders.unbindChat("${esc(target.folderId)}", "${esc(target.chatId)}")</code></span>
        ${blockers.length ? `<span style="font-size:12px;opacity:.78"><strong>Blocked:</strong> ${esc(blockers.join(" "))}</span>` : `<span style="font-size:12px;opacity:.78">Eligible only for exact binding removal. The folder row is not modified.</span>`}
      </span>
    </label>
  `;
}

function settingsFolderDesktopRenderOrphanBindingRemovalPanel(panel, report){
  const summary = panel?.querySelector("#wbSettingsFolderDesktopOrphanBindingRemoveSummary");
  const list = panel?.querySelector("#wbSettingsFolderDesktopOrphanBindingRemoveList");
  const previewEl = panel?.querySelector("#wbSettingsFolderDesktopOrphanBindingRemovePreview");
  const confirmInput = panel?.querySelector("#wbSettingsFolderDesktopOrphanBindingRemoveConfirm");
  const blockers = settingsFolderDesktopOrphanBindingRemovalBlockers(report);
  const eligible = blockers.length === 0;
  if (!eligible) {
    FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.preview = null;
  }
  if (summary) {
    const status = FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.status ? ` ${FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.status}` : "";
    summary.textContent = STUDIO_isTauri()
      ? (blockers.length
        ? `Desktop SQLite binding only. Removal blocked: ${blockers.join(" ")}${status}`
        : `Desktop SQLite binding only. Exact orphan binding is selectable. The folder row, Chrome mirror, native folder-state, and sync folder are not modified.${status}`)
      : "Orphan binding removal is only available in Desktop Studio.";
  }
  if (list) list.innerHTML = settingsFolderDesktopOrphanBindingRemovalRowHtml(report);
  if (confirmInput && confirmInput.value !== FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.confirmation) {
    confirmInput.value = FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.confirmation;
  }
  panel.__h2oFolderDesktopOrphanBindingRemovalPreview = eligible ? FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.preview : null;
  if (previewEl) {
    if (panel.__h2oFolderDesktopOrphanBindingRemovalPreview) {
      previewEl.hidden = false;
      previewEl.textContent = JSON.stringify(panel.__h2oFolderDesktopOrphanBindingRemovalPreview, null, 2);
    } else {
      previewEl.hidden = true;
      previewEl.textContent = "";
    }
  }
  settingsFolderDesktopUpdateOrphanBindingRemovalControls(panel);
}

function settingsFolderDesktopValidateOrphanBindingRemovalSelection(selected, report){
  const target = settingsFolderDesktopTargetOrphanBinding();
  const binding = selected && typeof selected === "object" ? {
    chatId: String(selected.chatId || "").trim(),
    folderId: String(selected.folderId || "").trim(),
  } : null;
  if (!binding) return { ok: false, error: "Select the exact orphan Desktop binding.", selectedBindings: [] };
  if (binding.chatId !== target.chatId || binding.folderId !== target.folderId) {
    return { ok: false, error: "Selected binding does not match the exact P7d-c-b target.", selectedBindings: [binding] };
  }
  const blockers = settingsFolderDesktopOrphanBindingRemovalBlockers(report);
  if (blockers.length) return { ok: false, error: `Selected binding failed removal guards: ${blockers.join("; ")}`, selectedBindings: [binding] };
  return { ok: true, selectedBindings: [binding], review: report?.review || null };
}

function settingsFolderDesktopBuildOrphanBindingRemovalPreview(selected, report){
  const validation = settingsFolderDesktopValidateOrphanBindingRemovalSelection(selected, report);
  if (!validation.ok) return { ok: false, error: validation.error, selectedBindings: validation.selectedBindings || [] };
  const review = validation.review || {};
  const lookups = review.lookupResults || {};
  const folderBindings = Array.isArray(lookups.folderBindings?.rows) ? lookups.folderBindings.rows : [];
  return {
    ok: true,
    readOnly: false,
    noMutation: true,
    mutation: "preview-only",
    generatedAt: new Date().toISOString(),
    surface: "desktop-studio",
    action: "remove-orphan-desktop-folder-binding",
    selectedBindings: validation.selectedBindings,
    folderRow: settingsFolderCleanupClone((lookups.folder?.rows || [])[0] || null),
    exactBindingRows: settingsFolderCleanupClone(lookups.exactBinding?.rows || []),
    chatLookupResults: {
      chatsById: settingsFolderCleanupClone(lookups.chatsById?.rows || []),
      chatsBySourceId: settingsFolderCleanupClone(lookups.chatsBySourceId?.rows || []),
      snapshots: settingsFolderCleanupClone(lookups.snapshots?.rows || []),
      libraryIndex: settingsFolderCleanupClone(lookups.registryRows || []),
    },
    beforeBindingCountForFolder: folderBindings.length,
    predictedAfterBindingCountForFolder: Math.max(0, folderBindings.length - 1),
    targetApi: `H2O.Studio.store.folders.unbindChat("${FOLDER_DESKTOP_ORPHAN_BINDING_FOLDER_ID}", "${FOLDER_DESKTOP_ORPHAN_BINDING_CHAT_ID}")`,
    confirmationText: FOLDER_DESKTOP_ORPHAN_BINDING_CONFIRM_TEXT,
    folderRowNote: "The folder row is not deleted in P7d-c-b.",
    chromeMirrorNote: "Chrome mirror cleanup is separate and not performed.",
    nativeStateNote: "Native ChatGPT folder-state is not modified.",
  };
}

function settingsFolderDesktopResolveUnbindMethod(){
  const foldersStore = W.H2O?.Studio?.store?.folders;
  if (typeof foldersStore?.unbindChat === "function") return { method: "unbindChat", fn: foldersStore.unbindChat.bind(foldersStore) };
  return { method: "", fn: null };
}

function settingsFolderDesktopUpdateOrphanBindingRemovalControls(panel){
  const operatorMode = folderOperatorModeEnabled();
  const selected = settingsFolderDesktopOrphanBindingSelected(panel);
  FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.selected = !!selected;
  panel.__h2oFolderDesktopOrphanBindingSelected = selected;
  const preview = FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.preview || panel?.__h2oFolderDesktopOrphanBindingRemovalPreview;
  const previewBtn = panel?.querySelector("#wbSettingsFolderDesktopOrphanBindingPreviewRemove");
  const copyBtn = panel?.querySelector("#wbSettingsFolderDesktopOrphanBindingCopyRemovePlan");
  const confirmInput = panel?.querySelector("#wbSettingsFolderDesktopOrphanBindingRemoveConfirm");
  const removeBtn = panel?.querySelector("#wbSettingsFolderDesktopOrphanBindingRemoveSelected");
  if (confirmInput && confirmInput.value !== FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.confirmation) {
    confirmInput.value = FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.confirmation;
  }
  const confirmationOk = FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.confirmation === FOLDER_DESKTOP_ORPHAN_BINDING_CONFIRM_TEXT;
  const selectedMatchesPreview = !!preview?.ok
    && !!selected
    && (preview.selectedBindings || []).length === 1
    && preview.selectedBindings[0]?.chatId === selected.chatId
    && preview.selectedBindings[0]?.folderId === selected.folderId;
  if (previewBtn) previewBtn.disabled = !operatorMode || !STUDIO_isTauri() || !selected;
  if (copyBtn) copyBtn.disabled = !operatorMode || !preview?.ok;
  if (removeBtn) removeBtn.disabled = !operatorMode || !STUDIO_isTauri() || !selectedMatchesPreview || !confirmationOk;
}

function settingsFolderDesktopRenderOrphanBindingReport(panel, report){
  const summary = panel?.querySelector("#wbSettingsFolderDesktopOrphanBindingSummary");
  const body = panel?.querySelector("#wbSettingsFolderDesktopOrphanBindingBody");
  const copyBtn = panel?.querySelector("#wbSettingsFolderDesktopOrphanBindingCopy");
  const review = report?.review || {};
  if (summary) {
    const classes = Array.isArray(review.classifications) && review.classifications.length
      ? review.classifications.join(", ")
      : (review.classification || "unknown");
    summary.textContent = `Review-only. No binding removed. Classification: ${classes}.`;
  }
  if (body) {
    const lookups = review.lookupResults || {};
    const blockers = Array.isArray(review.blockers) ? review.blockers : [];
    const warnings = Array.isArray(review.warnings) ? review.warnings : [];
    body.innerHTML = `
      <div style="border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.035);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <strong>${esc(review.chatId || FOLDER_DESKTOP_ORPHAN_BINDING_CHAT_ID)} -&gt; ${esc(review.folderId || FOLDER_DESKTOP_ORPHAN_BINDING_FOLDER_ID)}</strong>
          <span>${settingsFolderCleanupBadgesHtml({ badges: ["Desktop SQLite", "orphan", "review"], classification: review.classification || "review" })}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:5px 12px;font-size:12px">
          ${settingsFolderDesktopOrphanBindingRow("folder", `${review.folderName || ""} (${review.folderId || ""})`)}
          ${settingsFolderDesktopOrphanBindingRow("binding exists", review.bindingExists ? "yes" : "no")}
          ${settingsFolderDesktopOrphanBindingRow("folder exists", review.folderExists ? "yes" : "no")}
          ${settingsFolderDesktopOrphanBindingRow("chat by id", review.chatExistsById ? "found" : "missing")}
          ${settingsFolderDesktopOrphanBindingRow("chat by source_id", review.chatExistsBySourceId ? "found" : "missing")}
          ${settingsFolderDesktopOrphanBindingRow("other folder bindings", String((review.otherBindingsForFolder || []).length))}
          ${settingsFolderDesktopOrphanBindingRow("risk", review.riskLevel || "review")}
          ${settingsFolderDesktopOrphanBindingRow("future API", review.storeApi?.hasUnbindChat ? review.storeApi.futureMutationMethod : "unbindChat unavailable")}
        </div>
        <div style="font-size:12px"><strong>Proposed future action:</strong> ${esc(review.proposedAction || "Review only.")}</div>
        ${warnings.length ? `<div style="font-size:12px;opacity:.78"><strong>Warnings:</strong> ${esc(warnings.join(" "))}</div>` : ""}
        ${blockers.length ? `<div style="font-size:12px;opacity:.78"><strong>Blockers:</strong> ${esc(blockers.join(" "))}</div>` : ""}
        <div style="font-size:12px;opacity:.72">P7d-c-b may later remove this exact binding with typed confirmation and audit. P7d-c-a does not call unbindChat.</div>
      </div>
      ${settingsFolderDesktopOrphanBindingRenderLookup("Exact binding row", lookups.exactBinding?.rows, "Binding row not found.")}
      ${settingsFolderDesktopOrphanBindingRenderLookup("Folder row", lookups.folder?.rows, "Folder row not found.")}
      ${settingsFolderDesktopOrphanBindingRenderLookup("Chat lookup by id", lookups.chatsById?.rows, "No chats.id match.")}
      ${settingsFolderDesktopOrphanBindingRenderLookup("Chat lookup by source_id", lookups.chatsBySourceId?.rows, "No chats.source_id match.")}
      ${settingsFolderDesktopOrphanBindingRenderLookup("Snapshot lookup", lookups.snapshots?.rows, "No snapshot rows found or snapshots unavailable.")}
      ${settingsFolderDesktopOrphanBindingRenderLookup("LibraryIndex lookup", lookups.registryRows, "No LibraryIndex rows found.")}
      ${settingsFolderDesktopOrphanBindingRenderLookup("All bindings for folder", lookups.folderBindings?.rows, "No folder bindings found.")}
      ${settingsFolderDesktopOrphanBindingRenderLookup("All bindings for chat", lookups.chatBindings?.rows, "No chat bindings found.")}
    `;
  }
  if (copyBtn) copyBtn.disabled = false;
  settingsFolderDesktopRenderOrphanBindingRemovalPanel(panel, report);
}

function settingsFolderDesktopRenderReport(panel, report){
  const summary = panel?.querySelector("#wbSettingsFolderDesktopReviewSummary");
  const chips = panel?.querySelector("#wbSettingsFolderDesktopReviewChips");
  const groups = panel?.querySelector("#wbSettingsFolderDesktopReviewGroups");
  const copyBtn = panel?.querySelector("#wbSettingsFolderDesktopReviewCopy");
  if (summary) {
    summary.textContent = `Review-only. Desktop ${report?.desktopAvailable ? "available" : "unavailable"} · Chrome mirror ${report?.chromeMirrorAvailable ? "available" : "unavailable"}. No Desktop cleanup performed.`;
  }
  if (chips) {
    chips.innerHTML = [
      settingsFolderCleanupChip("Desktop F5D", report?.counts?.desktopCandidates || 0),
      settingsFolderCleanupChip("Chrome F5D", report?.counts?.chromeCandidates || 0),
      settingsFolderCleanupChip("cross-surface", report?.counts?.crossSurface || 0),
      settingsFolderCleanupChip("bound review", report?.counts?.boundReview || 0),
      settingsFolderCleanupChip("orphan bindings", report?.counts?.orphanBindings || 0),
    ].join("");
  }
  if (groups) {
    const diagnostics = report?.diagnostics || {};
    const warnings = [...(diagnostics.desktopWarnings || []), ...(diagnostics.chromeWarnings || [])].filter(Boolean);
    groups.innerHTML = [
      warnings.length ? `<div style="font-size:12px;opacity:.78"><strong>Read warnings:</strong> ${esc(warnings.join(" "))}</div>` : "",
      settingsFolderDesktopGroupHtml("Desktop F5D candidates", report?.desktopCandidates, "No Desktop F5D candidates detected on this surface."),
      settingsFolderDesktopGroupHtml("Chrome mirror F5D candidates", report?.chromeCandidates, "No Chrome mirror F5D candidates detected."),
      settingsFolderDesktopGroupHtml("Cross-surface candidates", report?.crossSurfaceCandidates, "No F5D folders are present in both Desktop and Chrome mirror facts."),
      settingsFolderDesktopGroupHtml("Bound review candidates", report?.boundReviewCandidates, "No bound F5D review candidates detected."),
      `
        <details open style="border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:8px;background:rgba(255,255,255,.025)">
          <summary style="cursor:pointer;font-weight:600">Orphan bindings <span style="opacity:.65">(${(report?.orphanBindings || []).length})</span></summary>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
            ${(report?.orphanBindings || []).length
              ? report.orphanBindings.map(settingsFolderDesktopOrphanHtml).join("")
              : `<div style="opacity:.65;font-size:12px">No F5D orphan bindings detected.</div>`}
          </div>
        </details>
      `,
    ].join("");
  }
  if (copyBtn) copyBtn.disabled = false;
  settingsFolderDesktopRenderDeletePanel(panel, report);
}

function settingsFolderDesktopDeleteBlockers(candidate){
  const folderId = String(candidate?.folderId || "").trim();
  const blockers = [];
  const knownChatRows = Array.isArray(candidate?.knownChatRows) ? candidate.knownChatRows : [];
  const folderRows = Array.isArray(candidate?.folderRows) ? candidate.folderRows : [];
  const chatsByFolder = Array.isArray(candidate?.chatsByFolder) ? candidate.chatsByFolder : [];
  const snapshotsByChatId = Array.isArray(candidate?.snapshotsByChatId) ? candidate.snapshotsByChatId : [];
  const libraryRows = Array.isArray(candidate?.libraryRows) ? candidate.libraryRows : [];
  if (!STUDIO_isTauri()) blockers.push("Desktop runtime required.");
  if (!folderId) blockers.push("missing folder ID");
  if (folderId !== FOLDER_DESKTOP_FINAL_F5D_FOLDER_ID) blockers.push("P7d-d only allows f5d1-test-folder-b");
  if (!candidate?.existsInDesktopSqlite) blockers.push("not present in Desktop SQLite");
  if (!settingsFolderCleanupIsF5DReviewCandidate(candidate)) blockers.push("not in Desktop/F5D review set");
  if (/^f_/.test(folderId)) blockers.push("canonical native folder ID prefix");
  if (candidate?.existsInNative) blockers.push("native-present folder");
  if (folderRows.length !== 1) blockers.push(`Desktop folder row count is ${folderRows.length}`);
  if (settingsFolderCleanupNumber(candidate?.bindingCount) !== 0) blockers.push("Desktop SQLite bindings exist");
  if (knownChatRows.some((row) => row && row.known)) blockers.push("known chat row depends on this folder");
  if (chatsByFolder.length > 0) blockers.push("chats.folder_id references this folder");
  if (snapshotsByChatId.length > 0) blockers.push("snapshots.chat_id references this folder id");
  if (libraryRows.length > 0) blockers.push("LibraryIndex references this folder");
  const remove = settingsFolderDesktopResolveRemoveMethod();
  if (typeof remove.fn !== "function") blockers.push("Desktop folder remove API unavailable");
  if (folderId === FOLDER_DESKTOP_FINAL_F5D_FOLDER_ID && settingsFolderCleanupNumber(candidate?.bindingCount) > 0) {
    blockers.push("known bound F5D review folder");
  }
  return Array.from(new Set(blockers.filter(Boolean)));
}

function settingsFolderDesktopEligibleDeleteRows(report){
  const rows = Array.isArray(report?.desktopCandidates) ? report.desktopCandidates : [];
  return rows.filter((candidate) => settingsFolderDesktopDeleteBlockers(candidate).length === 0);
}

function settingsFolderDesktopSelectedDeleteIds(panel){
  const boxes = Array.from(panel?.querySelectorAll?.("#wbSettingsFolderDesktopDeleteList input[data-folder-id]") || []);
  return boxes
    .filter((box) => !!box.checked)
    .map((box) => String(box.dataset.folderId || "").trim())
    .filter(Boolean);
}

function settingsFolderDesktopDeleteRowHtml(candidate){
  const badges = settingsFolderCleanupBadgesHtml({
    badges: candidate?.storeBadges || ["Desktop SQLite"],
    classification: "desktop-empty-delete-eligible",
  });
  const chromeNote = candidate?.existsInChromeMirror
    ? "Chrome mirror row also exists; Chrome cleanup is separate and not performed."
    : "No Chrome mirror row detected.";
  return `
    <label style="display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:flex-start;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.035);border-radius:8px;padding:8px">
      <input type="checkbox" data-folder-id="${esc(candidate?.folderId || "")}" />
      <span style="display:flex;flex-direction:column;gap:4px;min-width:0">
        <span style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <strong>${esc(candidate?.name || "(unnamed)")}</strong>
          <span>${badges}</span>
        </span>
        <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;opacity:.72">${esc(candidate?.folderId || "")}</span>
        <span style="font-size:12px;opacity:.78">Desktop bindings ${esc(candidate?.bindingCount || 0)} · chat rows ${(candidate?.chatsByFolder || []).length} · snapshots ${(candidate?.snapshotsByChatId || []).length} · LibraryIndex ${(candidate?.libraryRows || []).length}</span>
        <span style="font-size:12px;opacity:.78">native ${candidate?.existsInNative ? "yes" : "no"} · folder rows ${(candidate?.folderRows || []).length}</span>
        <span style="font-size:12px;opacity:.72">${esc(chromeNote)}</span>
      </span>
    </label>
  `;
}

function settingsFolderDesktopRenderDeletePanel(panel, report){
  const summary = panel?.querySelector("#wbSettingsFolderDesktopDeleteSummary");
  const list = panel?.querySelector("#wbSettingsFolderDesktopDeleteList");
  const previewEl = panel?.querySelector("#wbSettingsFolderDesktopDeletePreview");
  const eligible = settingsFolderDesktopEligibleDeleteRows(report);
  if (summary) {
    summary.textContent = STUDIO_isTauri()
      ? `Desktop SQLite only. ${eligible.length} final F5D folder(s) selectable. Chrome mirror, native folder-state, and sync folder are not modified.`
      : "Desktop empty folder cleanup is only available in Desktop Studio. Chrome mirror cleanup is separate and not performed.";
  }
  if (list) {
    list.innerHTML = eligible.length
      ? eligible.map(settingsFolderDesktopDeleteRowHtml).join("")
      : `<div style="opacity:.65;font-size:12px">${STUDIO_isTauri() ? "No zero-binding Desktop F5D folders are eligible for deletion." : "Unavailable outside Desktop Studio."}</div>`;
  }
  if (previewEl && !panel?.__h2oFolderDesktopDeletionPreview) {
    previewEl.hidden = true;
    previewEl.textContent = "";
  }
  settingsFolderDesktopUpdateDeleteControls(panel);
}

function settingsFolderDesktopValidateDeleteSelection(selectedIds, report){
  const ids = Array.from(new Set((Array.isArray(selectedIds) ? selectedIds : []).map((id) => String(id || "").trim()).filter(Boolean)));
  if (!STUDIO_isTauri()) return { ok: false, error: "Desktop folder cleanup is only available in Desktop Studio.", selectedFolderIds: ids, candidates: [] };
  if (!ids.length) return { ok: false, error: "Select f5d1-test-folder-b.", selectedFolderIds: ids, candidates: [] };
  if (ids.length !== 1 || ids[0] !== FOLDER_DESKTOP_FINAL_F5D_FOLDER_ID) {
    return { ok: false, error: "P7d-d can delete only f5d1-test-folder-b.", selectedFolderIds: ids, candidates: [] };
  }
  const eligibleById = new Map(settingsFolderDesktopEligibleDeleteRows(report).map((row) => [String(row.folderId || "").trim(), row]));
  const candidates = [];
  for (const folderId of ids) {
    const candidate = eligibleById.get(folderId);
    if (!candidate) return { ok: false, error: `${folderId} is not currently eligible for Desktop empty-folder deletion.`, selectedFolderIds: ids, candidates };
    const blockers = settingsFolderDesktopDeleteBlockers(candidate);
    if (blockers.length) return { ok: false, error: `${folderId} failed Desktop deletion guards: ${blockers.join("; ")}`, selectedFolderIds: ids, candidates };
    candidates.push({
      folderId,
      name: candidate.name,
      bindingCount: settingsFolderCleanupNumber(candidate.bindingCount),
      knownChatRows: settingsFolderCleanupClone(candidate.knownChatRows || []),
      nativePresence: !!candidate.existsInNative,
      existsInChromeMirror: !!candidate.existsInChromeMirror,
      folderRows: settingsFolderCleanupClone(candidate.folderRows || []),
      chatsByFolder: settingsFolderCleanupClone(candidate.chatsByFolder || []),
      snapshotsByChatId: settingsFolderCleanupClone(candidate.snapshotsByChatId || []),
      libraryRows: settingsFolderCleanupClone(candidate.libraryRows || []),
      riskLevel: "low-review-required",
      eligibilityReason: "f5d1-test-folder-b exists exactly once, has zero SQLite bindings, no chat/snapshot/LibraryIndex dependencies, and is native-absent.",
    });
  }
  return { ok: true, selectedFolderIds: ids, candidates };
}

function settingsFolderDesktopSummaryFromFacts(facts){
  const folders = Array.isArray(facts?.folders) ? facts.folders : [];
  const f5dFolders = Array.isArray(facts?.f5dFolders) ? facts.f5dFolders : [];
  const bindingsByFolder = facts?.bindingsByFolder && typeof facts.bindingsByFolder === "object" ? facts.bindingsByFolder : {};
  const bindingCount = Object.values(bindingsByFolder).reduce((sum, values) => sum + (Array.isArray(values) ? values.length : 0), 0);
  return {
    surface: facts?.surface || (STUDIO_isTauri() ? "desktop-studio" : "chrome-studio"),
    source: facts?.source || "",
    folderCount: folders.length,
    f5dFolderCount: f5dFolders.length,
    f5dBindingCount: bindingCount,
  };
}

function settingsFolderDesktopBuildDeletePreview(selectedIds, loaded){
  const validation = settingsFolderDesktopValidateDeleteSelection(selectedIds, loaded?.report);
  if (!validation.ok) return { ok: false, error: validation.error, selectedFolderIds: validation.selectedFolderIds || [] };
  const beforeSummary = settingsFolderDesktopSummaryFromFacts(loaded?.desktopFacts);
  const remove = settingsFolderDesktopResolveRemoveMethod();
  return {
    ok: true,
    readOnly: false,
    noMutation: true,
    mutation: "preview-only",
    generatedAt: new Date().toISOString(),
    surface: "desktop-studio",
    action: "delete-empty-desktop-folders",
    targetStore: "Desktop SQLite",
    targetApi: remove.method
      ? `H2O.Studio.store.folders.${remove.method}("${FOLDER_DESKTOP_FINAL_F5D_FOLDER_ID}")`
      : `H2O.Studio.store.folders.remove("${FOLDER_DESKTOP_FINAL_F5D_FOLDER_ID}")`,
    selectedFolderIds: validation.selectedFolderIds,
    selectedFolders: validation.candidates,
    targetFolder: validation.candidates[0] || null,
    folderRow: validation.candidates[0]?.folderRows?.[0] || null,
    bindingCount: settingsFolderCleanupNumber(validation.candidates[0]?.bindingCount),
    chatDependencyCount: (validation.candidates[0]?.chatsByFolder || []).length,
    snapshotDependencyCount: (validation.candidates[0]?.snapshotsByChatId || []).length,
    libraryIndexDependencyCount: (validation.candidates[0]?.libraryRows || []).length,
    beforeDesktopFolderCount: beforeSummary.folderCount,
    predictedAfterDesktopFolderCount: Math.max(0, beforeSummary.folderCount - validation.selectedFolderIds.length),
    beforeDesktopFoldersSummary: beforeSummary,
    confirmationText: FOLDER_DESKTOP_CLEANUP_CONFIRM_TEXT,
    chromeMirrorNote: "Chrome mirror cleanup is separate and not performed.",
    nativeStateNote: "Native ChatGPT folder-state is not modified.",
  };
}

function settingsFolderDesktopStorageGetStrict(keys){
  if (!STUDIO_isTauri()) return Promise.reject(new Error("Desktop cleanup audit is available only in Desktop Studio."));
  if (!hasChromeStorage()) return Promise.reject(new Error("Desktop storage shim unavailable for cleanup audit."));
  return new Promise((resolve, reject) => {
    try {
      W.chrome.storage.local.get(keys, (result) => {
        const lastError = W.chrome?.runtime?.lastError;
        if (lastError) { reject(new Error(String(lastError.message || lastError))); return; }
        resolve(result || {});
      });
    } catch (err) {
      reject(err);
    }
  });
}

function settingsFolderDesktopStorageSetStrict(obj){
  if (!STUDIO_isTauri()) return Promise.reject(new Error("Desktop cleanup audit is available only in Desktop Studio."));
  if (!hasChromeStorage()) return Promise.reject(new Error("Desktop storage shim unavailable for cleanup audit."));
  return new Promise((resolve, reject) => {
    try {
      W.chrome.storage.local.set(obj || {}, () => {
        const lastError = W.chrome?.runtime?.lastError;
        if (lastError) { reject(new Error(String(lastError.message || lastError))); return; }
        resolve(true);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function settingsFolderDesktopAppendAudit(entry){
  const values = await settingsFolderDesktopStorageGetStrict([FOLDER_CLEANUP_AUDIT_KEY]);
  const existing = Array.isArray(values?.[FOLDER_CLEANUP_AUDIT_KEY]) ? values[FOLDER_CLEANUP_AUDIT_KEY] : [];
  const next = existing.concat([entry]).slice(-50);
  await settingsFolderDesktopStorageSetStrict({ [FOLDER_CLEANUP_AUDIT_KEY]: next });
  return next.length;
}

function settingsFolderDesktopResolveRemoveMethod(){
  const foldersStore = W.H2O?.Studio?.store?.folders;
  if (typeof foldersStore?.remove === "function") return { method: "remove", fn: foldersStore.remove.bind(foldersStore) };
  if (typeof foldersStore?.delete === "function") return { method: "delete", fn: foldersStore.delete.bind(foldersStore) };
  return { method: "", fn: null };
}

function settingsFolderDesktopUpdateDeleteControls(panel){
  const operatorMode = folderOperatorModeEnabled();
  const selectedIds = settingsFolderDesktopSelectedDeleteIds(panel);
  panel.__h2oFolderDesktopDeleteSelectedIds = selectedIds;
  const preview = panel?.__h2oFolderDesktopDeletionPreview;
  const previewBtn = panel?.querySelector("#wbSettingsFolderDesktopPreviewDelete");
  const copyBtn = panel?.querySelector("#wbSettingsFolderDesktopCopyDeletePlan");
  const confirmInput = panel?.querySelector("#wbSettingsFolderDesktopDeleteConfirm");
  const deleteBtn = panel?.querySelector("#wbSettingsFolderDesktopDeleteSelected");
  const confirmationOk = String(confirmInput?.value || "") === FOLDER_DESKTOP_CLEANUP_CONFIRM_TEXT;
  const selectedMatchesPreview = !!preview?.ok
    && JSON.stringify((preview.selectedFolderIds || []).slice().sort()) === JSON.stringify(selectedIds.slice().sort());
  if (previewBtn) previewBtn.disabled = !operatorMode || !STUDIO_isTauri() || selectedIds.length === 0;
  if (copyBtn) copyBtn.disabled = !operatorMode || !preview?.ok;
  if (deleteBtn) deleteBtn.disabled = !operatorMode || !STUDIO_isTauri() || !selectedMatchesPreview || !confirmationOk;
}

async function refreshSettingsFolderDesktopReview(panel, seed = null){
  if (!panel) return null;
  const summary = panel.querySelector("#wbSettingsFolderDesktopReviewSummary");
  const copyBtn = panel.querySelector("#wbSettingsFolderDesktopReviewCopy");
  settingsFolderParitySetOperationStatus(panel, "desktopReview", "running", "Refreshing");
  if (summary) summary.textContent = "Refreshing read-only Desktop cleanup review…";
  if (copyBtn) copyBtn.disabled = true;
  const loaded = await settingsFolderDesktopLoadReviewInputs(seed);
  panel.__h2oFolderDesktopReviewReport = loaded.report;
  settingsFolderDesktopRenderReport(panel, loaded.report);
  const counts = loaded.report?.counts || {};
  const reviewCount = settingsFolderCleanupNumber(counts.desktopCandidates)
    + settingsFolderCleanupNumber(counts.chromeCandidates)
    + settingsFolderCleanupNumber(counts.boundReview)
    + settingsFolderCleanupNumber(counts.orphanBindings);
  settingsFolderParitySetOperationStatus(panel, "desktopReview", reviewCount ? "warning" : "works", reviewCount ? `${reviewCount} review item(s)` : "No Desktop review items");
  settingsFolderParityRenderOperationRows(panel);
  refreshSettingsFolderDesktopOrphanBindingReview(panel, { selfCheck: loaded.selfCheck })
    .catch((err) => settingsFolderParityLog(panel, "Orphan binding review failed.\n" + String(err && (err.stack || err.message || err))));
  return loaded.report;
}

async function copySettingsFolderDesktopReviewReport(panel){
  if (!panel) return;
  let report = panel.__h2oFolderDesktopReviewReport;
  if (!report) report = await refreshSettingsFolderDesktopReview(panel);
  const text = JSON.stringify(report || {}, null, 2);
  try {
    if (W.navigator?.clipboard?.writeText) {
      await W.navigator.clipboard.writeText(text);
      settingsFolderParityLog(panel, "Desktop cleanup review report JSON copied to clipboard.");
      return;
    }
  } catch (err) {
    settingsFolderParityLog(panel, "Clipboard copy failed; Desktop cleanup review report printed to console.\n" + String(err && (err.message || err)));
  }
  try { console.log("H2O_DESKTOP_FOLDER_CLEANUP_REVIEW_REPORT", report); } catch {}
  settingsFolderParityLog(panel, "Clipboard unavailable; Desktop cleanup review report printed to console as H2O_DESKTOP_FOLDER_CLEANUP_REVIEW_REPORT.");
}

async function refreshSettingsFolderDesktopOrphanBindingReview(panel, seed = null){
  if (!panel) return null;
  const summary = panel.querySelector("#wbSettingsFolderDesktopOrphanBindingSummary");
  const copyBtn = panel.querySelector("#wbSettingsFolderDesktopOrphanBindingCopy");
  settingsFolderParitySetOperationStatus(panel, "orphanBindingReview", "running", "Refreshing");
  if (summary) summary.textContent = "Refreshing read-only orphan binding review…";
  if (copyBtn) copyBtn.disabled = true;
  const report = await settingsFolderDesktopLoadOrphanBindingReview(seed);
  if (settingsFolderDesktopOrphanBindingRemovalBlockers(report).length) {
    FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.preview = null;
  }
  panel.__h2oFolderDesktopOrphanBindingReport = report;
  settingsFolderDesktopRenderOrphanBindingReport(panel, report);
  const blockers = settingsFolderDesktopOrphanBindingRemovalBlockers(report);
  const orphanCount = settingsFolderCleanupNumber(report?.review?.orphanBindingCount || report?.orphanBindingCount || 0);
  settingsFolderParitySetOperationStatus(panel, "orphanBindingReview", orphanCount || blockers.length ? "warning" : "works", orphanCount ? `${orphanCount} orphan binding(s)` : (blockers.length ? `${blockers.length} blocker(s)` : "No orphan binding"));
  settingsFolderParityRenderOperationRows(panel);
  return report;
}

async function copySettingsFolderDesktopOrphanBindingReport(panel){
  if (!panel) return;
  let report = panel.__h2oFolderDesktopOrphanBindingReport;
  if (!report) report = await refreshSettingsFolderDesktopOrphanBindingReview(panel);
  const text = JSON.stringify(report || {}, null, 2);
  try {
    if (W.navigator?.clipboard?.writeText) {
      await W.navigator.clipboard.writeText(text);
      settingsFolderParityLog(panel, "Orphan Desktop binding review report JSON copied to clipboard.");
      return;
    }
  } catch (err) {
    settingsFolderParityLog(panel, "Clipboard copy failed; orphan binding report printed to console.\n" + String(err && (err.message || err)));
  }
  try { console.log("H2O_ORPHAN_BINDING_REVIEW_REPORT", report); } catch {}
  settingsFolderParityLog(panel, "Clipboard unavailable; orphan binding report printed to console as H2O_ORPHAN_BINDING_REVIEW_REPORT.");
}

async function previewSettingsFolderDesktopOrphanBindingRemoval(panel){
  if (!panel) return null;
  const selected = settingsFolderDesktopOrphanBindingSelected(panel);
  const report = await settingsFolderDesktopLoadOrphanBindingReview();
  const preview = settingsFolderDesktopBuildOrphanBindingRemovalPreview(selected, report);
  FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.selected = !!selected;
  FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.preview = preview.ok ? preview : null;
  FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.status = preview.ok ? "Removal preview is ready." : "Removal preview is blocked.";
  panel.__h2oFolderDesktopOrphanBindingReport = report;
  panel.__h2oFolderDesktopOrphanBindingRemovalPreview = FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.preview;
  settingsFolderDesktopRenderOrphanBindingReport(panel, report);
  if (selected) {
    const box = Array.from(panel.querySelectorAll("#wbSettingsFolderDesktopOrphanBindingRemoveList input[data-chat-id][data-folder-id]") || [])
      .find((input) => String(input.dataset.chatId || "").trim() === selected.chatId && String(input.dataset.folderId || "").trim() === selected.folderId);
    if (box) box.checked = true;
  }
  const previewEl = panel.querySelector("#wbSettingsFolderDesktopOrphanBindingRemovePreview");
  if (previewEl) {
    previewEl.hidden = false;
    previewEl.textContent = JSON.stringify(preview, null, 2);
  }
  if (!preview.ok) settingsFolderParityLog(panel, "Orphan binding removal preview blocked.\n" + String(preview.error || "Unknown guard failure"));
  settingsFolderDesktopUpdateOrphanBindingRemovalControls(panel);
  return preview;
}

async function copySettingsFolderDesktopOrphanBindingRemovalPlan(panel){
  if (!panel) return;
  let preview = FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.preview || panel.__h2oFolderDesktopOrphanBindingRemovalPreview;
  if (!preview) preview = await previewSettingsFolderDesktopOrphanBindingRemoval(panel);
  const text = JSON.stringify(preview || {}, null, 2);
  try {
    if (W.navigator?.clipboard?.writeText) {
      await W.navigator.clipboard.writeText(text);
      settingsFolderParityLog(panel, "Orphan binding removal plan JSON copied to clipboard.");
      return;
    }
  } catch (err) {
    settingsFolderParityLog(panel, "Clipboard copy failed; orphan binding removal plan printed to console.\n" + String(err && (err.message || err)));
  }
  try { console.log("H2O_ORPHAN_BINDING_REMOVE_PLAN", preview); } catch {}
  settingsFolderParityLog(panel, "Clipboard unavailable; orphan binding removal plan printed to console as H2O_ORPHAN_BINDING_REMOVE_PLAN.");
}

async function removeSelectedOrphanDesktopBinding(panel){
  if (!panel) return;
  if (!folderOperatorModeEnabled()) {
    settingsFolderParityLog(panel, "Folder operator mode is required for cleanup mutation.");
    settingsFolderDesktopUpdateOrphanBindingRemovalControls(panel);
    return;
  }
  const previewEl = panel.querySelector("#wbSettingsFolderDesktopOrphanBindingRemovePreview");
  const confirmInput = panel.querySelector("#wbSettingsFolderDesktopOrphanBindingRemoveConfirm");
  if (confirmInput) FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.confirmation = String(confirmInput.value || "");
  const confirmValue = FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.confirmation;
  if (confirmValue !== FOLDER_DESKTOP_ORPHAN_BINDING_CONFIRM_TEXT) {
    settingsFolderParityLog(panel, "Orphan binding removal blocked. Confirmation text does not match.");
    settingsFolderDesktopUpdateOrphanBindingRemovalControls(panel);
    return;
  }
  const selected = settingsFolderDesktopOrphanBindingSelected(panel);
  const existingPreview = FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.preview || panel.__h2oFolderDesktopOrphanBindingRemovalPreview;
  const previewMatchesSelection = !!existingPreview?.ok
    && !!selected
    && (existingPreview.selectedBindings || []).length === 1
    && existingPreview.selectedBindings[0]?.chatId === selected.chatId
    && existingPreview.selectedBindings[0]?.folderId === selected.folderId;
  if (!previewMatchesSelection) {
    settingsFolderParityLog(panel, "Orphan binding removal blocked. Generate a fresh removal preview for the selected binding first.");
    settingsFolderDesktopUpdateOrphanBindingRemovalControls(panel);
    return;
  }

  const beforeReport = await settingsFolderDesktopLoadOrphanBindingReview();
  const validation = settingsFolderDesktopValidateOrphanBindingRemovalSelection(selected, beforeReport);
  if (!validation.ok) {
    settingsFolderParityLog(panel, "Orphan binding removal aborted before mutation.\n" + String(validation.error || "Guard failed"));
    settingsFolderDesktopUpdateOrphanBindingRemovalControls(panel);
    return;
  }
  const unbind = settingsFolderDesktopResolveUnbindMethod();
  if (typeof unbind.fn !== "function") {
    settingsFolderParityLog(panel, "Orphan binding removal aborted before mutation. H2O.Studio.store.folders.unbindChat is unavailable.");
    settingsFolderDesktopUpdateOrphanBindingRemovalControls(panel);
    return;
  }

  const lookups = beforeReport.review?.lookupResults || {};
  const pendingAudit = {
    timestamp: new Date().toISOString(),
    surface: "desktop-studio",
    action: "remove-orphan-desktop-folder-binding",
    selectedBindings: validation.selectedBindings,
    beforeSelfCheck: beforeReport.selfCheck || null,
    beforeBindingRows: settingsFolderCleanupClone(lookups.exactBinding?.rows || []),
    beforeFolderRows: settingsFolderCleanupClone(lookups.folder?.rows || []),
    beforeChatLookup: {
      chatsById: settingsFolderCleanupClone(lookups.chatsById?.rows || []),
      chatsBySourceId: settingsFolderCleanupClone(lookups.chatsBySourceId?.rows || []),
      snapshots: settingsFolderCleanupClone(lookups.snapshots?.rows || []),
      libraryIndex: settingsFolderCleanupClone(lookups.registryRows || []),
      chatBindings: settingsFolderCleanupClone(lookups.chatBindings?.rows || []),
      folderBindings: settingsFolderCleanupClone(lookups.folderBindings?.rows || []),
    },
    result: "pending",
    errors: [],
  };

  try {
    await settingsFolderDesktopAppendAudit(pendingAudit);
  } catch (auditErr) {
    settingsFolderParityLog(panel, "Orphan binding removal aborted before mutation. Cleanup audit could not be written.\n" + String(auditErr && (auditErr.stack || auditErr.message || auditErr)));
    settingsFolderDesktopUpdateOrphanBindingRemovalControls(panel);
    return;
  }

  let resultAudit = {
    ...pendingAudit,
    timestamp: new Date().toISOString(),
    beforeChatLookup: null,
  };
  try {
    const target = settingsFolderDesktopTargetOrphanBinding();
    const ok = await unbind.fn(target.folderId, target.chatId);
    if (!ok) throw new Error(`store.folders.${unbind.method} returned false for ${target.folderId}/${target.chatId}`);
    try { W.H2O?.LibraryWorkspace?._bustCaches?.("folder-desktop-remove-orphan-binding"); } catch {}
    try { await W.H2O?.LibraryIndex?.refresh?.("folder-desktop-remove-orphan-binding"); } catch {}
    const afterReport = await settingsFolderDesktopLoadOrphanBindingReview();
    resultAudit = {
      ...resultAudit,
      result: "ok",
      afterSelfCheck: afterReport.selfCheck || null,
      afterBindingRows: settingsFolderCleanupClone(afterReport.review?.lookupResults?.exactBinding?.rows || []),
      errors: [],
    };
    try { await settingsFolderDesktopAppendAudit(resultAudit); }
    catch (auditErr) {
      resultAudit.errors = ["Result audit append failed: " + String(auditErr && (auditErr.message || auditErr))];
    }
    const result = {
      ok: true,
      action: "remove-orphan-desktop-folder-binding",
      selectedBindings: validation.selectedBindings,
      beforeBindingRows: pendingAudit.beforeBindingRows,
      afterBindingRows: resultAudit.afterBindingRows,
      folderStillExists: !!afterReport.review?.folderExists,
      auditWarning: resultAudit.errors[0] || "",
      auditKey: FOLDER_CLEANUP_AUDIT_KEY,
      folderRowNote: "The folder row was not deleted.",
      chromeMirrorNote: "Chrome mirror cleanup is separate and was not performed.",
      nativeStateNote: "Native ChatGPT folder-state was not modified.",
    };
    if (previewEl) {
      previewEl.hidden = false;
      previewEl.textContent = JSON.stringify(result, null, 2);
    }
    settingsFolderParityLog(panel, "Selected orphan Desktop binding removed. Folder row, Chrome mirror, native folder-state, and sync folder were not modified.");
    FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.selected = false;
    FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.confirmation = "";
    FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.preview = null;
    FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.status = "Binding removal completed.";
    panel.__h2oFolderDesktopOrphanBindingRemovalPreview = null;
    panel.__h2oFolderDesktopOrphanBindingSelected = null;
    if (confirmInput) confirmInput.value = "";
    await refreshSettingsFolderParity(panel);
    const refreshedPreviewEl = panel.querySelector("#wbSettingsFolderDesktopOrphanBindingRemovePreview");
    if (refreshedPreviewEl) {
      refreshedPreviewEl.hidden = false;
      refreshedPreviewEl.textContent = JSON.stringify(result, null, 2);
    }
  } catch (err) {
    resultAudit = {
      ...resultAudit,
      result: "failed",
      afterSelfCheck: null,
      afterBindingRows: null,
      errors: [String(err && (err.stack || err.message || err))],
    };
    try { await settingsFolderDesktopAppendAudit(resultAudit); } catch {}
    settingsFolderParityLog(panel, "Orphan binding removal failed after pending audit.\n" + String(err && (err.stack || err.message || err)));
    throw err;
  } finally {
    settingsFolderDesktopUpdateOrphanBindingRemovalControls(panel);
  }
}

async function previewSettingsFolderDesktopDeletion(panel){
  if (!panel) return null;
  const previewEl = panel.querySelector("#wbSettingsFolderDesktopDeletePreview");
  const selectedIds = settingsFolderDesktopSelectedDeleteIds(panel);
  const loaded = await settingsFolderDesktopLoadReviewInputs();
  const preview = settingsFolderDesktopBuildDeletePreview(selectedIds, loaded);
  panel.__h2oFolderDesktopReviewReport = loaded.report;
  panel.__h2oFolderDesktopDeletionPreview = preview.ok ? preview : null;
  settingsFolderDesktopRenderReport(panel, loaded.report);
  const selectedSet = new Set(selectedIds);
  Array.from(panel.querySelectorAll("#wbSettingsFolderDesktopDeleteList input[data-folder-id]") || [])
    .forEach((box) => { box.checked = selectedSet.has(String(box.dataset.folderId || "").trim()); });
  if (previewEl) {
    previewEl.hidden = false;
    previewEl.textContent = JSON.stringify(preview, null, 2);
  }
  if (!preview.ok) settingsFolderParityLog(panel, "Desktop deletion preview blocked.\n" + String(preview.error || "Unknown guard failure"));
  settingsFolderDesktopUpdateDeleteControls(panel);
  return preview;
}

async function copySettingsFolderDesktopDeletionPlan(panel){
  if (!panel) return;
  let preview = panel.__h2oFolderDesktopDeletionPreview;
  if (!preview) preview = await previewSettingsFolderDesktopDeletion(panel);
  const text = JSON.stringify(preview || {}, null, 2);
  try {
    if (W.navigator?.clipboard?.writeText) {
      await W.navigator.clipboard.writeText(text);
      settingsFolderParityLog(panel, "Desktop deletion plan JSON copied to clipboard.");
      return;
    }
  } catch (err) {
    settingsFolderParityLog(panel, "Clipboard copy failed; Desktop deletion plan printed to console.\n" + String(err && (err.message || err)));
  }
  try { console.log("H2O_DESKTOP_FOLDER_DELETE_PLAN", preview); } catch {}
  settingsFolderParityLog(panel, "Clipboard unavailable; Desktop deletion plan printed to console as H2O_DESKTOP_FOLDER_DELETE_PLAN.");
}

async function deleteSelectedEmptyDesktopFolders(panel){
  if (!panel) return;
  if (!folderOperatorModeEnabled()) {
    settingsFolderParityLog(panel, "Folder operator mode is required for cleanup mutation.");
    settingsFolderDesktopUpdateDeleteControls(panel);
    return;
  }
  const previewEl = panel.querySelector("#wbSettingsFolderDesktopDeletePreview");
  const confirmValue = String(panel.querySelector("#wbSettingsFolderDesktopDeleteConfirm")?.value || "");
  if (confirmValue !== FOLDER_DESKTOP_CLEANUP_CONFIRM_TEXT) {
    settingsFolderParityLog(panel, "Desktop deletion blocked. Confirmation text does not match.");
    settingsFolderDesktopUpdateDeleteControls(panel);
    return;
  }
  const selectedIds = settingsFolderDesktopSelectedDeleteIds(panel);
  const existingPreview = panel.__h2oFolderDesktopDeletionPreview;
  const previewMatchesSelection = !!existingPreview?.ok
    && JSON.stringify((existingPreview.selectedFolderIds || []).slice().sort()) === JSON.stringify(selectedIds.slice().sort());
  if (!previewMatchesSelection) {
    settingsFolderParityLog(panel, "Desktop deletion blocked. Generate a fresh Desktop deletion preview for the selected folders first.");
    settingsFolderDesktopUpdateDeleteControls(panel);
    return;
  }

  const loaded = await settingsFolderDesktopLoadReviewInputs();
  const validation = settingsFolderDesktopValidateDeleteSelection(selectedIds, loaded.report);
  if (!validation.ok) {
    settingsFolderParityLog(panel, "Desktop deletion aborted before mutation.\n" + String(validation.error || "Guard failed"));
    settingsFolderDesktopUpdateDeleteControls(panel);
    return;
  }
  const remove = settingsFolderDesktopResolveRemoveMethod();
  if (typeof remove.fn !== "function") {
    settingsFolderParityLog(panel, "Desktop deletion aborted before mutation. H2O.Studio.store.folders.remove/delete is unavailable.");
    settingsFolderDesktopUpdateDeleteControls(panel);
    return;
  }

  const beforeSummary = settingsFolderDesktopSummaryFromFacts(loaded.desktopFacts);
  const pendingAudit = {
    timestamp: new Date().toISOString(),
    surface: "desktop-studio",
    action: "delete-empty-desktop-folders",
    selectedFolderIds: validation.selectedFolderIds,
    selectedFolders: validation.candidates,
    beforeSelfCheck: loaded.selfCheck,
    beforeDesktopFolders: settingsFolderCleanupClone(loaded.desktopFacts?.f5dFolders || []),
    beforeDesktopBindings: settingsFolderCleanupClone(loaded.desktopFacts?.bindingsByFolder || {}),
    beforeCandidateModel: settingsFolderCleanupClone(loaded.report),
    result: "pending",
    afterSelfCheck: null,
    afterDesktopFolders: null,
    afterDesktopBindings: null,
    errors: [],
  };

  try {
    await settingsFolderDesktopAppendAudit(pendingAudit);
  } catch (auditErr) {
    settingsFolderParityLog(panel, "Desktop deletion aborted before mutation. Cleanup audit could not be written.\n" + String(auditErr && (auditErr.stack || auditErr.message || auditErr)));
    settingsFolderDesktopUpdateDeleteControls(panel);
    return;
  }

  let resultAudit = {
    ...pendingAudit,
    timestamp: new Date().toISOString(),
    beforeCandidateModel: null,
    beforeDesktopFoldersSummary: beforeSummary,
  };
  try {
    const removed = [];
    for (const folderId of validation.selectedFolderIds) {
      const ok = await remove.fn(folderId);
      if (!ok) throw new Error(`store.folders.${remove.method} returned false for ${folderId}`);
      removed.push(folderId);
    }
    try { W.H2O?.LibraryWorkspace?._bustCaches?.("folder-desktop-delete-empty-f5d-folders"); } catch {}
    try { await W.H2O?.LibraryIndex?.refresh?.("folder-desktop-delete-empty-f5d-folders"); } catch {}
    const afterLoaded = await settingsFolderDesktopLoadReviewInputs();
    resultAudit = {
      ...resultAudit,
      result: "ok",
      removedFolderIds: removed,
      afterSelfCheck: afterLoaded.selfCheck,
      afterDesktopFolders: settingsFolderCleanupClone(afterLoaded.desktopFacts?.f5dFolders || []),
      afterDesktopBindings: settingsFolderCleanupClone(afterLoaded.desktopFacts?.bindingsByFolder || {}),
      afterDesktopFoldersSummary: settingsFolderDesktopSummaryFromFacts(afterLoaded.desktopFacts),
      errors: [],
    };
    try { await settingsFolderDesktopAppendAudit(resultAudit); }
    catch (auditErr) {
      resultAudit.errors = ["Result audit append failed: " + String(auditErr && (auditErr.message || auditErr))];
    }
    const result = {
      ok: true,
      action: "delete-empty-desktop-folders",
      selectedFolderIds: validation.selectedFolderIds,
      removedFolderIds: removed,
      beforeDesktopFoldersSummary: beforeSummary,
      afterDesktopFoldersSummary: resultAudit.afterDesktopFoldersSummary,
      auditWarning: resultAudit.errors[0] || "",
      auditKey: FOLDER_CLEANUP_AUDIT_KEY,
      chromeMirrorNote: "Chrome mirror cleanup is separate and was not performed.",
      nativeStateNote: "Native ChatGPT folder-state was not modified.",
    };
    if (previewEl) {
      previewEl.hidden = false;
      previewEl.textContent = JSON.stringify(result, null, 2);
    }
    settingsFolderParityLog(panel, "Selected empty Desktop F5D folder(s) deleted. Chrome mirror, native folder-state, and sync folder were not modified.");
    panel.__h2oFolderDesktopDeletionPreview = null;
    panel.__h2oFolderDesktopDeleteSelectedIds = [];
    const input = panel.querySelector("#wbSettingsFolderDesktopDeleteConfirm");
    if (input) input.value = "";
    await refreshSettingsFolderParity(panel);
    const refreshedPreviewEl = panel.querySelector("#wbSettingsFolderDesktopDeletePreview");
    if (refreshedPreviewEl) {
      refreshedPreviewEl.hidden = false;
      refreshedPreviewEl.textContent = JSON.stringify(result, null, 2);
    }
  } catch (err) {
    resultAudit = {
      ...resultAudit,
      result: "failed",
      afterSelfCheck: null,
      afterDesktopFolders: null,
      afterDesktopBindings: null,
      errors: [String(err && (err.stack || err.message || err))],
    };
    try { await settingsFolderDesktopAppendAudit(resultAudit); } catch {}
    settingsFolderParityLog(panel, "Desktop deletion failed after pending audit.\n" + String(err && (err.stack || err.message || err)));
    throw err;
  } finally {
    settingsFolderDesktopUpdateDeleteControls(panel);
  }
}

function settingsFolderCleanupUpdateDeleteControls(panel){
  const operatorMode = folderOperatorModeEnabled();
  const chromeSurface = settingsFolderCleanupIsChromeSurface();
  const selectedIds = settingsFolderCleanupSelectedIds(panel);
  panel.__h2oFolderCleanupDeleteSelectedIds = selectedIds;
  const preview = panel?.__h2oFolderCleanupDeletionPreview;
  const previewBtn = panel?.querySelector("#wbSettingsFolderCleanupPreview");
  const copyBtn = panel?.querySelector("#wbSettingsFolderCleanupCopyDeletePlan");
  const confirmInput = panel?.querySelector("#wbSettingsFolderCleanupConfirm");
  const deleteBtn = panel?.querySelector("#wbSettingsFolderCleanupDeleteSelected");
  const confirmationOk = String(confirmInput?.value || "") === FOLDER_CLEANUP_CONFIRM_TEXT;
  const selectedMatchesPreview = !!preview?.ok
    && JSON.stringify((preview.selectedFolderIds || []).slice().sort()) === JSON.stringify(selectedIds.slice().sort());
  if (previewBtn) previewBtn.disabled = !operatorMode || !chromeSurface || selectedIds.length === 0;
  if (copyBtn) copyBtn.disabled = !operatorMode || !preview?.ok;
  if (deleteBtn) deleteBtn.disabled = !operatorMode || !chromeSurface || !selectedMatchesPreview || !confirmationOk;
}

async function refreshSettingsFolderCleanupReview(panel, seed = null){
  if (!panel) return null;
  settingsFolderCleanupEnsureStableTitle(panel);
  const summary = panel.querySelector("#wbSettingsFolderCleanupReviewSummary");
  const copyBtn = panel.querySelector("#wbSettingsFolderCleanupReviewCopy");
  const dryRunSummary = panel.querySelector("#wbSettingsFolderCleanupDryRunSummary");
  const dryRunRows = panel.querySelector("#wbSettingsFolderCleanupDryRunRows");
  const dryRunSelectedRows = panel.querySelector("#wbSettingsFolderCleanupDryRunSelectedRows");
  const dryRunReasonCodes = panel.querySelector("#wbSettingsFolderCleanupDryRunReasonCodes");
  const dryRunJson = panel.querySelector("#wbSettingsFolderCleanupDryRunJson");
  const dryRunCopy = panel.querySelector("#wbSettingsFolderCleanupDryRunCopy");
  const parity = W.H2O?.Library?.FolderParity;
  if (!parity || typeof parity.selfCheck !== "function" || typeof parity.getDisplayModel !== "function") {
    if (summary) summary.textContent = "Cleanup Candidate Review unavailable.";
    if (copyBtn) copyBtn.disabled = true;
    if (dryRunCopy) dryRunCopy.disabled = true;
    return null;
  }
  if (summary) summary.textContent = "Refreshing review-only cleanup candidates…";
  if (copyBtn) copyBtn.disabled = true;
  panel.__h2oFolderCleanupDryRunPlan = null;
  FOLDER_PARITY_SETTINGS_UI_STATE.cleanupDryRunPlan = null;
  if (dryRunSummary) dryRunSummary.textContent = "Select review rows, then generate a dry-run plan. No cleanup is performed.";
  if (dryRunRows) {
    dryRunRows.innerHTML = "";
    dryRunRows.removeAttribute("data-folder-cleanup-dry-run-rendered");
  }
  if (dryRunSelectedRows) dryRunSelectedRows.innerHTML = "";
  if (dryRunReasonCodes) dryRunReasonCodes.innerHTML = "";
  if (dryRunJson) {
    dryRunJson.hidden = true;
    dryRunJson.textContent = "";
    dryRunJson.removeAttribute("data-folder-cleanup-dry-run-rendered");
  }
  if (dryRunCopy) dryRunCopy.disabled = true;
  panel.querySelector("#wbSettingsFolderCleanupDryRunBox")?.removeAttribute("data-folder-cleanup-dry-run-rendered");
  settingsFolderCleanupClearApplyPreview(panel);
  const loaded = seed?.selfCheck
    ? { selfCheck: seed.selfCheck, displayModel: await promiseWithTimeout(parity.getDisplayModel({ fresh: true }), STUDIO_BOOT_AUX_TIMEOUT_MS, "FolderParity.getDisplayModel") }
    : await settingsFolderCleanupLoadReviewInputs();
  const plan = loaded.plan || settingsFolderCleanupBuildReviewPlan(loaded.selfCheck, loaded.displayModel);
  panel.__h2oFolderCleanupReviewPlan = plan;
  settingsFolderCleanupRenderPlan(panel, plan);
  await refreshSettingsFolderConflictReview(panel, {
    selfCheck: loaded.selfCheck,
    displayModel: loaded.displayModel,
  }).catch((err) => settingsFolderParityLog(panel, "Folder conflict review failed.\n" + String(err && (err.stack || err.message || err))));
  await refreshSettingsFolderDesktopReview(panel, {
    selfCheck: loaded.selfCheck,
    displayModel: loaded.displayModel,
  }).catch((err) => settingsFolderParityLog(panel, "Desktop cleanup review failed.\n" + String(err && (err.stack || err.message || err))));
  return plan;
}

async function refreshSettingsFolderParity(panel){
  if (!panel) return;
  const summary = panel.querySelector("#wbSettingsFolderParitySummary");
  const statusEl = panel.querySelector("#wbSettingsFolderParityStatus");
  const listsEl = panel.querySelector("#wbSettingsFolderParityLists");
  const warnEl = panel.querySelector("#wbSettingsFolderParityWarn");
  const copyBtn = panel.querySelector("#wbSettingsFolderParityCopy");
  const parity = W.H2O?.Library?.FolderParity;
  if (!parity || typeof parity.diagnose !== "function") {
    if (summary) summary.textContent = "Folder parity diagnostics unavailable.";
    if (statusEl) statusEl.innerHTML = settingsSyncRowsHtml([["Status", "unavailable"]]);
    if (copyBtn) copyBtn.disabled = true;
    return;
  }

  if (summary) summary.textContent = "Refreshing read-only folder parity diagnostics…";
  if (copyBtn) copyBtn.disabled = true;
  let report = null;
  let selfCheck = null;
  try {
    report = await promiseWithTimeout(parity.diagnose({ fresh: true }), STUDIO_BOOT_AUX_TIMEOUT_MS, "FolderParity.diagnose");
    selfCheck = typeof parity.selfCheck === "function"
      ? await promiseWithTimeout(parity.selfCheck({ report }), STUDIO_BOOT_AUX_TIMEOUT_MS, "FolderParity.selfCheck")
      : null;
  } catch (err) {
    const reason = String(err && (err.message || err));
    if (summary) summary.textContent = "Folder parity diagnostics unavailable.";
    if (statusEl) statusEl.innerHTML = settingsSyncRowsHtml([
      ["Status", "failed"],
      ["Reason", reason],
    ]);
    if (warnEl) {
      warnEl.hidden = false;
      warnEl.textContent = reason;
    }
    settingsFolderParitySetOperationStatus(panel, "folderDiagnostics", "failed", reason);
    settingsFolderParityRenderOperationRows(panel);
    panel.__h2oFolderParityReport = {
      selfCheck: null,
      diagnostics: { ok: false, error: reason, generatedAt: new Date().toISOString() },
    };
    if (copyBtn) copyBtn.disabled = false;
    return;
  }
  panel.__h2oFolderParityReport = { selfCheck, diagnostics: report };
  settingsFolderParitySetOperationStatus(
    panel,
    "folderDiagnostics",
    selfCheck?.ok === true || report?.riskLevel === "ok" ? "works" : "warning",
    selfCheck?.severity || report?.riskLevel || "diagnostics refreshed"
  );
  settingsFolderParityRenderOverview(panel, report, selfCheck);
  settingsFolderParityRenderCanonicalRows(panel, report);
  settingsFolderParityRenderLocalReview(panel, report);
  settingsFolderParitySetOperationStatus(
    panel,
    "canonicalRows",
    Number(report?.canonicalFolderCount || 0) >= 6 && !(report?.missingCanonicalFolders || []).length ? "works" : "warning",
    `${Number(report?.canonicalFolderCount || 0)} canonical folder(s)`
  );
  settingsFolderParityRenderOperationRows(panel);

  const rows = [
    ["Surface", report.surface || ""],
    ["Self-check severity", selfCheck?.severity || report.riskLevel || ""],
    ["Self-check ok", selfCheck ? String(!!selfCheck.ok) : "unavailable"],
    ["Risk", report.riskLevel || ""],
    ["Native canonical folders", report.canonicalFolderCount],
    ["Local mirror folders", report.localFolderCount],
    ["Canonical memberships", report.canonicalBindingCount],
    ["Local bindings", report.localBindingCount],
    ["Known Studio rows", report.knownStudioRowTotal],
    ["Orphan memberships", report.orphanBindingCount],
    ["Canonical source", report.canonicalSource || ""],
  ];
  if (statusEl) statusEl.innerHTML = settingsSyncRowsHtml(rows);
  if (summary) {
    const severity = String(selfCheck?.severity || report.riskLevel || "");
    summary.textContent = severity === "ok"
      ? "Folder parity self-check passed. No cleanup performed."
      : `Folder parity self-check: ${severity || "unknown"}. No cleanup performed.`;
  }
  if (listsEl) {
    listsEl.innerHTML = `
      <div><strong>Checks needing attention:</strong> ${settingsFolderParityChecksHtml(selfCheck)}</div>
      <div><strong>Duplicate groups:</strong> ${settingsFolderParityNames(report.duplicateGroups)}</div>
      <div><strong>Test folder candidates:</strong> ${settingsFolderParityNames(report.testFolderCandidates)}</div>
      <div><strong>Missing canonical folders:</strong> ${settingsFolderParityNames(report.missingCanonicalFolders)}</div>
      <div><strong>Extra local folders:</strong> ${settingsFolderParityNames(report.extraLocalFolders)}</div>
      <div><strong>Recommended next step:</strong> ${esc(selfCheck?.recommendedNextStep || report.recommendedNextStep || "")}</div>
    `;
  }
  if (warnEl) {
    const warnings = Array.isArray(report.warnings) ? report.warnings : [];
    warnEl.textContent = warnings[0] || "Read-only. No cleanup performed. Cleanup requires reviewed approval.";
  }
  if (copyBtn) copyBtn.disabled = false;
  await refreshSettingsFolderCleanupReview(panel, { selfCheck, report });
}

async function copySettingsFolderParityReport(panel){
  if (!panel) return;
  let report = panel.__h2oFolderParityReport;
  if (!report) {
    await refreshSettingsFolderParity(panel);
    report = panel.__h2oFolderParityReport;
  }
  const text = JSON.stringify(report || {}, null, 2);
  try {
    if (W.navigator?.clipboard?.writeText) {
      await W.navigator.clipboard.writeText(text);
      settingsFolderParityLog(panel, "Folder parity report JSON copied to clipboard.");
      return;
    }
  } catch (err) {
    settingsFolderParityLog(panel, "Clipboard copy failed; report printed to console.\n" + String(err && (err.message || err)));
  }
  try { console.log("H2O_FOLDER_PARITY_REPORT", report); } catch {}
  settingsFolderParityLog(panel, "Clipboard unavailable; folder parity report printed to console as H2O_FOLDER_PARITY_REPORT.");
}

async function copySettingsFolderCleanupReviewPlan(panel){
  if (!panel) return;
  let plan = panel.__h2oFolderCleanupReviewPlan;
  if (!plan) plan = await refreshSettingsFolderCleanupReview(panel);
  const text = JSON.stringify(plan || {}, null, 2);
  try {
    if (W.navigator?.clipboard?.writeText) {
      await W.navigator.clipboard.writeText(text);
      settingsFolderParityLog(panel, "Folder cleanup review plan JSON copied to clipboard.");
      return;
    }
  } catch (err) {
    settingsFolderParityLog(panel, "Clipboard copy failed; cleanup review plan printed to console.\n" + String(err && (err.message || err)));
  }
  try { console.log("H2O_FOLDER_CLEANUP_REVIEW_PLAN", plan); } catch {}
  settingsFolderParityLog(panel, "Clipboard unavailable; cleanup review plan printed to console as H2O_FOLDER_CLEANUP_REVIEW_PLAN.");
}

async function previewSettingsFolderCleanupDeletion(panel){
  if (!panel) return null;
  const previewEl = panel.querySelector("#wbSettingsFolderCleanupDeletePreview");
  const selectedIds = settingsFolderCleanupSelectedIds(panel);
  const loaded = await settingsFolderCleanupLoadReviewInputs();
  const mirror = await settingsFolderCleanupReadChromeMirror();
  const preview = settingsFolderCleanupBuildDeletionPreview(selectedIds, loaded.plan, mirror);
  panel.__h2oFolderCleanupReviewPlan = loaded.plan;
  panel.__h2oFolderCleanupDeletionPreview = preview.ok ? preview : null;
  if (previewEl) {
    previewEl.hidden = false;
    previewEl.textContent = JSON.stringify(preview, null, 2);
  }
  if (!preview.ok) settingsFolderParityLog(panel, "Folder cleanup preview blocked.\n" + String(preview.error || "Unknown guard failure"));
  settingsFolderCleanupUpdateDeleteControls(panel);
  return preview;
}

async function copySettingsFolderCleanupDeletionPlan(panel){
  if (!panel) return;
  let preview = panel.__h2oFolderCleanupDeletionPreview;
  if (!preview) preview = await previewSettingsFolderCleanupDeletion(panel);
  const text = JSON.stringify(preview || {}, null, 2);
  try {
    if (W.navigator?.clipboard?.writeText) {
      await W.navigator.clipboard.writeText(text);
      settingsFolderParityLog(panel, "Folder cleanup deletion plan JSON copied to clipboard.");
      return;
    }
  } catch (err) {
    settingsFolderParityLog(panel, "Clipboard copy failed; deletion plan printed to console.\n" + String(err && (err.message || err)));
  }
  try { console.log("H2O_FOLDER_CLEANUP_DELETE_PLAN", preview); } catch {}
  settingsFolderParityLog(panel, "Clipboard unavailable; deletion plan printed to console as H2O_FOLDER_CLEANUP_DELETE_PLAN.");
}

async function deleteSelectedSafeChromeMirrorFolders(panel){
  if (!panel) return;
  if (!folderOperatorModeEnabled()) {
    settingsFolderParityLog(panel, "Folder operator mode is required for cleanup mutation.");
    settingsFolderCleanupUpdateDeleteControls(panel);
    return;
  }
  const previewEl = panel.querySelector("#wbSettingsFolderCleanupDeletePreview");
  const confirmValue = String(panel.querySelector("#wbSettingsFolderCleanupConfirm")?.value || "");
  if (confirmValue !== FOLDER_CLEANUP_CONFIRM_TEXT) {
    settingsFolderParityLog(panel, "Deletion blocked. Confirmation text does not match.");
    settingsFolderCleanupUpdateDeleteControls(panel);
    return;
  }
  const selectedIds = settingsFolderCleanupSelectedIds(panel);
  const existingPreview = panel.__h2oFolderCleanupDeletionPreview;
  const previewMatchesSelection = !!existingPreview?.ok
    && JSON.stringify((existingPreview.selectedFolderIds || []).slice().sort()) === JSON.stringify(selectedIds.slice().sort());
  if (!previewMatchesSelection) {
    settingsFolderParityLog(panel, "Deletion blocked. Generate a fresh deletion preview for the selected folders first.");
    settingsFolderCleanupUpdateDeleteControls(panel);
    return;
  }
  const loaded = await settingsFolderCleanupLoadReviewInputs();
  const mirror = await settingsFolderCleanupReadChromeMirror();
  const validation = settingsFolderCleanupValidateDeletionSelection(selectedIds, loaded.plan, mirror);
  if (!validation.ok) {
    settingsFolderParityLog(panel, "Deletion aborted before mutation.\n" + String(validation.error || "Guard failed"));
    settingsFolderCleanupUpdateDeleteControls(panel);
    return;
  }

  const beforeSummary = settingsFolderCleanupFolderStateSummary(mirror.state);
  const pendingAudit = {
    timestamp: new Date().toISOString(),
    surface: "chrome-studio",
    action: "delete-empty-chrome-mirror-folders",
    selectedFolderIds: validation.selectedFolderIds,
    selectedFolders: validation.candidates,
    beforeSelfCheck: loaded.selfCheck,
    beforeFolderStateSummary: beforeSummary,
    beforeFolderStateSnapshot: settingsFolderCleanupClone(mirror.state),
    result: "pending",
    afterSelfCheck: null,
    afterFolderStateSummary: null,
    errors: [],
  };

  await settingsFolderCleanupAppendAudit(pendingAudit);

  let resultAudit = {
    ...pendingAudit,
    timestamp: new Date().toISOString(),
    beforeFolderStateSnapshot: null,
  };
  try {
    const nextState = settingsFolderCleanupBuildNextState(mirror, validation.selectedFolderIds);
    await settingsFolderCleanupChromeSetStrict({ [FOLDER_STATE_DATA_KEY]: nextState });
    try { W.H2O?.LibraryWorkspace?._bustCaches?.("folder-cleanup-delete-empty-chrome-mirror-folders"); } catch {}
    try { await W.H2O?.LibraryIndex?.refresh?.("folder-cleanup-delete-empty-chrome-mirror-folders"); } catch {}
    const afterLoaded = await settingsFolderCleanupLoadReviewInputs();
    const afterMirror = await settingsFolderCleanupReadChromeMirror();
    resultAudit = {
      ...resultAudit,
      result: "ok",
      afterSelfCheck: afterLoaded.selfCheck,
      afterFolderStateSummary: settingsFolderCleanupFolderStateSummary(afterMirror.state),
      errors: [],
    };
    try { await settingsFolderCleanupAppendAudit(resultAudit); }
    catch (auditErr) {
      resultAudit.errors = ["Result audit append failed: " + String(auditErr && (auditErr.message || auditErr))];
    }
    const result = {
      ok: true,
      action: "delete-empty-chrome-mirror-folders",
      selectedFolderIds: validation.selectedFolderIds,
      beforeFolderStateSummary: beforeSummary,
      afterFolderStateSummary: resultAudit.afterFolderStateSummary,
      auditWarning: resultAudit.errors[0] || "",
      auditKey: FOLDER_CLEANUP_AUDIT_KEY,
    };
    if (previewEl) {
      previewEl.hidden = false;
      previewEl.textContent = JSON.stringify(result, null, 2);
    }
    settingsFolderParityLog(panel, "Selected safe empty Chrome mirror folder(s) deleted. Native folders and Desktop SQLite were not modified.");
    panel.__h2oFolderCleanupDeletionPreview = null;
    panel.__h2oFolderCleanupDeleteSelectedIds = [];
    const input = panel.querySelector("#wbSettingsFolderCleanupConfirm");
    if (input) input.value = "";
    await refreshSettingsFolderParity(panel);
    const refreshedPreviewEl = panel.querySelector("#wbSettingsFolderCleanupDeletePreview");
    if (refreshedPreviewEl) {
      refreshedPreviewEl.hidden = false;
      refreshedPreviewEl.textContent = JSON.stringify(result, null, 2);
    }
  } catch (err) {
    resultAudit = {
      ...resultAudit,
      result: "failed",
      afterSelfCheck: null,
      afterFolderStateSummary: null,
      errors: [String(err && (err.stack || err.message || err))],
    };
    try { await settingsFolderCleanupAppendAudit(resultAudit); } catch {}
    settingsFolderParityLog(panel, "Deletion failed after pending audit.\n" + String(err && (err.stack || err.message || err)));
    throw err;
  } finally {
    settingsFolderCleanupUpdateDeleteControls(panel);
  }
}

function settingsSyncLog(panel, message){
  const log = panel && panel.querySelector("#wbSettingsSyncLog");
  if (!log) return;
  log.hidden = false;
  log.textContent = String(message || "");
}

/* Phase I — persist the last-picked folder-state JSON path so the
 * import input does not always default to the runbook example path.
 * Storage backend: chrome.storage.local (callback API; shimmed onto
 * localStorage in Tauri via platform.tauri.js, so the same key works
 * in MV3 and Desktop without branching). Self-contained dedicated
 * key — does NOT touch the folder-sync config schema. Read happens
 * once at Settings panel first-render; writes happen on successful
 * picker selection and on Import-folder-state click (best-effort
 * persistence so a typed path is remembered too). All operations
 * are best-effort: any storage failure is swallowed and the UI
 * falls back to the template default. */
const STUDIO_SETTINGS_FOLDER_STATE_LAST_PATH_KEY = "h2o:studio:settings:folder-state-import:last-path:v1";

function STUDIO_settingsReadFolderStateLastPath(){
  return new Promise((resolve) => {
    try {
      if (!W.chrome || !W.chrome.storage || !W.chrome.storage.local) { resolve(""); return; }
      W.chrome.storage.local.get([STUDIO_SETTINGS_FOLDER_STATE_LAST_PATH_KEY], (items) => {
        try {
          const raw = items && items[STUDIO_SETTINGS_FOLDER_STATE_LAST_PATH_KEY];
          resolve(typeof raw === "string" ? raw : "");
        } catch (_) { resolve(""); }
      });
    } catch (_) { resolve(""); }
  });
}

function STUDIO_settingsWriteFolderStateLastPath(path){
  return new Promise((resolve) => {
    try {
      const trimmed = String(path || "").trim();
      if (!trimmed) { resolve(); return; }
      if (!W.chrome || !W.chrome.storage || !W.chrome.storage.local) { resolve(); return; }
      const obj = {}; obj[STUDIO_SETTINGS_FOLDER_STATE_LAST_PATH_KEY] = trimmed;
      W.chrome.storage.local.set(obj, () => resolve());
    } catch (_) { resolve(); }
  });
}

function settingsSummarizeResult(result){
  if (!result || typeof result !== "object") return String(result ?? "");
  const lines = [
    `ok: ${!!result.ok}`,
    `status: ${result.status || "(none)"}`,
  ];
  if (result.path) lines.push(`path: ${result.path}`);
  if (result.bytes) lines.push(`bytes: ${result.bytes}${settingsFormatBytes(result.bytes) ? ` (${settingsFormatBytes(result.bytes)})` : ""}`);
  if (result.chatCount != null) lines.push(`chats: ${result.chatCount}`);
  if (result.snapshotCount != null) lines.push(`snapshots: ${result.snapshotCount}`);
  if (result.turnCount != null) lines.push(`turns: ${result.turnCount}`);
  if (result.importedChats != null) lines.push(`importedChats: ${result.importedChats}`);
  if (result.importedSnapshots != null) lines.push(`importedSnapshots: ${result.importedSnapshots}`);
  if (result.skipped != null) lines.push(`skipped: ${result.skipped}`);
  if (result.rowsAfter != null) lines.push(`rowsAfter: ${result.rowsAfter}`);
  /* Phase E — folder-state import wrapper fields (importFromFile return).
   * All additive: any non-folder-state caller of this summarizer simply
   * lacks these fields and the branches are skipped. */
  if (result.routedVia) lines.push(`routedVia: ${result.routedVia}`);
  if (result.orphanFolderBindings != null) lines.push(`orphan folder bindings: ${result.orphanFolderBindings}`);
  if (result.result && typeof result.result === "object") {
    const inner = result.result;
    if (inner.written && typeof inner.written === "object") {
      if (inner.written.folders != null) lines.push(`folders written: ${inner.written.folders}`);
      if (inner.written.folderBindings != null) lines.push(`folder bindings written: ${inner.written.folderBindings}`);
    }
    if (Array.isArray(inner.warnings)) lines.push(`warnings: ${inner.warnings.length}`);
    if (Array.isArray(inner.errors))   lines.push(`errors: ${inner.errors.length}`);
    if (inner.fallbackKvUpdated != null) lines.push(`fallbackKvUpdated: ${!!inner.fallbackKvUpdated}`);
  }
  const ledgerEntry = result.ledgerEntry;
  if (ledgerEntry && typeof ledgerEntry === "object") {
    if (ledgerEntry.filename)   lines.push(`filename: ${ledgerEntry.filename}`);
    if (ledgerEntry.path)       lines.push(`path: ${ledgerEntry.path}`);
    if (ledgerEntry.sizeBytes) {
      const fmt = settingsFormatBytes(ledgerEntry.sizeBytes);
      lines.push(`size: ${ledgerEntry.sizeBytes}${fmt ? ` (${fmt})` : ""}`);
    }
    if (ledgerEntry.importedAt) lines.push(`imported at: ${settingsIsoOrBlank(ledgerEntry.importedAt)}`);
    if (ledgerEntry.fingerprint) lines.push(`fingerprint: ${String(ledgerEntry.fingerprint).slice(0, 16)}…`);
  }
  /* Orphan-binding sample. Attached by the folder-state import handler
   * from H2O.Studio.sync.diagnose().state.lastImportOrphanBindingSample.
   * Capped at 3 entries by the caller; sample objects preserve their
   * original { kind, folderId, chatId? } shape from import-bundle. */
  if (Array.isArray(result.orphanSample) && result.orphanSample.length > 0) {
    const totalOrphans = (result.orphanFolderBindings != null) ? result.orphanFolderBindings : result.orphanSample.length;
    lines.push(`orphan sample (first ${result.orphanSample.length} of ${totalOrphans}):`);
    for (const o of result.orphanSample) {
      const folderId = String((o && o.folderId) || "");
      const chatId   = String((o && o.chatId)   || "");
      const fShort = folderId ? folderId.slice(0, 18) + (folderId.length > 18 ? "…" : "") : "(none)";
      const cShort = chatId   ? chatId.slice(0, 18)   + (chatId.length   > 18 ? "…" : "") : "(none)";
      lines.push(`  - folder=${fShort} chat=${cShort}`);
    }
  }
  if (result.error || result.reason) lines.push(`error: ${result.error || result.reason}`);
  return lines.join("\n");
}

async function refreshSettingsSync(panel){
  if (!panel) return;
  const isDesktop = STUDIO_isTauri();
  const title = panel.querySelector("#wbSettingsSyncTitle");
  const summary = panel.querySelector("#wbSettingsSyncSummary");
  const statusEl = panel.querySelector("#wbSettingsSyncStatus");
  const desktopControls = panel.querySelector("#wbSettingsSyncDesktopControls");
  const chromeControls = panel.querySelector("#wbSettingsSyncChromeControls");
  /* Phase E — Desktop-only folder-state import sub-section. */
  const folderStateBox = panel.querySelector("#wbSettingsSyncFolderStateImport");

  if (desktopControls) desktopControls.style.display = isDesktop ? "flex" : "none";
  if (chromeControls) chromeControls.style.display = isDesktop ? "none" : "flex";
  if (folderStateBox) folderStateBox.style.display = isDesktop ? "flex" : "none";

  if (isDesktop) {
    if (title) title.textContent = "Desktop Sync Export";
    if (summary) summary.textContent = "Write the latest Studio bundle and control the existing opt-in Desktop auto-export.";
    const ingestion = W.H2O?.Studio?.ingestion || {};
    const sync = W.H2O?.Studio?.sync || null;
    const autoExport = sync && sync.autoExport || null;
    const exportDiag = typeof ingestion.diagnose === "function" ? (ingestion.diagnose() || {}) : {};
    const autoDiag = autoExport && typeof autoExport.diagnose === "function" ? (autoExport.diagnose() || {}) : {};
    const last = autoDiag.lastResult || exportDiag.lastSyncExport || {};
    let folderHealth = null;
    let recentlyDeletedDiagnostics = null;
    try {
      const folderApi = sync && sync.folder;
      if (folderApi && typeof folderApi.diagnoseHealth === "function") {
        folderHealth = await folderApi.diagnoseHealth();
      } else if (folderApi && folderApi.health && typeof folderApi.health.diagnose === "function") {
        folderHealth = await folderApi.health.diagnose();
      }
    } catch (err) {
      folderHealth = { verdict: "warning", blockers: [], warnings: [String(err && (err.message || err))], summaryText: "Folder Sync Health diagnostics failed." };
    }
    try {
      const folderStore = W.H2O?.Studio?.store?.folders;
      const recentlyFn = folderStore && (folderStore.listRecentlyDeletedFolders || folderStore.diagnoseRecentlyDeletedFolders);
      if (typeof recentlyFn === "function") {
        recentlyDeletedDiagnostics = await recentlyFn.call(folderStore, { limit: 500, source: "folder-sync-health-dashboard" });
      }
    } catch (err) {
      recentlyDeletedDiagnostics = { ok: false, status: "recently-deleted-diagnostics-failed", blockers: [String(err && (err.message || err))] };
    }
    if (folderHealth || recentlyDeletedDiagnostics) {
      settingsFolderSyncHealthRender(panel, {
        health: folderHealth || {},
        recentlyDeleted: recentlyDeletedDiagnostics || {},
      });
    } else {
      settingsFolderSyncHealthUnavailable(panel, "Folder Sync Health diagnostics are unavailable on this Desktop surface.");
    }
    /* Phase E — pull the last import's routedVia from the ledger (last
     * entry is always most recent — append-only with MAX cap), and the
     * orphan-binding state from sync.diagnose() (Phase D). Both wrapped
     * defensively so the status grid never crashes the settings refresh. */
    let lastImportEntry = null;
    try {
      if (sync && typeof sync.getLedger === "function") {
        const ledger = await sync.getLedger();
        if (ledger && Array.isArray(ledger.entries) && ledger.entries.length > 0) {
          lastImportEntry = ledger.entries[ledger.entries.length - 1];
        }
      }
    } catch (_) { /* ignore — diagnostic surface, never throw */ }
    let lastOrphanBindings = null;
    let lastOrphanBindingsAt = null;
    try {
      if (sync && typeof sync.diagnose === "function") {
        const d = sync.diagnose() || {};
        const st = (d && d.state) || {};
        lastOrphanBindings   = st.lastImportOrphanBindings;
        lastOrphanBindingsAt = st.lastImportOrphanBindingsAt;
      }
    } catch (_) { /* ignore */ }
    const rows = [
      ["Runtime", "Desktop/Tauri"],
      ["Manual latest export", typeof ingestion.exportLatestSyncBundle === "function" ? "available" : "unavailable"],
      ["Auto export", autoDiag.enabled ? "enabled" : "disabled"],
      ["Pending", autoDiag.pending ? "yes" : "no"],
      ["Last status", autoDiag.lastExportStatus || last.status || ""],
      ["Last time", settingsIsoOrBlank(autoDiag.lastExportAt || last.exportedAt || "")],
      ["Last path", autoDiag.lastExportPath || last.path || ""],
      ["Last bytes", settingsFormatBytes(autoDiag.lastExportBytes || last.bytes || 0)],
      /* Phase E — most-recent folder-state import diagnostics. */
      ["Last import route",   (lastImportEntry && lastImportEntry.routedVia) || ""],
      ["Last orphan bindings", (lastOrphanBindings != null) ? String(lastOrphanBindings) : ""],
      ["Last import time",    settingsIsoOrBlank(lastOrphanBindingsAt || (lastImportEntry && lastImportEntry.importedAt) || "")],
    ];
    if (statusEl) statusEl.innerHTML = settingsSyncRowsHtml(rows);
    const exportBtn = panel.querySelector("#wbSettingsSyncExportLatest");
    const enableBtn = panel.querySelector("#wbSettingsSyncEnableDesktopAuto");
    const disableBtn = panel.querySelector("#wbSettingsSyncDisableDesktopAuto");
    const folderStateBtn = panel.querySelector("#wbSettingsSyncFolderStateImportBtn");
    /* Phase J — defensive capability gate for the Choose-file button.
     * The surrounding sub-section is already hidden when STUDIO_isTauri()
     * is false, but the button can still be reachable if Tauri reports
     * isTauri=true while the invoke surface is mid-initialization (see
     * feedback_tauri_webview_boot_race). Probe STUDIO_getTauriInvoke()
     * as a capability check only — no plugin call, no logging — and
     * disable the button when invoke is unavailable. The path input and
     * Import button stay usable so a manually-typed path can still
     * route through H2O.Studio.sync.importFromFile. */
    const folderStatePickBtn = panel.querySelector("#wbSettingsSyncFolderStatePickBtn");
    if (exportBtn) exportBtn.disabled = typeof ingestion.exportLatestSyncBundle !== "function";
    if (enableBtn) enableBtn.disabled = !(autoExport && typeof autoExport.enable === "function") || !!autoDiag.enabled;
    if (disableBtn) disableBtn.disabled = !(autoExport && typeof autoExport.disable === "function") || !autoDiag.enabled;
    if (folderStateBtn) folderStateBtn.disabled = !(sync && typeof sync.importFromFile === "function");
    if (folderStatePickBtn) folderStatePickBtn.disabled = !STUDIO_getTauriInvoke();
    /* R3 phase 2 — Desktop focus-triggered import buttons.
     * Enabled requires (a) focusImport module registered,
     * (b) sync.desktopImportOnFocus flag, gated against current isEnabled
     * so re-clicks don't churn. Folder-config presence is checked by
     * focusImport.triggerNow / underlying scanFolderOnce at fire time. */
    const focusImport = W.H2O?.Studio?.sync?.focusImport;
    const focusEnableBtn = panel.querySelector("#wbSettingsSyncEnableDesktopFocusImport");
    const focusDisableBtn = panel.querySelector("#wbSettingsSyncDisableDesktopFocusImport");
    if (focusEnableBtn || focusDisableBtn) {
      const focusApiReady = !!(focusImport && typeof focusImport.enable === "function");
      let focusIsOn = false;
      try { focusIsOn = focusApiReady && focusImport.isEnabled() === true; }
      catch (_) { focusIsOn = false; }
      if (focusEnableBtn) focusEnableBtn.disabled = !focusApiReady || focusIsOn;
      if (focusDisableBtn) focusDisableBtn.disabled = !focusApiReady || !focusIsOn;
    }
    return;
  }

  settingsFolderSyncHealthUnavailable(panel, "Folder Sync Health dashboard is Desktop-only. Chrome remains visible-state-only for delete/restore receipts.");
  if (title) title.textContent = "Chrome Sync Folder";
  if (summary) summary.textContent = "Connect the local sync folder, run manual Sync Now, and control existing safe auto-sync triggers.";
  let statusError = "";
  let folder = null;
  let diag = {};
  let rowsAfter = null;
  let counts = null;
  let headlineCounts = null;
  try { folder = W.H2O?.Studio?.sync?.folder || null; }
  catch (err) { statusError = String(err && (err.message || err)); }
  try {
    diag = folder && typeof folder.diagnose === "function"
      ? (folder.diagnose() || {})
      : (folder && typeof folder.status === "function" ? (folder.status() || {}) : {});
  } catch (err) {
    statusError = String(err && (err.message || err));
    diag = {};
  }
  try {
    const allRows = W.H2O?.LibraryIndex?.getAll?.();
    rowsAfter = Array.isArray(allRows) ? allRows.length : null;
    const core = W.H2O?.Library?.LibraryIndexCore || null;
    if (Array.isArray(allRows) && core && typeof core.canonicalHeadlineCounts === "function") {
      headlineCounts = core.canonicalHeadlineCounts(allRows);
    }
  } catch (err) {
    statusError = statusError || String(err && (err.message || err));
  }
  try { counts = W.H2O?.LibraryIndex?.counts?.() || null; }
  catch (err) { statusError = statusError || String(err && (err.message || err)); }
  const rows = [
    ["Runtime", "Chrome/MV3"],
    ["Folder API", folder ? "available" : "unavailable"],
    ["Connected", diag.connected ? "yes" : "no"],
    ["Folder", diag.folderName || ""],
    ["Permission", diag.permission || ""],
    ["Auto sync", diag.autoSyncEnabled ? "enabled" : "disabled"],
    ["Last sync", diag.lastSyncStatus || ""],
    ["Last auto sync", diag.lastAutoSyncStatus || ""],
    ["Last error", diag.lastSyncError || diag.lastAutoSyncError || ""],
    ["Rows", rowsAfter != null ? String(rowsAfter) : ""],
    ["Saved count", headlineCounts ? String(headlineCounts.saved || 0) : (counts && counts.views ? String(counts.views.saved || 0) : "")],
    ["Link count", headlineCounts ? String(headlineCounts.link || 0) : ""],
    ["Archived count", headlineCounts ? String(headlineCounts.archived || 0) : ""],
  ];
  if (statusError) rows.push(["Status error", statusError]);
  if (statusEl) statusEl.innerHTML = settingsSyncRowsHtml(rows);
  if (summary && statusError) summary.textContent = "Chrome sync status loaded with diagnostics warnings.";
  const connectBtn = panel.querySelector("#wbSettingsSyncConnectFolder");
  const disconnectBtn = panel.querySelector("#wbSettingsSyncDisconnectFolder");
  const syncNowBtn = panel.querySelector("#wbSettingsSyncNow");
  const enableBtn = panel.querySelector("#wbSettingsSyncEnableChromeAuto");
  const disableBtn = panel.querySelector("#wbSettingsSyncDisableChromeAuto");
  /* Chrome → chrome-latest.json export button.
   * Enabled only when: (a) the autoImport module is registered,
   * (b) the sync folder is currently connected, and
   * (c) Chrome export is enabled. */
  const chromeExportBtn = panel.querySelector("#wbSettingsSyncChromeExportNow");
  if (chromeExportBtn) {
    const autoImport = W.H2O?.Studio?.sync?.autoImport;
    let flagOn = false;
    try { flagOn = W.H2O?.flags?.get?.("sync.chromeAutoImport", false) === true; }
    catch (_) { flagOn = false; }
    const apiReady = !!(autoImport && typeof autoImport.exportNow === "function");
    chromeExportBtn.disabled = !(apiReady && diag.connected && flagOn);
    chromeExportBtn.title = !apiReady
      ? "autoImport module not loaded"
      : !diag.connected
        ? "Connect the sync folder first."
        : !flagOn
          ? "Chrome export is disabled. Use Enable Chrome Export."
          : "Write h2o.studio.fullBundle.v2 to chrome-latest.json in the connected sync folder.";
  }
  if (connectBtn) connectBtn.disabled = !(folder && typeof folder.connectFolder === "function");
  if (disconnectBtn) disconnectBtn.disabled = !(folder && typeof folder.disconnectFolder === "function" && diag.connected);
  if (syncNowBtn) syncNowBtn.disabled = !(folder && typeof folder.syncNow === "function" && diag.connected);
  if (enableBtn) enableBtn.disabled = !(folder && typeof folder.enableAutoSync === "function") || !!diag.autoSyncEnabled;
  if (disableBtn) disableBtn.disabled = !(folder && typeof folder.disableAutoSync === "function") || !diag.autoSyncEnabled;
  /* Chrome export buttons. The Enable/Disable pair toggles the master
   * Chrome export gate and the event-triggered export binding together. */
  const chromeAutoExportEnableBtn = panel.querySelector("#wbSettingsSyncEnableChromeAutoExport");
  const chromeAutoExportDisableBtn = panel.querySelector("#wbSettingsSyncDisableChromeAutoExport");
  if (chromeAutoExportEnableBtn || chromeAutoExportDisableBtn) {
    const autoImport = W.H2O?.Studio?.sync?.autoImport;
    const apiReady = !!(autoImport && typeof autoImport.enable === "function");
    let masterFlagOn = false;
    let eventTriggerOn = false;
    try { masterFlagOn = W.H2O?.flags?.get?.("sync.chromeAutoImport", false) === true; }
    catch (_) { masterFlagOn = false; }
    try { eventTriggerOn = apiReady && autoImport.isEnabled() === true; }
    catch (_) { eventTriggerOn = false; }
    const chromeExportFullyEnabled = masterFlagOn && eventTriggerOn;
    if (chromeAutoExportEnableBtn) {
      chromeAutoExportEnableBtn.disabled = !apiReady || chromeExportFullyEnabled;
      chromeAutoExportEnableBtn.title = !apiReady
        ? "autoImport module not loaded"
        : chromeExportFullyEnabled
          ? "Already enabled. Use Disable to turn off."
          : "Enable Chrome export to write chrome-latest.json and wire library-save events to autoImport.exportNow().";
    }
    if (chromeAutoExportDisableBtn) {
      chromeAutoExportDisableBtn.disabled = !apiReady || !(masterFlagOn || eventTriggerOn);
    }
  }
}

function bindSettingsSyncControls(panel){
  if (!panel || panel.dataset.syncControlsBound === "1") return;
  panel.dataset.syncControlsBound = "1";

  const run = async (label, fn) => {
    settingsSyncLog(panel, `${label}…`);
    try {
      const result = await fn();
      settingsSyncLog(panel, settingsSummarizeResult(result));
      await refreshSettingsSync(panel);
    } catch (err) {
      settingsSyncLog(panel, `${label} failed.\n${String(err && (err.stack || err.message || err))}`);
      await refreshSettingsSync(panel);
    }
  };

  panel.querySelector("#wbSettingsSyncRefresh")?.addEventListener("click", () => {
    refreshSettingsSync(panel).catch((err) => settingsSyncLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelectorAll("[data-folder-parity-tab]")?.forEach((btn) => {
    btn.addEventListener("click", () => {
      settingsFolderParitySetActiveTab(panel, btn.getAttribute("data-folder-parity-tab"));
    });
  });
  settingsFolderParitySetActiveTab(panel, FOLDER_PARITY_SETTINGS_UI_STATE.activeTab);
  settingsFolderCleanupSetActiveSubtab(panel, FOLDER_PARITY_SETTINGS_UI_STATE.cleanupSubtab);

  panel.querySelector("#wbSettingsFolderParityRefresh")?.addEventListener("click", () => {
    refreshSettingsFolderParity(panel).catch((err) => {
      settingsFolderParitySetOperationStatus(panel, "folderDiagnostics", "failed", "Refresh failed");
      settingsFolderParityLog(panel, String(err && (err.stack || err.message || err)));
    });
  });

  panel.querySelector("#wbSettingsFolderParityCopy")?.addEventListener("click", () => {
    copySettingsFolderParityReport(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderMirrorRefreshPick")?.addEventListener("click", async () => {
    const invoke = STUDIO_getTauriInvoke();
    if (!invoke) {
      settingsFolderParityLog(panel, "Choose file unavailable: Tauri invoke not present.");
      return;
    }
    try {
      const picked = await invoke("plugin:dialog|open", {
        options: {
          multiple: false,
          directory: false,
          filters: [{ name: "JSON folder-state", extensions: ["json"] }],
        },
      });
      if (picked == null) return;
      const pathStr = (typeof picked === "string") ? picked
        : (picked && typeof picked.path === "string") ? picked.path
        : "";
      if (!pathStr) {
        settingsFolderParityLog(panel, "Choose file: unexpected picker response shape: " + JSON.stringify(picked).slice(0, 200));
        return;
      }
      const input = panel.querySelector("#wbSettingsFolderMirrorRefreshPath");
      if (input) input.value = pathStr;
      FOLDER_DESKTOP_MIRROR_REFRESH_STATE.path = pathStr;
      settingsFolderMirrorSetPreview(panel, null);
      settingsFolderMirrorUpdateControls(panel);
    } catch (err) {
      settingsFolderParityLog(panel, "Choose file failed.\n" + String(err && (err.stack || err.message || err)));
    }
  });

  panel.querySelector("#wbSettingsFolderMirrorRefreshPath")?.addEventListener("input", () => {
    FOLDER_DESKTOP_MIRROR_REFRESH_STATE.path = String(panel.querySelector("#wbSettingsFolderMirrorRefreshPath")?.value || "");
    settingsFolderMirrorSetPreview(panel, null);
    settingsFolderMirrorUpdateControls(panel);
  });

  panel.querySelector("#wbSettingsFolderMirrorRefreshJson")?.addEventListener("input", () => {
    FOLDER_DESKTOP_MIRROR_REFRESH_STATE.pastedJson = String(panel.querySelector("#wbSettingsFolderMirrorRefreshJson")?.value || "");
    settingsFolderMirrorSetPreview(panel, null);
    settingsFolderMirrorUpdateControls(panel);
  });

  panel.querySelector("#wbSettingsFolderMirrorRefreshConfirm")?.addEventListener("input", () => {
    FOLDER_DESKTOP_MIRROR_REFRESH_STATE.confirmation = String(panel.querySelector("#wbSettingsFolderMirrorRefreshConfirm")?.value || "");
    settingsFolderMirrorUpdateControls(panel);
  });

  panel.querySelector("#wbSettingsFolderMirrorRefreshPreview")?.addEventListener("click", () => {
    previewSettingsFolderMirrorRefresh(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderMirrorRefreshCopyPlan")?.addEventListener("click", () => {
    copySettingsFolderMirrorRefreshPlan(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderMirrorRefreshRun")?.addEventListener("click", () => {
    refreshDesktopFolderMirror(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });
  settingsFolderMirrorUpdateControls(panel);

  panel.querySelector("#wbSettingsFolderCleanupReviewRefresh")?.addEventListener("click", () => {
    refreshSettingsFolderCleanupReview(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderCleanupReviewCopy")?.addEventListener("click", () => {
    copySettingsFolderCleanupReviewPlan(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderCleanupReview")?.addEventListener("change", (ev) => {
    const target = ev.target;
    if (!target || target.getAttribute?.("data-folder-cleanup-dry-run-select") !== "1") return;
    const folderId = String(target.getAttribute("data-folder-id") || "").trim();
    if (folderId) {
      panel.querySelectorAll("[data-folder-cleanup-dry-run-select='1'][data-folder-id]").forEach((input) => {
        if (String(input.getAttribute("data-folder-id") || "").trim() !== folderId) return;
        if (input !== target) input.checked = !!target.checked;
      });
    }
    settingsFolderCleanupDryRunSelectedIds(panel);
    panel.__h2oFolderCleanupDryRunPlan = null;
    FOLDER_PARITY_SETTINGS_UI_STATE.cleanupDryRunPlan = null;
    const summary = panel.querySelector("#wbSettingsFolderCleanupDryRunSummary");
    const rows = panel.querySelector("#wbSettingsFolderCleanupDryRunRows");
    const selectedRows = panel.querySelector("#wbSettingsFolderCleanupDryRunSelectedRows");
    const reasonCodes = panel.querySelector("#wbSettingsFolderCleanupDryRunReasonCodes");
    const json = panel.querySelector("#wbSettingsFolderCleanupDryRunJson");
    const copy = panel.querySelector("#wbSettingsFolderCleanupDryRunCopy");
    if (summary) summary.textContent = "Selection changed. Generate a fresh dry-run plan. No cleanup is performed.";
    if (rows) rows.innerHTML = "";
    if (selectedRows) selectedRows.innerHTML = "";
    if (reasonCodes) reasonCodes.innerHTML = "";
    if (json) {
      json.hidden = true;
      json.textContent = "";
    }
    if (copy) copy.disabled = true;
    settingsFolderCleanupClearApplyPreview(panel);
  });

  panel.querySelector("#wbSettingsFolderCleanupDryRunGenerate")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    generateSettingsFolderCleanupDryRunPlan(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderCleanupDryRunCopy")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    copySettingsFolderCleanupDryRunPlan(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderCleanupApplyPreviewGenerate")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    generateSettingsFolderCleanupApplyPreview(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderCleanupApplyPreviewCopy")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    copySettingsFolderCleanupApplyPreview(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderConflictRefresh")?.addEventListener("click", () => {
    refreshSettingsFolderConflictReview(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderConflictCopy")?.addEventListener("click", () => {
    copySettingsFolderConflictPlan(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderDesktopReviewRefresh")?.addEventListener("click", () => {
    refreshSettingsFolderDesktopReview(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderDesktopReviewCopy")?.addEventListener("click", () => {
    copySettingsFolderDesktopReviewReport(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderDesktopOrphanBindingRefresh")?.addEventListener("click", () => {
    refreshSettingsFolderDesktopOrphanBindingReview(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderDesktopOrphanBindingCopy")?.addEventListener("click", () => {
    copySettingsFolderDesktopOrphanBindingReport(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderDesktopOrphanBindingRemoveList")?.addEventListener("change", () => {
    const selected = settingsFolderDesktopOrphanBindingSelected(panel);
    const wasSelected = !!FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.selected;
    FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.selected = !!selected;
    if (!selected || wasSelected !== !!selected) {
      FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.preview = null;
      panel.__h2oFolderDesktopOrphanBindingRemovalPreview = null;
    }
    const previewEl = panel.querySelector("#wbSettingsFolderDesktopOrphanBindingRemovePreview");
    if (previewEl && !FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.preview) {
      previewEl.hidden = true;
      previewEl.textContent = "";
    }
    settingsFolderDesktopUpdateOrphanBindingRemovalControls(panel);
  });

  panel.querySelector("#wbSettingsFolderDesktopOrphanBindingRemoveConfirm")?.addEventListener("input", () => {
    FOLDER_DESKTOP_ORPHAN_BINDING_REMOVE_STATE.confirmation = String(panel.querySelector("#wbSettingsFolderDesktopOrphanBindingRemoveConfirm")?.value || "");
    settingsFolderDesktopUpdateOrphanBindingRemovalControls(panel);
  });

  panel.querySelector("#wbSettingsFolderDesktopOrphanBindingPreviewRemove")?.addEventListener("click", () => {
    previewSettingsFolderDesktopOrphanBindingRemoval(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderDesktopOrphanBindingCopyRemovePlan")?.addEventListener("click", () => {
    copySettingsFolderDesktopOrphanBindingRemovalPlan(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderDesktopOrphanBindingRemoveSelected")?.addEventListener("click", () => {
    removeSelectedOrphanDesktopBinding(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderDesktopDeleteList")?.addEventListener("change", () => {
    panel.__h2oFolderDesktopDeletionPreview = null;
    const previewEl = panel.querySelector("#wbSettingsFolderDesktopDeletePreview");
    if (previewEl) {
      previewEl.hidden = true;
      previewEl.textContent = "";
    }
    settingsFolderDesktopUpdateDeleteControls(panel);
  });

  panel.querySelector("#wbSettingsFolderDesktopDeleteConfirm")?.addEventListener("input", () => {
    settingsFolderDesktopUpdateDeleteControls(panel);
  });

  panel.querySelector("#wbSettingsFolderDesktopPreviewDelete")?.addEventListener("click", () => {
    previewSettingsFolderDesktopDeletion(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderDesktopCopyDeletePlan")?.addEventListener("click", () => {
    copySettingsFolderDesktopDeletionPlan(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderDesktopDeleteSelected")?.addEventListener("click", () => {
    deleteSelectedEmptyDesktopFolders(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderConflictDeleteList")?.addEventListener("change", () => {
    panel.__h2oFolderConflictDeletionPreview = null;
    const previewEl = panel.querySelector("#wbSettingsFolderConflictDeletePreview");
    if (previewEl) {
      previewEl.hidden = true;
      previewEl.textContent = "";
    }
    settingsFolderConflictUpdateDeleteControls(panel);
  });

  panel.querySelector("#wbSettingsFolderConflictDeleteConfirm")?.addEventListener("input", () => {
    settingsFolderConflictUpdateDeleteControls(panel);
  });

  panel.querySelector("#wbSettingsFolderConflictPreviewDelete")?.addEventListener("click", () => {
    previewSettingsFolderConflictDeletion(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderConflictCopyDeletePlan")?.addEventListener("click", () => {
    copySettingsFolderConflictDeletionPlan(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderConflictDeleteSelected")?.addEventListener("click", () => {
    deleteSelectedEmptyDuplicateConflictFolders(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderCleanupDeleteList")?.addEventListener("change", () => {
    panel.__h2oFolderCleanupDeletionPreview = null;
    const previewEl = panel.querySelector("#wbSettingsFolderCleanupDeletePreview");
    if (previewEl) {
      previewEl.hidden = true;
      previewEl.textContent = "";
    }
    settingsFolderCleanupUpdateDeleteControls(panel);
  });

  panel.querySelector("#wbSettingsFolderCleanupConfirm")?.addEventListener("input", () => {
    settingsFolderCleanupUpdateDeleteControls(panel);
  });

  panel.querySelector("#wbSettingsFolderCleanupPreview")?.addEventListener("click", () => {
    previewSettingsFolderCleanupDeletion(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderCleanupCopyDeletePlan")?.addEventListener("click", () => {
    copySettingsFolderCleanupDeletionPlan(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsFolderCleanupDeleteSelected")?.addEventListener("click", () => {
    deleteSelectedSafeChromeMirrorFolders(panel).catch((err) => settingsFolderParityLog(panel, String(err && (err.stack || err.message || err))));
  });

  panel.querySelector("#wbSettingsSyncExportLatest")?.addEventListener("click", () => run("Writing latest sync bundle", async () => {
    const fn = W.H2O?.Studio?.ingestion?.exportLatestSyncBundle;
    if (typeof fn !== "function") throw new Error("exportLatestSyncBundle unavailable");
    return fn({ reason: "settings-ui" });
  }));

  panel.querySelector("#wbSettingsSyncEnableDesktopAuto")?.addEventListener("click", () => run("Enabling Desktop auto-export", async () => {
    const fn = W.H2O?.Studio?.sync?.autoExport?.enable;
    if (typeof fn !== "function") throw new Error("autoExport.enable unavailable");
    return fn();
  }));

  panel.querySelector("#wbSettingsSyncDisableDesktopAuto")?.addEventListener("click", () => run("Disabling Desktop auto-export", async () => {
    const fn = W.H2O?.Studio?.sync?.autoExport?.disable;
    if (typeof fn !== "function") throw new Error("autoExport.disable unavailable");
    return fn();
  }));

  /* R3 phase 2 — Desktop focus-triggered import opt-in. */
  panel.querySelector("#wbSettingsSyncEnableDesktopFocusImport")?.addEventListener("click", () => run("Enabling Desktop import on focus", async () => {
    const fn = W.H2O?.Studio?.sync?.focusImport?.enable;
    if (typeof fn !== "function") throw new Error("focusImport.enable unavailable");
    return fn();
  }));

  panel.querySelector("#wbSettingsSyncDisableDesktopFocusImport")?.addEventListener("click", () => run("Disabling Desktop import on focus", async () => {
    const fn = W.H2O?.Studio?.sync?.focusImport?.disable;
    if (typeof fn !== "function") throw new Error("focusImport.disable unavailable");
    return fn();
  }));

  panel.querySelector("#wbSettingsSyncConnectFolder")?.addEventListener("click", () => run("Connecting sync folder", async () => {
    const fn = W.H2O?.Studio?.sync?.folder?.connectFolder;
    if (typeof fn !== "function") throw new Error("folder.connectFolder unavailable");
    return fn();
  }));

  panel.querySelector("#wbSettingsSyncDisconnectFolder")?.addEventListener("click", () => run("Disconnecting sync folder", async () => {
    const fn = W.H2O?.Studio?.sync?.folder?.disconnectFolder;
    if (typeof fn !== "function") throw new Error("folder.disconnectFolder unavailable");
    return fn();
  }));

  panel.querySelector("#wbSettingsSyncNow")?.addEventListener("click", () => run("Running Sync Now", async () => {
    const fn = W.H2O?.Studio?.sync?.folder?.syncNow;
    if (typeof fn !== "function") throw new Error("folder.syncNow unavailable");
    return fn({ reason: "settings-ui" });
  }));

  /* R3 phase 1 — Chrome → chrome-latest.json export. The click runs
   * inside the existing user-gesture stack, which is what File System
   * Access requires for the readwrite-permission re-prompt inside
   * autoImport.exportNow(). Flag-off and folder-disconnected states are
   * already gated by the disabled-state logic in refreshSettingsSync;
   * the runtime guard in exportNow() is the load-bearing one. */
  panel.querySelector("#wbSettingsSyncChromeExportNow")?.addEventListener("click", () => run("Exporting Chrome bundle to sync folder", async () => {
    const fn = W.H2O?.Studio?.sync?.autoImport?.exportNow;
    if (typeof fn !== "function") throw new Error("autoImport.exportNow unavailable");
    return fn({ reason: "settings-ui" });
  }));

  panel.querySelector("#wbSettingsSyncEnableChromeAuto")?.addEventListener("click", () => run("Enabling Chrome auto-sync", async () => {
    const fn = W.H2O?.Studio?.sync?.folder?.enableAutoSync;
    if (typeof fn !== "function") throw new Error("folder.enableAutoSync unavailable");
    return fn();
  }));

  panel.querySelector("#wbSettingsSyncDisableChromeAuto")?.addEventListener("click", () => run("Disabling Chrome auto-sync", async () => {
    const fn = W.H2O?.Studio?.sync?.folder?.disableAutoSync;
    if (typeof fn !== "function") throw new Error("folder.disableAutoSync unavailable");
    return fn();
  }));

  /* Chrome export opt-in. Toggles the master chrome-latest.json export
   * gate and binds/unbinds the library-save event listeners together. */
  panel.querySelector("#wbSettingsSyncEnableChromeAutoExport")?.addEventListener("click", () => run("Enabling Chrome export", async () => {
    const fn = W.H2O?.Studio?.sync?.autoImport?.enable;
    if (typeof fn !== "function") throw new Error("autoImport.enable unavailable");
    return fn();
  }));

  panel.querySelector("#wbSettingsSyncDisableChromeAutoExport")?.addEventListener("click", () => run("Disabling Chrome export", async () => {
    const fn = W.H2O?.Studio?.sync?.autoImport?.disable;
    if (typeof fn !== "function") throw new Error("autoImport.disable unavailable");
    return fn();
  }));

  /* Phase H — native file picker. Calls tauri-plugin-dialog's open
   * command (capability: dialog:allow-open). Select-only: the picker
   * returns an absolute path; we write it into the existing path input
   * and stop. No auto-import — the user still must click Import
   * folder-state below. Intentionally outside the run() helper because
   * there is no result to summarize and refreshing the status grid
   * after a select-only operation is wasted work. Errors and
   * unexpected-shape responses are written to the existing sync log. */
  panel.querySelector("#wbSettingsSyncFolderStatePickBtn")?.addEventListener("click", async () => {
    const invoke = STUDIO_getTauriInvoke();
    if (!invoke) {
      settingsSyncLog(panel, "Choose file unavailable: Tauri invoke not present (non-Desktop runtime?).");
      return;
    }
    try {
      const picked = await invoke("plugin:dialog|open", {
        options: {
          multiple: false,
          directory: false,
          filters: [{ name: "JSON folder-state", extensions: ["json"] }],
        },
      });
      if (picked == null) {
        /* User cancelled the OS picker — leave the path input as-is.
         * Silent; no log noise. */
        return;
      }
      /* Tauri V2 dialog returns string for single-file selection in
       * current builds; future builds may wrap it as { path, name }.
       * Probe both shapes. Anything else is logged as unexpected. */
      const pathStr = (typeof picked === "string") ? picked
                    : (picked && typeof picked.path === "string") ? picked.path
                    : "";
      if (!pathStr) {
        settingsSyncLog(panel, "Choose file: unexpected picker response shape: " + JSON.stringify(picked).slice(0, 200));
        return;
      }
      const input = panel.querySelector("#wbSettingsSyncFolderStatePath");
      if (input) input.value = pathStr;
      /* Phase I — persist the picked path so the next Settings render
       * pre-fills the input with this value instead of the hardcoded
       * runbook default. Only persisted on successful pick (we already
       * returned early on cancel and on unexpected-shape). Errors are
       * swallowed inside the helper. */
      STUDIO_settingsWriteFolderStateLastPath(pathStr);
    } catch (err) {
      settingsSyncLog(panel, "Choose file failed.\n" + String((err && (err.message || err)) || err));
    }
  });

  /* Phase E — manual folder-state JSON import. Routes through the
   * already-proven H2O.Studio.sync.importFromFile() (Phase B); attaches
   * the orphan-binding sample from diagnose() (Phase D) to the result
   * so settingsSummarizeResult renders it inline. The Phase H picker
   * above only writes to the path input; this Import handler runs the
   * actual import on explicit click. */
  panel.querySelector("#wbSettingsSyncFolderStateImportBtn")?.addEventListener("click", () => run("Importing folder-state JSON", async () => {
    const sync = W.H2O?.Studio?.sync;
    if (!sync || typeof sync.importFromFile !== "function") {
      throw new Error("H2O.Studio.sync.importFromFile unavailable");
    }
    const input = panel.querySelector("#wbSettingsSyncFolderStatePath");
    const path = String((input && input.value) || "").trim();
    if (!path) throw new Error("Path required — paste an absolute path to the folder-state JSON file.");
    /* Phase I — best-effort persistence on import attempt so a
     * manually-typed (not-picked) path is also remembered for the next
     * Settings render. Fire-and-forget; storage failures don't block
     * the import. Writes happen before the import call so the value is
     * captured even if the import then fails (e.g. read-failed). */
    STUDIO_settingsWriteFolderStateLastPath(path);
    const result = await sync.importFromFile(path);
    /* Read Phase D state so the log can show a small orphan sample
     * alongside the wrapper summary. Diagnose is sync; never throws. */
    try {
      if (result && typeof result === "object" && typeof sync.diagnose === "function") {
        const d = sync.diagnose() || {};
        const st = (d && d.state) || {};
        const sample = Array.isArray(st.lastImportOrphanBindingSample) ? st.lastImportOrphanBindingSample : [];
        /* Cap at 3 for the inline log; the full sample (up to 5) remains
         * accessible via H2O.Studio.sync.diagnose() in DevTools. */
        result.orphanSample = sample.slice(0, 3);
      }
    } catch (_) { /* ignore — diagnostic enrichment, never blocks the return */ }
    return result;
  }));
}

function renderMigrateRoute(actionRaw){
  const action = String(actionRaw || "").toLowerCase();
  migrateRouteHideOtherPanels();
  setRouteMeta("Migrate", action === "export" ? "Export Bundle" : "Import Bundle",
    "Move all Studio data between extension IDs · Phase 2 migration");
  const panel = migrateOverlayEnsure();
  if (!panel) return;
  panel.hidden = false;
  // Idempotency guard: renderRoute fires on hashchange AND on every window
  // focus / visibilitychange (refreshFromForeground). Opening the OS file
  // picker steals focus, so when the user picks a file the Studio window
  // re-focuses and renderRoute runs again — re-entering this function. Without
  // this guard, we would wipe the file <input> element and its change
  // listener (plus the closure that holds `parsedBundle`) BEFORE the browser
  // delivers the change event. The user's pick would vanish silently.
  // Solution: track the currently rendered action on the panel itself; bail
  // out early when re-entering for the same action. The DOM + closures stay
  // intact so the file picker's change event lands on the live listener.
  if (panel.dataset.migrateActiveAction === action && panel.firstChild) {
    return;
  }
  panel.dataset.migrateActiveAction = action;
  panel.innerHTML = "";

  const meta = migrateExtensionLabel();
  const header = document.createElement("div");
  header.innerHTML = `
    <h2 style="margin:0 0 4px;font-size:20px;font-weight:600">Studio Migration · ${esc(action === "export" ? "Export" : "Import")}</h2>
    <div style="margin:0 0 16px;opacity:.75;font-size:12px">Active extension: <code style="background:rgba(255,255,255,.06);padding:2px 6px;border-radius:4px">${esc(meta.label)}</code></div>
    <p style="margin:0 0 18px;opacity:.85">${
      action === "export"
        ? "Generate a full Studio bundle (chats, snapshots, folders, projects, labels, categories, highlights, library KV, UI prefs). Auth tokens are <strong>not</strong> exported. Run this on the <em>source</em> extension."
        : "Apply a previously exported Studio bundle to <strong>this</strong> extension. The flow is: pick file → dry-run → auto-backup current data → confirm import. Existing prod data is never overwritten in merge mode."
    }</p>
  `;
  panel.appendChild(header);

  if (action === "export") renderMigrateExport(panel);
  else renderMigrateImport(panel);
}

function renderMigrateExport(panel){
  const log = document.createElement("pre");
  log.style.cssText = "white-space:pre-wrap;background:rgba(0,0,0,.18);padding:12px;border-radius:6px;max-height:280px;overflow:auto;font-size:12px;line-height:1.45;margin:12px 0";
  log.textContent = "Ready.";

  const btn = document.createElement("button");
  btn.className = "wbBtn";
  btn.textContent = "Export Full Studio Bundle";
  btn.style.cssText = "padding:8px 16px;font-weight:600;cursor:pointer";

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    log.textContent = "Exporting… (reading chat archive, chrome.storage.local, library-kv)";
    try {
      const ab = migrateGetArchiveBoot();
      const t0 = performance.now();
      const bundle = await ab.exportFullBundle({});
      const ms = Math.round(performance.now() - t0);
      const summary = bundle && bundle.summary ? bundle.summary : {};
      log.textContent = [
        `Exported in ${ms}ms.`,
        `  schema:             ${bundle?.schema || "(missing)"}`,
        `  exportedAt:         ${bundle?.exportedAt || "(missing)"}`,
        `  fromExtensionId:    ${bundle?.exportedFromExtensionId || "(missing)"}`,
        `  fromExtensionName:  ${bundle?.exportedFromExtensionName || "(missing)"}`,
        `  chats:              ${summary.chatCount || 0}`,
        `  snapshots:          ${summary.snapshotCount || 0}`,
        `  categories:         ${summary.categoryCount || 0}`,
        `  labels:             ${summary.labelCount || 0}`,
        `  chromeStorage keys: ${summary.chromeStorageKeyCount || 0}`,
        `  libraryKv keys:     ${summary.libraryKvKeyCount || 0}`,
        ``,
        `Downloading…`,
      ].join("\n");
      const filename = `h2o-studio-full-bundle__${(bundle?.exportedFromExtensionId || "unknown").slice(0,8)}__${migrateBuildTimestamp()}.json`;
      migrateDownloadJson(filename, bundle);
      log.textContent += `\nSaved as ${filename}`;
    } catch (err) {
      log.textContent = "Export FAILED.\n" + String(err && (err.stack || err.message || err));
    } finally {
      btn.disabled = false;
    }
  });

  panel.appendChild(btn);
  panel.appendChild(log);
}

function renderMigrateImport(panel){
  let parsedBundle = null;
  let bundleFilename = "";
  let dryRun = null;
  let backupSaved = false;

  const log = document.createElement("pre");
  log.style.cssText = "white-space:pre-wrap;background:rgba(0,0,0,.18);padding:12px;border-radius:6px;max-height:360px;overflow:auto;font-size:12px;line-height:1.45;margin:12px 0";
  log.textContent = "Step 1: pick a bundle file.";

  const fileWrap = document.createElement("div");
  fileWrap.style.cssText = "display:flex;gap:8px;align-items:center;margin:8px 0";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "application/json,.json";
  fileWrap.appendChild(fileInput);
  panel.appendChild(fileWrap);

  const btnDry = document.createElement("button");
  btnDry.className = "wbBtn";
  btnDry.textContent = "2. Dry-run validate";
  btnDry.disabled = true;
  btnDry.style.cssText = "margin:0 8px 0 0;padding:8px 16px;cursor:pointer";

  const btnBackup = document.createElement("button");
  btnBackup.className = "wbBtn";
  btnBackup.textContent = "3. Backup current data (auto-download)";
  btnBackup.disabled = true;
  btnBackup.style.cssText = "margin:0 8px 0 0;padding:8px 16px;cursor:pointer";

  const btnImport = document.createElement("button");
  btnImport.className = "wbBtn";
  btnImport.textContent = "4. Confirm import (merge mode)";
  btnImport.disabled = true;
  btnImport.style.cssText = "padding:8px 16px;font-weight:600;cursor:pointer;background:rgba(13,148,136,.18);border-color:rgba(13,148,136,.6)";

  panel.appendChild(btnDry);
  panel.appendChild(btnBackup);
  panel.appendChild(btnImport);
  panel.appendChild(log);

  const onFilePicked = async (ev) => {
    // Diagnostic: log to console too so any silent-failure case surfaces in
    // DevTools regardless of whether the UI log is intact.
    try { console.log("[H2O/Migrate] file change event fired", { hasFiles: !!(fileInput.files && fileInput.files.length) }); } catch {}
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      log.textContent = "No file picked (file input cleared or selection cancelled).";
      return;
    }
    log.textContent = `File selected: ${file.name} (${(file.size || 0).toLocaleString()} bytes). Parsing…`;
    bundleFilename = file.name;
    parsedBundle = null;
    dryRun = null;
    backupSaved = false;
    btnDry.disabled = true;
    btnBackup.disabled = true;
    btnImport.disabled = true;
    try {
      const text = await file.text();
      let obj;
      try {
        obj = JSON.parse(text);
      } catch (parseErr) {
        throw new Error(`JSON parse failed: ${parseErr && (parseErr.message || parseErr)}`);
      }
      const schema = String(obj && obj.schema || "(missing)");
      if (schema !== "h2o.studio.fullBundle.v2" && schema !== "h2o.chatArchive.bundle.v1") {
        throw new Error(`Unrecognized bundle schema: ${schema}. Expected "h2o.studio.fullBundle.v2" or "h2o.chatArchive.bundle.v1".`);
      }
      parsedBundle = obj;
      const summary = obj.summary || {};
      log.textContent = [
        `File parsed successfully.`,
        ``,
        `  filename:           ${file.name}`,
        `  bytes:              ${(file.size || 0).toLocaleString()}`,
        `  schema:             ${schema}`,
        `  exportedAt:         ${obj.exportedAt || "(missing)"}`,
        `  fromExtensionId:    ${obj.exportedFromExtensionId || "(legacy v1 bundle — no extension id)"}`,
        `  fromExtensionName:  ${obj.exportedFromExtensionName || "(legacy v1 bundle — no name)"}`,
        `  fromVersion:        ${obj.exportedFromVersion || "(missing)"}`,
        ``,
        `Summary (as stored in bundle):`,
        `  chats:              ${summary.chatCount ?? "(not summarized)"}`,
        `  snapshots:          ${summary.snapshotCount ?? "(not summarized)"}`,
        `  categories:         ${summary.categoryCount ?? "(not summarized)"}`,
        `  labels:             ${summary.labelCount ?? "(not summarized)"}`,
        `  chromeStorage keys: ${summary.chromeStorageKeyCount ?? "(not summarized)"}`,
        `  libraryKv keys:     ${summary.libraryKvKeyCount ?? "(not summarized)"}`,
        ``,
        `Step 2 is now available. Click "Dry-run validate" — nothing will be written.`,
      ].join("\n");
      btnDry.disabled = false;
      try { console.log("[H2O/Migrate] bundle accepted; dry-run enabled"); } catch {}
    } catch (err) {
      parsedBundle = null;
      const msg = String(err && (err.stack || err.message || err));
      log.textContent = `Bundle rejected.\n${msg}\n\nTry a different file. (No data was written; this is the file-select step.)`;
      try { console.warn("[H2O/Migrate] bundle parse/validate failed", err); } catch {}
    }
  };
  fileInput.addEventListener("change", onFilePicked);
  // Defense in depth for some Chromium edge cases where re-picking the same
  // filename doesn't refire "change" — also listen to "input".
  fileInput.addEventListener("input", onFilePicked);

  btnDry.addEventListener("click", async () => {
    if (!parsedBundle) return;
    btnDry.disabled = true;
    log.textContent = "Running dry-run on this extension's storage… (no writes)";
    try {
      const ab = migrateGetArchiveBoot();
      dryRun = await ab.dryRunImportFullBundle({ bundle: parsedBundle });
      const p = dryRun.plan || {};
      log.textContent = [
        `Dry-run report (NO WRITES PERFORMED):`,
        ``,
        `Chats:`,
        `  incoming chats:        ${p.chats?.incoming || 0}`,
        `  incoming snapshots:    ${p.chats?.incomingSnapshots || 0}`,
        `  will import:           ${p.chats?.willImport || 0}`,
        `  will skip (duplicate): ${p.chats?.willSkipDuplicates || 0}`,
        ``,
        `chrome.storage.local:`,
        `  incoming keys:         ${p.chromeStorageLocal?.incoming || 0}`,
        `  will import:           ${p.chromeStorageLocal?.willImport || 0}`,
        `  will skip (duplicate): ${p.chromeStorageLocal?.willSkipDuplicates || 0}`,
        `  denied by policy:      ${p.chromeStorageLocal?.deniedByPolicy || 0}  (auth/dev-only keys)`,
        ``,
        `library-kv (IndexedDB):`,
        `  incoming keys:         ${p.libraryKv?.incoming || 0}`,
        `  will import:           ${p.libraryKv?.willImport || 0}`,
        `  will skip (duplicate): ${p.libraryKv?.willSkipDuplicates || 0}`,
        `  denied by policy:      ${p.libraryKv?.deniedByPolicy || 0}`,
        ``,
        `Sample IDs (first 10):`,
        `  new chats:    ${(dryRun.sample?.newChatIds || []).join(", ") || "(none)"}`,
        `  dup chats:    ${(dryRun.sample?.dupChatIds || []).join(", ") || "(none)"}`,
        ``,
        `Step 3: click "Backup current data" before confirming the import.`,
      ].join("\n");
      btnBackup.disabled = false;
    } catch (err) {
      log.textContent = "Dry-run FAILED.\n" + String(err && (err.stack || err.message || err));
      btnDry.disabled = false;
    }
  });

  btnBackup.addEventListener("click", async () => {
    btnBackup.disabled = true;
    log.textContent += "\n\nGenerating pre-import backup of THIS extension…";
    try {
      const ab = migrateGetArchiveBoot();
      const bundle = await ab.exportFullBundle({});
      const filename = `h2o-studio-PROD-pre-import-backup__${(bundle?.exportedFromExtensionId || "unknown").slice(0,8)}__${migrateBuildTimestamp()}.json`;
      migrateDownloadJson(filename, bundle);
      backupSaved = true;
      log.textContent += `\nBackup saved as ${filename}.`;
      log.textContent += `\n\nStep 4: click "Confirm import" to merge incoming data.`;
      log.textContent += `\n(Existing records in this extension are preserved; only NEW chats/keys are written.)`;
      btnImport.disabled = false;
    } catch (err) {
      log.textContent += "\nBackup FAILED — refusing to proceed with import.\n" + String(err && (err.stack || err.message || err));
      btnBackup.disabled = false;
    }
  });

  btnImport.addEventListener("click", async () => {
    if (!parsedBundle || !backupSaved) return;
    if (!confirm("Apply this bundle to the current extension in MERGE mode?\n\nExisting records are preserved. Only new chats/keys will be added.\n\nThis cannot be undone except by restoring the backup file you just downloaded.")) {
      return;
    }
    btnImport.disabled = true;
    log.textContent += "\n\nImporting… (merge mode)";
    try {
      const ab = migrateGetArchiveBoot();
      const t0 = performance.now();
      const result = await ab.importFullBundle({ bundle: parsedBundle, mode: "merge" });
      const ms = Math.round(performance.now() - t0);
      log.textContent += [
        ``,
        `Import complete in ${ms}ms.`,
        ``,
        `Chats:                ${result.chats?.importedChats || 0} imported, ${result.chats?.importedSnapshots || 0} snapshots`,
        `chrome.storage.local: ${result.chromeStorageLocal?.written || 0} written, ${result.chromeStorageLocal?.skipped || 0} skipped`,
        `library-kv:           ${result.libraryKv?.written || 0} written, ${result.libraryKv?.skipped || 0} skipped${result.libraryKv?.errors?.length ? `, ${result.libraryKv.errors.length} errors` : ""}`,
        ``,
        `Reload the Studio tab (or navigate to #/library/explorer) to see the imported data.`,
      ].join("\n");
      // Notify the rest of Studio so live views refresh.
      try { W.dispatchEvent(new CustomEvent("evt:h2o:data:backup:imported", { detail: { source: "migrate-import", result } })); } catch {}
    } catch (err) {
      log.textContent += "\nImport FAILED.\n" + String(err && (err.stack || err.message || err));
      btnImport.disabled = false;
    }
  });
}

// ── LibraryIndex-driven list/sidebar refresh ────────────────────────────────
// Workbench list rows and sidebar Recents can both be sourced from
// H2O.LibraryIndex. Listen on Chrome and Desktop so the canonical recent
// projection replaces the static loading placeholder as soon as the index is
// ready, without forcing full route remounts on non-list pages.
//
// Debounced 200 ms so multi-write batches coalesce into one re-render.
let libraryIndexWorkbenchRefreshTimer = 0;
function scheduleLibraryIndexWorkbenchRefresh(){
  clearTimeout(libraryIndexWorkbenchRefreshTimer);
  libraryIndexWorkbenchRefreshTimer = W.setTimeout(() => {
    libraryIndexWorkbenchRefreshTimer = 0;
    state.rowsCache = null;
    refreshSidebarChatList(state.lastView, state.lastFolderId);
    const route = parseHash();
    if (route.name === "read") {
      state.rowsCacheInvalidatedWhileReading = true;
      return;
    }
    if (route.name === "list") renderRoute().catch(console.error);
  }, 200);
}

function subscribeLibraryIndexToWorkbenchCache(attempt = 0){
  if (subscribeLibraryIndexToWorkbenchCache._installed) return;
  const li = W.H2O && W.H2O.LibraryIndex;
  if (!li || typeof li.subscribe !== 'function') {
    if (attempt < 80 && !subscribeLibraryIndexToWorkbenchCache._retryTimer) {
      subscribeLibraryIndexToWorkbenchCache._retryTimer = W.setTimeout(() => {
        subscribeLibraryIndexToWorkbenchCache._retryTimer = null;
        subscribeLibraryIndexToWorkbenchCache(attempt + 1);
      }, 250);
    }
    return;
  }
  try {
    li.subscribe(scheduleLibraryIndexWorkbenchRefresh);
    subscribeLibraryIndexToWorkbenchCache._installed = true;
    scheduleLibraryIndexWorkbenchRefresh();
  } catch (e) {
    try { console.warn('[H2O.Studio] subscribeLibraryIndexToWorkbenchCache failed', e); } catch {}
  }
}

function boot(){
  readUiPrefs();
  applyUiState();
  subscribeLibraryIndexToWorkbenchCache();

  $("#refreshBtn")?.addEventListener("click", () => {
    state.rowsCache = null;
    state.folderCatalog = [];
    state.folderLocalReview = [];
    state.folderBindingsByChat = {};
    renderRoute({ force: true }).catch(console.error);
  });

  $("#sidebarCollapseBtn")?.addEventListener("click", closeSidebar);
  $("#railSidebarBtn")?.addEventListener("click", openSidebar);
  $("#railNewNoteBtn")?.addEventListener("click", (ev) => {
    ev.preventDefault();
  });
  $("#railSearchBtn")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    openRailSearchOverlay();
  });
  $("#railLibraryBtn")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    closeRailSurfaces();
    closeDockSidebarModeIfOpen();
    if (location.hash !== "#/library/dashboard") location.hash = "#/library/dashboard";
  });
  $("#railFoldersBtn")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    openRailPopover("folders", ev.currentTarget);
  });
  $("#railRecentsBtn")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    openRailPopover("recents", ev.currentTarget);
  });
  $("#wbRailSearchCloseBtn")?.addEventListener("click", closeRailSearchOverlay);
  $("#wbRailSearchInput")?.addEventListener("input", renderRailSearchResults);
  $("#wbRailSearchOverlay")?.addEventListener("click", (ev) => {
    if (ev.target === ev.currentTarget) closeRailSearchOverlay();
  });
  $("#wbRailPopover")?.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target.closest("[data-rail-href]") : null;
    if (!target) return;
    const href = String(target.getAttribute("data-rail-href") || "").trim();
    if (!href) return;
    closeRailSurfaces();
    closeDockSidebarModeIfOpen();
    if (location.hash !== href) location.hash = href;
  });
  $("#wbRailSearchResults")?.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target.closest("[data-rail-href]") : null;
    if (!target) return;
    const href = String(target.getAttribute("data-rail-href") || "").trim();
    if (!href) return;
    closeRailSurfaces();
    closeDockSidebarModeIfOpen();
    if (location.hash !== href) location.hash = href;
  });
  $("#folderAssignSelect")?.addEventListener("change", () => {
    handleFolderAssignChange().catch(console.error);
  });
  $("#categoryAssignWrap")?.addEventListener("change", (ev) => {
    if (ev.target?.id === "categoryAssignSelect") {
      handleCategoryAssignChange().catch(console.error);
    }
  });
  $("#categoryAssignWrap")?.addEventListener("click", (ev) => {
    const target = ev.target?.closest?.("#restoreCategoryBtn, #reclassifyCategoryBtn");
    if (!target) return;
    handleCategoryReclassify().catch(console.error);
  });

  $("#q")?.addEventListener("input", () => {
    const route = parseHash();
    if (route.name === "list") renderList(route.view, route.folderId).catch(console.error);
  });

  document.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (target?.closest(".wbRailPopover, .wbRailActionBtn, .wbRailSearchCard")) return;
    closeRailPopover();
    if (target?.closest(".wbRailSearchOverlay")) return;
    if (target?.closest(".wbRowPopover, .wbRowTools, .ho-emoji-picker")) return;
    closeRowPopovers();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      closeRailSurfaces();
      closeRowPopovers();
    }
  });

  let nativeMetaRefreshTimer = 0;
  const scheduleNativeMetaRefresh = () => {
    clearTimeout(nativeMetaRefreshTimer);
    nativeMetaRefreshTimer = setTimeout(() => {
      state.rowsCache = null;
      if (parseHash().name === "read") {
        state.rowsCacheInvalidatedWhileReading = true;
        return;
      }
      renderRoute({ force: true }).catch(console.error);
    }, 250);
  };
  const nativeMetaPrefixes = [
    CHAT_TITLE_STATE_KEY_PREFIX,
    CHAT_TITLE_BOOT_KEY_PREFIX,
    INTERFACE_META_MIRROR_KEY_PREFIX,
    HEAT_OVERRIDE_KEY_PREFIX,
    PIN_KEY_PREFIX,
    ROW_TINT_KEY_PREFIX,
  ];
  if (hasChromeStorage() && W.chrome?.storage?.onChanged?.addListener) {
    try {
      W.chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        const keys = Object.keys(changes || {});
        if (keys.some((key) => nativeMetaPrefixes.some((prefix) => key.startsWith(prefix)))) {
          scheduleNativeMetaRefresh();
        }
      });
    } catch {}
  }
  [
    "h2o:chat-title:changed",
    "h2o:chat-title:emoji-updated",
    "evt:h2o:chat-title:changed",
    "evt:h2o:chat-title:emoji-updated",
    "evt:h2o:library:cross-surface-sync",
  ].forEach((eventName) => {
    window.addEventListener(eventName, scheduleNativeMetaRefresh);
  });
  [
    "evt:h2o:library-index:updated",
    "h2o:library-index:updated",
  ].forEach((eventName) => {
    window.addEventListener(eventName, scheduleLibraryIndexWorkbenchRefresh);
  });

  // v2.8: top-of-sidebar "Search chats" row → route into the Library Explorer
  // and focus its own page-level search input. The Explorer header mounts
  // asynchronously after the hash change, so we poll briefly (≤ 800ms) for
  // the input before giving up rather than racing it on the first frame.
  $("#wbStudioNavSearch")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    if (location.hash !== "#/library/explorer") location.hash = "#/library/explorer";
    const deadline = Date.now() + 800;
    const tryFocus = () => {
      const pageSearch = document.querySelector(".wbLibraryPageSearchInput");
      if (pageSearch && typeof pageSearch.focus === "function") { pageSearch.focus(); return; }
      if (Date.now() < deadline) setTimeout(tryFocus, 60);
    };
    requestAnimationFrame(tryFocus);
  });

  $("#viewList")?.addEventListener("click", (ev) => {
    const tagEl = ev.target.closest(".wbBadge--tag[data-tag]");
    if (!tagEl) return;
    ev.stopPropagation();
    const tag = String(tagEl.dataset.tag || "").trim();
    if (!tag) return;
    state.lastTagFilter = (state.lastTagFilter === tag) ? "" : tag;
    const route = parseHash();
    if (route.name === "list") renderList(route.view, route.folderId).catch(console.error);
  });

  // Hashchange listener with "last list-ish hash" capture. We remember the most
  // recent non-reader hash in sessionStorage so the topbar Close button can return
  // the user to wherever they came from (Library page, Saved, Pinned, Archive, …)
  // instead of always falling back to #/saved.
  const LAST_LIST_HASH_KEY = "h2o:studio:lastListHash:v1";
  function captureLastListHash(hash){
    const h = String(hash || "").trim();
    if (!h || h.startsWith("#/read/")) return;
    try { sessionStorage.setItem(LAST_LIST_HASH_KEY, h); } catch {}
  }
  function readLastListHash(){
    try { return sessionStorage.getItem(LAST_LIST_HASH_KEY) || ""; } catch { return ""; }
  }
  window.addEventListener("hashchange", (ev) => {
    try {
      const oldUrl = ev?.oldURL || "";
      if (oldUrl) captureLastListHash(new URL(oldUrl).hash || "");
    } catch {}
    persistStudioLastHash(location.hash);
    persistStudioPresence();
    renderRoute().catch(console.error);
  });

  // Wire the topbar Close button. Previously it had a label-update path in
  // applyUiState but no click handler — clicking it did nothing. Now: if the
  // user is in the reader, return to the previous list/library route (or fall
  // back to #/saved); if they're already on a list/library route, close the
  // window (Studio is a separate tab/window so this collapses cleanly).
  $("#closeBtn")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    const route = parseHash();
    if (route.name === "read") {
      const target = readLastListHash();
      // Guard against returning to the same read hash (defensive — shouldn't
      // happen because we only capture non-read hashes, but cheap to check).
      const safe = (target && !target.startsWith("#/read/")) ? target : "#/saved";
      if (location.hash === safe) {
        // Already at the target hash — trigger a render anyway so the reader
        // closes visually.
        renderRoute({ force: true }).catch(console.error);
      } else {
        location.hash = safe;
      }
      return;
    }
    // Not in the reader → close the Studio window. Some Chrome contexts block
    // window.close() on tabs the user opened directly; falling back to a
    // navigation to the empty hash keeps the page in a sane state.
    try { window.close(); } catch {}
  });

  const refreshFromForeground = () => {
    state.rowsCache = null;
    if (parseHash().name === "read") {
      state.rowsCacheInvalidatedWhileReading = true;
      return;
    }
    renderRoute({ force: true }).catch(console.error);
  };
  window.addEventListener("focus", refreshFromForeground);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      persistStudioPresence();
      refreshFromForeground();
    }
  });

  // Seed the capture so the very first reader-open from a fresh tab also
  // has something to return to.
  captureLastListHash(location.hash);

  if (!location.hash) location.hash = "#/saved";
  persistStudioLastHash(location.hash);
  persistStudioPresence();
  // Heartbeat keeps presence fresh so the SW can tell "Studio was alive in
  // the last ~10s" vs "Studio has been closed for hours". The interval is
  // unconditional — cheap (one chrome.storage.local.set / 10s) and survives
  // tab hidden/visible cycles. If the tab is closed, the interval dies with it.
  try { W.setInterval(() => persistStudioPresence(), STUDIO_PRESENCE_HEARTBEAT_MS); } catch {}
  renderRoute().catch(console.error);

  // Desktop (Tauri) only: the webview emits focus / visibilitychange /
  // hashchange in close succession during startup. Each event triggers
  // a new renderRoute which bumps state.renderToken, and every
  // in-flight renderList silently bails at its post-await token checks
  // before reaching renderFolderSidebar([]) / renderSidebarChatList([]).
  // The result is that the sidebar's static "Loading folder bindings…"
  // / "Loading chats…" HTML placeholders never get replaced until the
  // user manually triggers another renderRoute. A single deferred
  // renderRoute scheduled after the startup flurry settles is a
  // defensive empty-state completion pass: by then fetchWorkbenchRows
  // returns the cached [] instantly (via the callArchive interceptors)
  // and renderList runs end-to-end. Cheap; safe to double-render the
  // empty state. MV3 is unaffected — this whole block is gated on Tauri.
  if (STUDIO_isTauri()) {
    // M2a-3j: subscribe to LibraryIndex updates so SQLite-driven changes
    // (ingestion, edits, etc.) invalidate the workbench cache and
    // re-render the current route. Idempotent — subscribers are
    // deduplicated by LibraryIndex.subscribe.
    subscribeLibraryIndexToWorkbenchCache();
    setTimeout(() => {
      renderRoute({ force: true }).catch(console.error);
    }, 600);
  }
}

boot();

/* ─── Phase 1b → Phase 2e — Studio Ribbon read-only bridge ─────────────────
 * Async accessor exposed to the Studio Ribbon's "Copy clean transcript"
 * action. Serializes the canonical messages of the currently-open saved
 * snapshot, optionally decorated with the per-snapshot edit overlay
 * (headings, callouts, sections, etc.).
 *
 * Phase 2e contract — returns Promise<{
 *   text: string,
 *   overlayIncluded: boolean,
 *   overlaySkipped: boolean,
 *   reason?: string,
 * }>:
 *   - text                — the transcript string (raw on missing inputs).
 *   - overlayIncluded     — true only when overlay decorations actually
 *                           landed in the output (active ops were emitted
 *                           OR structure markers were inserted).
 *   - overlaySkipped      — true when includeOverlay was requested but
 *                           the overlay path was bypassed for a safe
 *                           fallback reason (drift, serializer missing).
 *   - reason              — short string explaining a skip:
 *                           'drift-detected', 'no-overlay',
 *                           'serializer-unavailable', 'store-unavailable',
 *                           'reducer-unavailable', 'serializer-error'.
 *
 * Options:
 *   - includeOverlay      default true. Pass false for byte-identical
 *                         Phase 1b output.
 *   - includeToc          default false. When true and there is at
 *                         least one section, a "## Contents" block is
 *                         emitted at the top.
 *   - collapsedMode       default 'include-marked'. Other values:
 *                         'include-silent', 'omit' (see serializer doc).
 *
 * Guarantees:
 *   - Never throws — wraps the entire body in try/catch and returns a
 *     well-formed object on any failure.
 *   - Returns { text: '', overlayIncluded: false, overlaySkipped: false }
 *     for missing snapshot or empty messages.
 *   - Returns raw text with overlayIncluded:false, overlaySkipped:false
 *     when includeOverlay is explicitly false.
 *   - Returns raw text with overlayIncluded:false, overlaySkipped:true,
 *     reason:'drift-detected' when the overlay's baseDigest no longer
 *     matches the snapshot.
 *   - Never mutates snap.messages or the overlay record.
 *
 * Raw fallback parity: when includeOverlay is false (or any safe
 * fallback fires), output is byte-identical to Phase 1b:
 *     User:\n<text>\n\nA:\n<text>\n\nSystem:\n<text>
 *   with empty turns skipped and unknown roles dropped.
 */
function __ribbonBridge_getCleanTranscript(opts){
  return Promise.resolve().then(function () {
    const options = (opts && typeof opts === 'object') ? opts : {};
    const includeOverlay = options.includeOverlay !== false; /* default true */
    const includeToc = options.includeToc === true;          /* default false */
    const collapsedMode = (options.collapsedMode === 'include-silent' || options.collapsedMode === 'omit')
      ? options.collapsedMode
      : 'include-marked';

    const snap = state && state.currentReaderSnapshot;
    if (!snap || typeof snap !== 'object') {
      return { text: '', overlayIncluded: false, overlaySkipped: false };
    }

    const serializer = W.H2O?.Studio?.overlaySerializer;
    /* ── Raw mode short-circuit. Stays usable even when the Phase 2e
     * serializer module didn't load (e.g., user is on an older Studio
     * build), since includeOverlay:false bypasses the serializer. */
    function rawResult(reasonIfAny) {
      try {
        const messages = Array.isArray(snap.messages) ? snap.messages : [];
        const out = [];
        for (let i = 0; i < messages.length; i += 1) {
          const msg = messages[i];
          if (!msg || typeof msg !== 'object') continue;
          const text = String(msg.text == null ? '' : msg.text).trim();
          if (!text) continue;
          const role = String(msg.role || '').toLowerCase();
          let label;
          if (role === 'user') label = 'User:';
          else if (role === 'assistant') label = 'A:';
          else if (role === 'system') label = 'System:';
          else continue;
          out.push(label + '\n' + text);
        }
        const txt = out.join('\n\n');
        const obj = { text: txt, overlayIncluded: false, overlaySkipped: !!reasonIfAny };
        if (reasonIfAny) obj.reason = String(reasonIfAny);
        return obj;
      } catch (_) {
        const obj = { text: '', overlayIncluded: false, overlaySkipped: !!reasonIfAny };
        if (reasonIfAny) obj.reason = String(reasonIfAny);
        return obj;
      }
    }

    if (!includeOverlay) {
      return rawResult(null);
    }
    if (!serializer || typeof serializer.serialize !== 'function') {
      return rawResult('serializer-unavailable');
    }

    /* ── Overlay mode — fetch overlay record, drift-check, serialize. */
    const sid = String(snap.snapshotId || '');
    if (!sid) {
      /* Snapshot has no id (shouldn't happen for saved chats but be safe).
       * Serializer can still produce overlay-aware text against a null
       * overlay (which it'll treat as raw with overlayIncluded:false). */
      const r0 = serializer.serialize(snap, null, { includeOverlay: true, includeToc: includeToc, collapsedMode: collapsedMode });
      return {
        text: String(r0 && r0.text || ''),
        overlayIncluded: false,
        overlaySkipped: false,
      };
    }

    const ov = W.H2O?.Studio?.overlay;
    const ovStore = W.H2O?.Studio?.store?.editOverlay;
    if (!ovStore || typeof ovStore.get !== 'function') {
      return rawResult('store-unavailable');
    }

    return Promise.resolve(ovStore.get(sid)).then(function (overlay) {
      if (!overlay) {
        /* No overlay record — serializer would just emit raw. Short-
         * circuit so the call still resolves with the well-formed
         * shape and no spurious overlaySkipped flag. */
        const r1 = serializer.serialize(snap, null, { includeOverlay: true, includeToc: includeToc, collapsedMode: collapsedMode });
        return {
          text: String(r1 && r1.text || ''),
          overlayIncluded: false,
          overlaySkipped: false,
        };
      }

      /* Drift check — mirrors applyOverlayOp/undo/redo behaviour. On
       * drift, fall back to raw text and flag overlaySkipped. */
      if (ov && typeof ov.computeBaseDigest === 'function' && overlay.baseDigest) {
        let currentDigest = '';
        try { currentDigest = ov.computeBaseDigest(snap); }
        catch (_) { currentDigest = ''; }
        if (currentDigest && overlay.baseDigest !== currentDigest) {
          return rawResult('drift-detected');
        }
      }

      let result = null;
      try {
        result = serializer.serialize(snap, overlay, {
          includeOverlay: true,
          includeToc: includeToc,
          collapsedMode: collapsedMode,
        });
      } catch (_) {
        return rawResult('serializer-error');
      }
      if (!result || typeof result !== 'object') {
        return rawResult('serializer-error');
      }
      if (result.reason === 'serializer-error') {
        return rawResult('serializer-error');
      }
      const applied = Number(result.opsApplied) > 0 || result.structureApplied === true || result.tocIncluded === true;
      return {
        text: String(result.text || ''),
        overlayIncluded: !!applied,
        overlaySkipped: false,
      };
    }, function () {
      return rawResult('store-unavailable');
    });
  }).catch(function () {
    /* Last-resort floor — should be unreachable since every internal
     * path catches. Resolves rather than rejects, matching the
     * "never throws" contract. */
    return { text: '', overlayIncluded: false, overlaySkipped: false };
  });
}

/* Phase 8f-1 — turn-scoped clean copy. Serializes ONLY the requested turn's
 * Markdown by projecting the reader snapshot down to that single message and
 * remapping its overlay ops onto turnIdx 1, so structure ops (afterTurnIdx)
 * and other turns are dropped and the output is just the message body (no
 * section headers / dividers / TOC). Mirrors getCleanTranscript's overlay
 * fetch + drift-check + never-throws contract. `turnIdx` is 1-based
 * (ctx.selectedTurnIdx). Read-only: never mutates snap or overlay. Returns
 * { text, overlayIncluded, overlaySkipped, reason? }. Includes the serializer
 * role label (e.g. "A:") exactly like getCleanTranscript. */
function __ribbonBridge_getTurnClean(turnIdx, opts){
  return Promise.resolve().then(function () {
    const options = (opts && typeof opts === 'object') ? opts : {};
    const includeOverlay = options.includeOverlay !== false; /* default true */

    const snap = state && state.currentReaderSnapshot;
    if (!snap || typeof snap !== 'object') {
      return { text: '', overlayIncluded: false, overlaySkipped: false };
    }
    const messages = Array.isArray(snap.messages) ? snap.messages : [];
    const idx = Number(turnIdx);
    if (!Number.isInteger(idx) || idx < 1 || idx > messages.length) {
      return { text: '', overlayIncluded: false, overlaySkipped: false };
    }
    const targetMsg = messages[idx - 1];
    /* Single-message projection so the serializer emits only this turn. */
    const snap2 = Object.assign({}, snap, { messages: [targetMsg] });

    const serializer = W.H2O?.Studio?.overlaySerializer;

    /* Turn-scoped raw fallback (label + trimmed body) — mirrors
     * getCleanTranscript.rawResult but for the single projected message. */
    function rawResult(reasonIfAny) {
      try {
        let txt = '';
        if (targetMsg && typeof targetMsg === 'object') {
          const t = String(targetMsg.text == null ? '' : targetMsg.text).trim();
          const role = String(targetMsg.role || '').toLowerCase();
          let label = null;
          if (role === 'user') label = 'User:';
          else if (role === 'assistant') label = 'A:';
          else if (role === 'system') label = 'System:';
          if (label && t) txt = label + '\n' + t;
        }
        const obj = { text: txt, overlayIncluded: false, overlaySkipped: !!reasonIfAny };
        if (reasonIfAny) obj.reason = String(reasonIfAny);
        return obj;
      } catch (_) {
        const obj = { text: '', overlayIncluded: false, overlaySkipped: !!reasonIfAny };
        if (reasonIfAny) obj.reason = String(reasonIfAny);
        return obj;
      }
    }

    if (!includeOverlay) return rawResult(null);
    if (!serializer || typeof serializer.serialize !== 'function') {
      return rawResult('serializer-unavailable');
    }

    const sid = String(snap.snapshotId || '');
    if (!sid) {
      const r0 = serializer.serialize(snap2, null, { includeOverlay: true, includeToc: false, collapsedMode: 'include-marked' });
      return { text: String(r0 && r0.text || ''), overlayIncluded: false, overlaySkipped: false };
    }

    const ov = W.H2O?.Studio?.overlay;
    const ovStore = W.H2O?.Studio?.store?.editOverlay;
    if (!ovStore || typeof ovStore.get !== 'function') {
      return rawResult('store-unavailable');
    }

    return Promise.resolve(ovStore.get(sid)).then(function (overlay) {
      if (!overlay) {
        const r1 = serializer.serialize(snap2, null, { includeOverlay: true, includeToc: false, collapsedMode: 'include-marked' });
        return { text: String(r1 && r1.text || ''), overlayIncluded: false, overlaySkipped: false };
      }

      /* Drift check against the FULL snapshot (overlay.baseDigest spans the
       * whole snap, not the single-turn projection). On drift → raw. */
      if (ov && typeof ov.computeBaseDigest === 'function' && overlay.baseDigest) {
        let currentDigest = '';
        try { currentDigest = ov.computeBaseDigest(snap); }
        catch (_) { currentDigest = ''; }
        if (currentDigest && overlay.baseDigest !== currentDigest) {
          return rawResult('drift-detected');
        }
      }

      /* Project the overlay onto the single turn: keep only ops that target
       * this turnIdx (message-level + inline), remap to turnIdx 1; drop
       * structure ops (afterTurnIdx-based) and other turns. Op ids preserved
       * so undoStack's active-set still applies. Never mutates `overlay`. */
      let overlay2;
      try {
        const ops = Array.isArray(overlay.ops) ? overlay.ops : [];
        const remapped = [];
        for (let i = 0; i < ops.length; i += 1) {
          const op = ops[i];
          if (!op || typeof op !== 'object') continue;
          const tgt = op.target;
          if (!tgt || typeof tgt !== 'object') continue;
          if (Number(tgt.turnIdx) !== idx) continue;
          remapped.push(Object.assign({}, op, { target: Object.assign({}, tgt, { turnIdx: 1 }) }));
        }
        overlay2 = Object.assign({}, overlay, { ops: remapped });
      } catch (_) {
        overlay2 = Object.assign({}, overlay, { ops: [] });
      }

      let result = null;
      try {
        result = serializer.serialize(snap2, overlay2, { includeOverlay: true, includeToc: false, collapsedMode: 'include-marked' });
      } catch (_) {
        return rawResult('serializer-error');
      }
      if (!result || typeof result !== 'object') return rawResult('serializer-error');
      if (result.reason === 'serializer-error') return rawResult('serializer-error');
      const applied = Number(result.opsApplied) > 0;
      return { text: String(result.text || ''), overlayIncluded: !!applied, overlaySkipped: false };
    }, function () {
      return rawResult('store-unavailable');
    });
  }).catch(function () {
    return { text: '', overlayIncluded: false, overlaySkipped: false };
  });
}

/* ═══ Phase 8f-2a — turn-scoped HTML serialization (bridge-private, pure) ═══
 * Emits self-contained semantic HTML for a single message by reusing the
 * applier's PUBLIC buildInlineRuns segmenter. NEVER scrapes the reader DOM,
 * never emits app classes / ids / data-* attributes / event surfaces, and
 * only ever writes VALUES from the fixed whitelisted maps below (no overlay
 * value is interpolated raw into a style=). Consumed by the clipboard rich-
 * copy path in 8f-2b; not wired to Copy yet. */
var __RB_HTML_COLOR_HEX = { red: '#C53030', green: '#2F855A', blue: '#2C5282', orange: '#C05621', gray: '#4A5568' };
var __RB_HTML_FONT_STACK = {
  sans: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  serif: "Georgia, Cambria, 'Times New Roman', Times, serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  humanist: "Optima, Candara, 'Segoe UI', Seravek, sans-serif"
};
var __RB_HTML_FONT_SIZE = { small: '0.85em', large: '1.25em', xlarge: '1.5em' };

/* Escape the 5 HTML-significant characters. ALL text/labels pass through
 * this before entering markup. */
function __ribbonBridge_escapeHtml(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Inline segmenter runs -> semantic HTML. Deterministic wrapper order
 * (bold -> italic -> underline -> strike -> sub -> sup -> color span).
 * Sub/sup are mutually exclusive (8e); subscript applied first so a
 * defensive both-set run nests <sup> outside <sub>. Color only from the
 * fixed whitelist; unknown kinds emit no style. \n -> <br>. */
function __ribbonBridge_runsToHtml(runs){
  if (!Array.isArray(runs)) return '';
  var out = '';
  for (var i = 0; i < runs.length; i += 1) {
    var r = runs[i] || {};
    var x = __ribbonBridge_escapeHtml(r.text == null ? '' : r.text).replace(/\n/g, '<br>');
    if (r.bold)          x = '<strong>' + x + '</strong>';
    if (r.italic)        x = '<em>' + x + '</em>';
    if (r.underline)     x = '<u>' + x + '</u>';
    if (r.strikethrough) x = '<s>' + x + '</s>';
    if (r.subscript)     x = '<sub>' + x + '</sub>';
    if (r.superscript)   x = '<sup>' + x + '</sup>';
    var hex = __RB_HTML_COLOR_HEX[r.textColor];
    if (hex) x = '<span style="color:' + hex + '">' + x + '</span>';
    out += x;
  }
  return out;
}

/* Split segmenter runs into per-line run groups (style flags preserved) so
 * list items keep inline formatting. Local mirror of the DOCX splitRunsByLine. */
function __ribbonBridge_runsByLine(runs){
  var lines = [[]];
  if (!Array.isArray(runs)) return lines;
  for (var i = 0; i < runs.length; i += 1) {
    var run = runs[i];
    if (!run || typeof run !== 'object') continue;
    var pieces = String(run.text == null ? '' : run.text).split('\n');
    for (var p = 0; p < pieces.length; p += 1) {
      if (p > 0) lines.push([]);
      if (pieces[p] !== '') {
        var copy = {};
        for (var k in run) { if (Object.prototype.hasOwnProperty.call(run, k)) copy[k] = run[k]; }
        copy.text = pieces[p];
        lines[lines.length - 1].push(copy);
      }
    }
  }
  return lines;
}

/* Build one message's HTML from (body, messageState, inlineState). Honors
 * text-replace (uses state.textReplace.body, inline suppressed), clean-
 * spacing (collapse blank lines, inline suppressed), and code (literal,
 * inline suppressed) exactly like the Markdown serializer. Message-level
 * formatting (font family/size/align/list/code/quote/callout/heading) is
 * rendered with semantic tags + whitelisted inline styles. `opts.label`
 * is the role label; `opts.offsetAdjust` rebases inline offsets. Pure. */
function __ribbonBridge_serializeTurnHtml(bodyText, messageState, inlineState, opts){
  var esc = __ribbonBridge_escapeHtml;
  var state = (messageState && typeof messageState === 'object') ? messageState : {};
  var options = (opts && typeof opts === 'object') ? opts : {};

  var replaced = !!(state.textReplace && typeof state.textReplace.body === 'string');
  var body = replaced ? state.textReplace.body : String(bodyText == null ? '' : bodyText);
  if (state.cleanSpacing) body = String(body).replace(/\n{3,}/g, '\n\n');

  var isCode = !!state.code;
  var listKind = (!isCode && state.list && (state.list.kind === 'bullet' || state.list.kind === 'numbered')) ? state.list.kind : null;
  var useInline = !isCode && !replaced && !state.cleanSpacing;

  var runs = null;
  if (useInline) {
    try {
      var ov = W.H2O && W.H2O.Studio && W.H2O.Studio.overlay;
      if (ov && typeof ov.buildInlineRuns === 'function') {
        var rr = ov.buildInlineRuns(body, state, inlineState, { offsetAdjust: Number(options.offsetAdjust) || 0 });
        if (rr && rr.ok && Array.isArray(rr.runs)) runs = rr.runs;
      }
    } catch (_) { runs = null; }
  }

  /* Fallback per-line renderer: escaped text + message-level char wrappers
   * (used when inline runs are unavailable/suppressed). */
  function charWrap(text){
    var x = esc(text).replace(/\n/g, '<br>');
    if (!isCode) {
      if (state.bold)          x = '<strong>' + x + '</strong>';
      if (state.italic)        x = '<em>' + x + '</em>';
      if (state.underline)     x = '<u>' + x + '</u>';
      if (state.strikethrough) x = '<s>' + x + '</s>';
    }
    return x;
  }

  var inner;
  if (isCode) {
    inner = '<pre><code>' + esc(body) + '</code></pre>';
  } else if (listKind) {
    var tag = (listKind === 'numbered') ? 'ol' : 'ul';
    var items = '';
    if (runs) {
      var groups = __ribbonBridge_runsByLine(runs);
      for (var g = 0; g < groups.length; g += 1) items += '<li>' + __ribbonBridge_runsToHtml(groups[g]) + '</li>';
    } else {
      var lns = String(body).split('\n');
      for (var li = 0; li < lns.length; li += 1) items += '<li>' + charWrap(lns[li]) + '</li>';
    }
    inner = '<' + tag + '>' + items + '</' + tag + '>';
  } else {
    inner = '<p>' + (runs ? __ribbonBridge_runsToHtml(runs) : charWrap(body)) + '</p>';
  }

  /* Role label — heading (H1-3) decorates the label, mirroring "# A:". */
  var label = String(options.label == null ? '' : options.label);
  var hLevel = (state.heading && (state.heading.level === 1 || state.heading.level === 2 || state.heading.level === 3)) ? state.heading.level : 0;
  var labelHtml = label
    ? (hLevel ? ('<h' + hLevel + '>' + esc(label) + '</h' + hLevel + '>') : ('<div><strong>' + esc(label) + '</strong></div>'))
    : '';

  var content = labelHtml + inner;

  if (state.callout && state.callout.kind) {
    content = '<blockquote><p><strong>[!' + esc(state.callout.kind) + ']</strong></p>' + content + '</blockquote>';
  } else if (state.quote) {
    content = '<blockquote>' + content + '</blockquote>';
  }

  var styles = [];
  if (state.fontFamily && __RB_HTML_FONT_STACK[state.fontFamily.token]) styles.push('font-family:' + __RB_HTML_FONT_STACK[state.fontFamily.token]);
  if (state.fontSize && __RB_HTML_FONT_SIZE[state.fontSize.token]) styles.push('font-size:' + __RB_HTML_FONT_SIZE[state.fontSize.token]);
  if (state.align === 'left' || state.align === 'center' || state.align === 'right') styles.push('text-align:' + state.align);
  if (styles.length) content = '<div style="' + styles.join(';') + '">' + content + '</div>';

  return content;
}

/* Turn-scoped HTML copy. Same single-message projection + turnIdx-1 remap +
 * overlay-fetch + drift + never-throws contract as getTurnClean, but emits
 * HTML via serializeTurnHtml. `turnIdx` is 1-based. Read-only: never mutates
 * snap or overlay. Returns { html, overlayIncluded, overlaySkipped, reason? }. */
function __ribbonBridge_getTurnHtml(turnIdx, opts){
  return Promise.resolve().then(function () {
    const options = (opts && typeof opts === 'object') ? opts : {};
    const includeOverlay = options.includeOverlay !== false; /* default true */

    const snap = state && state.currentReaderSnapshot;
    if (!snap || typeof snap !== 'object') {
      return { html: '', overlayIncluded: false, overlaySkipped: false, reason: 'no-snapshot' };
    }
    const messages = Array.isArray(snap.messages) ? snap.messages : [];
    const idx = Number(turnIdx);
    if (!Number.isInteger(idx) || idx < 1 || idx > messages.length) {
      return { html: '', overlayIncluded: false, overlaySkipped: false, reason: 'invalid-turn' };
    }
    const targetMsg = messages[idx - 1];
    const role = String((targetMsg && targetMsg.role) || '').toLowerCase();
    let label = '';
    if (role === 'user') label = 'User:';
    else if (role === 'assistant') label = 'A:';
    else if (role === 'system') label = 'System:';
    const rawText = String((targetMsg && targetMsg.text) == null ? '' : targetMsg.text);
    const trimmedBody = rawText.trim();
    const leadingTrim = rawText.length - rawText.replace(/^\s+/, '').length;

    if (!label || !trimmedBody) {
      return { html: '', overlayIncluded: false, overlaySkipped: false, reason: 'empty-message' };
    }

    const ov = W.H2O?.Studio?.overlay;

    function rawResult(reasonIfAny){
      const html = '<div><strong>' + __ribbonBridge_escapeHtml(label) + '</strong></div><p>'
        + __ribbonBridge_escapeHtml(trimmedBody).replace(/\n/g, '<br>') + '</p>';
      const obj = { html: html, overlayIncluded: false, overlaySkipped: !!reasonIfAny };
      if (reasonIfAny) obj.reason = String(reasonIfAny);
      return obj;
    }

    if (!includeOverlay) return rawResult(null);
    if (!ov || typeof ov.computeMessageState !== 'function' || typeof ov.computeInlineState !== 'function') {
      return rawResult('reducer-unavailable');
    }

    /* Project the overlay onto this turn @ turnIdx 1 (drop structure/other-
     * turn ops); render HTML. Never mutates `overlay`. */
    function buildFromOverlay(overlay){
      let overlay2;
      try {
        const ops = Array.isArray(overlay && overlay.ops) ? overlay.ops : [];
        const remapped = [];
        for (let i = 0; i < ops.length; i += 1) {
          const op = ops[i];
          if (!op || typeof op !== 'object') continue;
          const tgt = op.target;
          if (!tgt || typeof tgt !== 'object') continue;
          if (Number(tgt.turnIdx) !== idx) continue;
          remapped.push(Object.assign({}, op, { target: Object.assign({}, tgt, { turnIdx: 1 }) }));
        }
        overlay2 = Object.assign({}, overlay, { ops: remapped });
      } catch (_) { overlay2 = Object.assign({}, overlay, { ops: [] }); }

      let mstate;
      try { mstate = ov.computeMessageState(overlay2, 1) || {}; }
      catch (_) { return rawResult('reducer-error'); }
      let istate = null;
      try { istate = ov.computeInlineState(overlay2, 1); } catch (_) { istate = null; }
      let html = '';
      try { html = __ribbonBridge_serializeTurnHtml(trimmedBody, mstate, istate, { label: label, offsetAdjust: leadingTrim }); }
      catch (_) { return rawResult('serializer-error'); }
      const applied = Array.isArray(overlay2.ops) && overlay2.ops.length > 0;
      return { html: String(html || ''), overlayIncluded: !!applied, overlaySkipped: false };
    }

    const sid = String(snap.snapshotId || '');
    if (!sid) return buildFromOverlay({ ops: [] });

    const ovStore = W.H2O?.Studio?.store?.editOverlay;
    if (!ovStore || typeof ovStore.get !== 'function') return rawResult('store-unavailable');

    return Promise.resolve(ovStore.get(sid)).then(function (overlay) {
      if (!overlay) return buildFromOverlay({ ops: [] });
      if (ov && typeof ov.computeBaseDigest === 'function' && overlay.baseDigest) {
        let cur = '';
        try { cur = ov.computeBaseDigest(snap); } catch (_) { cur = ''; }
        if (cur && overlay.baseDigest !== cur) return rawResult('drift-detected');
      }
      return buildFromOverlay(overlay);
    }, function () {
      return rawResult('store-unavailable');
    });
  }).catch(function () {
    return { html: '', overlayIncluded: false, overlaySkipped: false, reason: 'error' };
  });
}

/* ─── Phase 3a — Markdown export helpers + bridge method ──────────────────
 * Pure helpers (no DOM, no I/O) used by __ribbonBridge_exportMarkdown
 * to compose the .md file contents and produce a filesystem-safe
 * filename. Both are exported on RibbonBridge as well so smoke harnesses
 * + future export variants (.json / .csv) can reuse them. */

/* Sanitize a chat title into a filesystem-safe stem.
 *   - Replaces Windows-reserved chars (/\:*?"<>|) + control chars with '-'.
 *   - Collapses runs of '-' to a single '-'.
 *   - Trims leading/trailing '-' and whitespace.
 *   - Truncates to 80 chars (safe for cross-OS path limits).
 *   - Prefixes the Windows reserved device names (CON, PRN, AUX, NUL, COM1-9,
 *     LPT1-9) with '_' so the result is valid on Windows even though the
 *     extension is appended.
 *   - Returns '' for empty / unsalvageable input; caller picks a fallback. */
function __ribbonBridge_sanitizeFilenameStem(title){
  try {
    var raw = String(title == null ? '' : title);
    /* Strip control chars (0x00-0x1F + 0x7F) and Windows-reserved punct. */
    var cleaned = raw.replace(/[\x00-\x1F\x7F<>:"/\\|?*]/g, '-');
    /* Collapse whitespace runs to single spaces, then spaces to '-'. */
    cleaned = cleaned.replace(/\s+/g, ' ').trim().replace(/ /g, '-');
    /* Collapse runs of '-' to single '-'. */
    cleaned = cleaned.replace(/-{2,}/g, '-');
    /* Trim leading/trailing '-'. */
    cleaned = cleaned.replace(/^-+|-+$/g, '');
    if (!cleaned) return '';
    /* Truncate to 80 chars (re-trim trailing '-' after truncation). */
    if (cleaned.length > 80) cleaned = cleaned.slice(0, 80).replace(/-+$/, '');
    /* Windows reserved device names — prefix with '_' to make safe. */
    var reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    if (reserved.test(cleaned)) cleaned = '_' + cleaned;
    return cleaned;
  } catch (_) { return ''; }
}

/* Build the Markdown filename: "{stem}__{YYYY-MM-DD}.md". The date is
 * derived from snap.capturedAt's ISO date prefix if available, else
 * today's date. Empty stem falls back to "chat-{chatId8}" or
 * "studio-transcript". Always returns a string ending in ".md". */
function __ribbonBridge_buildMarkdownFilename(snap){
  try {
    var stem = __ribbonBridge_sanitizeFilenameStem(snap && snap.title);
    if (!stem) {
      var cid = String((snap && snap.chatId) || '').replace(/[^A-Za-z0-9_-]/g, '');
      if (cid) stem = 'chat-' + cid.slice(0, 8);
      else stem = 'studio-transcript';
    }
    var date = '';
    var raw = (snap && snap.capturedAt) ? String(snap.capturedAt) : '';
    if (raw && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
      date = raw.slice(0, 10);
    } else {
      var d = new Date();
      var y = d.getFullYear();
      var m = String(d.getMonth() + 1).padStart(2, '0');
      var dd = String(d.getDate()).padStart(2, '0');
      date = y + '-' + m + '-' + dd;
    }
    return stem + '__' + date + '.md';
  } catch (_) { return 'studio-transcript.md'; }
}

/* Build the Markdown file header block:
 *
 *   # {title}
 *
 *   _Captured: {YYYY-MM-DD}_
 *   _Source: {originalUrl}_         (only when originalUrl provided)
 *   _Chat ID: {chatId}_             (only when chatId provided)
 *
 *   ---
 *
 * Each metadata line ends with two trailing spaces so Markdown
 * preserves the line break inside the same paragraph. Returns a
 * string ending with "\n\n" so the serializer body can be appended
 * directly. */
function __ribbonBridge_buildMarkdownHeader(snap, originalUrl){
  try {
    var lines = [];
    var title = String((snap && snap.title) || '').trim();
    lines.push('# ' + (title || 'Studio transcript'));
    lines.push('');
    var metaLines = [];
    /* Date from capturedAt ISO prefix; fall back to today. */
    var raw = (snap && snap.capturedAt) ? String(snap.capturedAt) : '';
    var date;
    if (raw && /^\d{4}-\d{2}-\d{2}/.test(raw)) date = raw.slice(0, 10);
    else {
      var d = new Date();
      date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    metaLines.push('_Captured: ' + date + '_');
    var src = String(originalUrl == null ? '' : originalUrl).trim();
    if (src) metaLines.push('_Source: ' + src + '_');
    var chatId = String((snap && snap.chatId) || '').trim();
    if (chatId) metaLines.push('_Chat ID: ' + chatId + '_');
    /* Two trailing spaces preserve the visual line break within a
     * single Markdown paragraph (Markdown line-break syntax). */
    lines.push(metaLines.join('  \n'));
    lines.push('');
    lines.push('---');
    lines.push('');
    return lines.join('\n') + '\n';
  } catch (_) {
    return '# Studio transcript\n\n---\n\n';
  }
}

/* Phase 3a — export the current saved snapshot as a Markdown .md file.
 * Composes the file = header block + Phase 2e serializer output, then
 * writes via platform.files.exportBlob. When platform.files is
 * unavailable, falls back to an inline Blob + <a download> dance so the
 * feature still works in degraded environments.
 *
 * Returns Promise<{
 *   ok: boolean,
 *   reason?: 'no-snapshot' | 'no-content' | 'cancelled' | 'export-failed' | 'error',
 *   filename?: string,
 *   bytes?: number,
 *   path?: string,                   (Tauri native save path when applicable)
 *   overlayIncluded?: boolean,
 *   overlaySkipped?: boolean,
 *   overlayReason?: string,
 *   fallback?: 'blob-anchor' | 'platform-files',
 * }>. Never throws. */
function __ribbonBridge_exportMarkdown(opts){
  return Promise.resolve().then(function () {
    const options = (opts && typeof opts === 'object') ? opts : {};
    const includeOverlay = options.includeOverlay !== false;
    const includeToc = options.includeToc === true;
    const collapsedMode = (options.collapsedMode === 'include-silent' || options.collapsedMode === 'omit')
      ? options.collapsedMode
      : 'include-marked';

    const snap = state && state.currentReaderSnapshot;
    if (!snap || !snap.snapshotId) {
      return { ok: false, reason: 'no-snapshot' };
    }

    /* Reuse Phase 2e: getCleanTranscript handles overlay fetch + drift
     * fallback + active-set filter. We just consume its result. */
    return Promise.resolve(__ribbonBridge_getCleanTranscript({
      includeOverlay: includeOverlay,
      includeToc: includeToc,
      collapsedMode: collapsedMode,
    })).then(function (tr) {
      const safeTr = (tr && typeof tr === 'object') ? tr : { text: '', overlayIncluded: false, overlaySkipped: false };
      const body = String(safeTr.text || '');
      if (!body.trim()) {
        return { ok: false, reason: 'no-content' };
      }

      /* Resolve originalUrl from the ribbon context (only present for
       * indexed chats — saved chats omit it from the header). */
      let originalUrl = '';
      try {
        const ribbon = W.H2O?.Studio?.ribbon;
        const ctx = (ribbon && typeof ribbon.getContext === 'function') ? ribbon.getContext() : null;
        if (ctx && typeof ctx.originalUrl === 'string') originalUrl = ctx.originalUrl;
      } catch (_) { originalUrl = ''; }

      const filename = __ribbonBridge_buildMarkdownFilename(snap);
      const header = __ribbonBridge_buildMarkdownHeader(snap, originalUrl);
      const content = header + body + '\n';

      let blob;
      try {
        blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      } catch (e) {
        return { ok: false, reason: 'error', error: String((e && e.message) || e || '') };
      }
      const bytes = blob.size;

      function inlineBlobAnchor() {
        return new Promise(function (resolve) {
          try {
            if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
              return resolve({ ok: false, reason: 'export-failed', error: 'URL.createObjectURL unavailable' });
            }
            if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
              return resolve({ ok: false, reason: 'export-failed', error: 'document unavailable' });
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            try {
              document.body.appendChild(a);
              a.click();
            } catch (e) {
              try { URL.revokeObjectURL(url); } catch (_) {}
              return resolve({ ok: false, reason: 'export-failed', error: String((e && e.message) || e || '') });
            }
            setTimeout(function () {
              try { document.body.removeChild(a); } catch (_) {}
              try { URL.revokeObjectURL(url); } catch (_) {}
            }, 200);
            resolve({ ok: true, filename: filename, bytes: bytes, fallback: 'blob-anchor' });
          } catch (e) {
            resolve({ ok: false, reason: 'error', error: String((e && e.message) || e || '') });
          }
        });
      }

      const files = W.H2O?.Studio?.platform?.files;
      const canExportViaPlatform = !!(files && files.available && typeof files.exportBlob === 'function');
      const writePromise = canExportViaPlatform
        ? Promise.resolve(files.exportBlob({ suggestedName: filename, blob: blob }))
            .then(undefined, function (err) {
              /* platform.files rejected — fall back to inline blob+anchor
               * so the user still gets a file. Log for diagnostics. */
              try { console.warn('[RibbonBridge.exportMarkdown] platform.files.exportBlob rejected; falling back', err); }
              catch (_) {}
              return inlineBlobAnchor();
            })
        : inlineBlobAnchor();

      return writePromise.then(function (res) {
        const r = (res && typeof res === 'object') ? res : {};
        if (r.ok === false && r.reason === 'cancelled') {
          /* User dismissed the Tauri save dialog. Informational, not
           * an error. */
          return { ok: false, reason: 'cancelled' };
        }
        if (r.ok === false) {
          return { ok: false, reason: r.reason || 'export-failed', error: String(r.error || '') };
        }
        return {
          ok: true,
          filename: filename,
          bytes: bytes,
          path: r.path,
          overlayIncluded: !!safeTr.overlayIncluded,
          overlaySkipped: !!safeTr.overlaySkipped,
          overlayReason: safeTr.reason,
          fallback: r.fallback || (canExportViaPlatform ? undefined : 'blob-anchor'),
        };
      });
    });
  }).catch(function (err) {
    return { ok: false, reason: 'error', error: String((err && err.message) || err || '') };
  });
}

/* ─── Phase 3c-B — DOCX export bridge + helpers ───────────────────────────
 * Composes the Phase 3c-A pure DOCX writer (H2O.Studio.overlayDocxWriter)
 * with H2O.Studio.platform.files.exportBlob and the inline Blob+anchor
 * fallback. Mirrors the Phase 3a Markdown bridge shape line-for-line so
 * the ribbon handler reads exactly the same fields.
 *
 * Tauri binary safety: the Phase 3c-B platform.tauri.js update detects
 * non-text MIME types and routes through plugin:fs|write_file (binary)
 * instead of plugin:fs|write_text_file (text). The DOCX MIME
 * (application/vnd.openxml...) triggers the binary path; if the fs plugin
 * doesn't have write_file allow-listed in capabilities, the existing
 * fallback chain catches the rejection and uses Blob+anchor download
 * (loses native save dialog on desktop but the file still saves). */

/* Suggested filename: {sanitized-title}__{YYYY-MM-DD}.docx. Reuses Phase
 * 3a's filename sanitizer + builder; just swaps .md for .docx. */
function __ribbonBridge_buildDocxFilename(snap){
  try {
    const md = __ribbonBridge_buildMarkdownFilename(snap);
    if (typeof md === 'string' && md.endsWith('.md')) return md.slice(0, -3) + '.docx';
    return String(md || 'studio-transcript') + '.docx';
  } catch (_) { return 'studio-transcript.docx'; }
}

/* Phase 3c-B — export the current saved snapshot as a Word .docx file.
 * Composes overlayDocxWriter.build() output with platform.files.exportBlob.
 * Drift fallback: when the overlay record's baseDigest doesn't match
 * snap.messages, the writer is called with overlay:null (raw mode) and
 * the result is flagged overlaySkipped:true, overlayReason:'drift-detected'.
 * The user still gets a valid .docx, just without the overlay decorations.
 *
 * Returns Promise<{
 *   ok: boolean,
 *   reason?: 'no-snapshot' | 'no-content' | 'cancelled' | 'export-failed' |
 *            'writer-unavailable' | 'error',
 *   filename?: string,
 *   bytes?: number,
 *   path?: string,                  (Tauri native save path when applicable)
 *   overlayIncluded?: boolean,
 *   overlaySkipped?: boolean,
 *   overlayReason?: string,
 *   fallback?: 'blob-anchor',
 * }>. Never throws. */
function __ribbonBridge_exportDocx(opts){
  return Promise.resolve().then(function () {
    const options = (opts && typeof opts === 'object') ? opts : {};
    const includeOverlay = options.includeOverlay !== false;
    const includeToc = options.includeToc === true;
    const collapsedMode = (options.collapsedMode === 'include-silent' || options.collapsedMode === 'omit')
      ? options.collapsedMode
      : 'include-marked';

    const snap = state && state.currentReaderSnapshot;
    if (!snap || !snap.snapshotId) {
      return { ok: false, reason: 'no-snapshot' };
    }

    const writer = W.H2O?.Studio?.overlayDocxWriter;
    if (!writer || typeof writer.build !== 'function') {
      return { ok: false, reason: 'writer-unavailable' };
    }
    try {
      if (typeof writer.selfCheck === 'function' && writer.selfCheck().ok === false) {
        return { ok: false, reason: 'writer-unavailable', error: 'overlayDocxWriter.selfCheck not ok' };
      }
    } catch (_) { /* swallow — selfCheck is advisory */ }

    /* Resolve overlay record + drift detection. Mirrors the Phase 3a
     * exportMarkdown / Phase 2e getCleanTranscript pattern. */
    const sid = String(snap.snapshotId);
    const ov = W.H2O?.Studio?.overlay;
    const ovStore = W.H2O?.Studio?.store?.editOverlay;

    function resolveOverlay() {
      if (!includeOverlay) return Promise.resolve({ overlay: null, overlaySkipped: false, overlayReason: undefined });
      if (!ovStore || typeof ovStore.get !== 'function') {
        return Promise.resolve({ overlay: null, overlaySkipped: false, overlayReason: undefined });
      }
      return Promise.resolve(ovStore.get(sid)).then(function (overlay) {
        if (!overlay) return { overlay: null, overlaySkipped: false, overlayReason: undefined };
        if (ov && typeof ov.computeBaseDigest === 'function' && overlay.baseDigest) {
          let currentDigest = '';
          try { currentDigest = ov.computeBaseDigest(snap); } catch (_) { currentDigest = ''; }
          if (currentDigest && overlay.baseDigest !== currentDigest) {
            return { overlay: null, overlaySkipped: true, overlayReason: 'drift-detected' };
          }
        }
        return { overlay: overlay, overlaySkipped: false, overlayReason: undefined };
      }, function () {
        return { overlay: null, overlaySkipped: false, overlayReason: undefined };
      });
    }

    /* Resolve originalUrl from the ribbon context (only present for
     * indexed chats — saved chats omit it from the header). */
    function readOriginalUrl() {
      try {
        const ribbon = W.H2O?.Studio?.ribbon;
        const ctx = (ribbon && typeof ribbon.getContext === 'function') ? ribbon.getContext() : null;
        if (ctx && typeof ctx.originalUrl === 'string') return ctx.originalUrl;
      } catch (_) {}
      return '';
    }

    return resolveOverlay().then(function (resolved) {
      const originalUrl = readOriginalUrl();
      const headerMeta = {
        title: snap.title,
        capturedDate: (snap.capturedAt ? String(snap.capturedAt).slice(0, 10) : ''),
      };
      if (originalUrl) headerMeta.originalUrl = originalUrl;
      if (snap.chatId) headerMeta.chatId = snap.chatId;

      let built;
      try {
        built = writer.build({
          snap: snap,
          overlay: resolved.overlay,
          headerMeta: headerMeta,
          opts: {
            includeOverlay: includeOverlay && resolved.overlay !== null,
            includeToc: includeToc,
            collapsedMode: collapsedMode,
          },
        });
      } catch (e) {
        return { ok: false, reason: 'export-failed', error: String((e && e.message) || e || '') };
      }
      if (!built || !built.bytes || built.bytes.length === 0) {
        return { ok: false, reason: 'no-content' };
      }
      if (built.reason === 'writer-error') {
        /* Writer fell back to its minimal-DOCX recovery. Surface as an
         * export-failed so the user knows something went wrong even
         * though bytes were produced. */
        return { ok: false, reason: 'export-failed', error: 'writer-error: minimal DOCX returned' };
      }

      const blob = built.blob;
      const filename = __ribbonBridge_buildDocxFilename(snap);
      const overlayIncluded = !!(built.opsApplied > 0 || built.structureApplied === true || built.tocIncluded === true);

      function inlineBlobAnchor() {
        return new Promise(function (resolve) {
          try {
            if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
              return resolve({ ok: false, reason: 'export-failed', error: 'URL.createObjectURL unavailable' });
            }
            if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
              return resolve({ ok: false, reason: 'export-failed', error: 'document unavailable' });
            }
            if (!blob) {
              return resolve({ ok: false, reason: 'export-failed', error: 'blob unavailable' });
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            try {
              document.body.appendChild(a);
              a.click();
            } catch (e) {
              try { URL.revokeObjectURL(url); } catch (_) {}
              return resolve({ ok: false, reason: 'export-failed', error: String((e && e.message) || e || '') });
            }
            setTimeout(function () {
              try { document.body.removeChild(a); } catch (_) {}
              try { URL.revokeObjectURL(url); } catch (_) {}
            }, 200);
            resolve({ ok: true, filename: filename, bytes: built.size, fallback: 'blob-anchor' });
          } catch (e) {
            resolve({ ok: false, reason: 'error', error: String((e && e.message) || e || '') });
          }
        });
      }

      const files = W.H2O?.Studio?.platform?.files;
      const canExportViaPlatform = !!(files && files.available && typeof files.exportBlob === 'function' && blob);
      const writePromise = canExportViaPlatform
        ? Promise.resolve(files.exportBlob({ suggestedName: filename, blob: blob }))
            .then(undefined, function (err) {
              try { console.warn('[RibbonBridge.exportDocx] platform.files.exportBlob rejected; falling back', err); }
              catch (_) {}
              return inlineBlobAnchor();
            })
        : inlineBlobAnchor();

      return writePromise.then(function (res) {
        const r = (res && typeof res === 'object') ? res : {};
        if (r.ok === false && r.reason === 'cancelled') {
          return { ok: false, reason: 'cancelled' };
        }
        if (r.ok === false) {
          return { ok: false, reason: r.reason || 'export-failed', error: String(r.error || '') };
        }
        return {
          ok: true,
          filename: filename,
          bytes: built.size,
          path: r.path,
          overlayIncluded: overlayIncluded,
          overlaySkipped: resolved.overlaySkipped,
          overlayReason: resolved.overlayReason,
          fallback: r.fallback || (canExportViaPlatform ? undefined : 'blob-anchor'),
        };
      });
    });
  }).catch(function (err) {
    return { ok: false, reason: 'error', error: String((err && err.message) || err || '') };
  });
}

/* ─── Phase 3b — PDF / print view helpers + bridge method ──────────────────
 * Strategy A: window.print() over the live reader DOM. The browser's
 * print dialog offers "Save as PDF" as a destination on every modern OS
 * (Chrome, Edge, Firefox, Safari, Tauri webview). Studio injects a
 * temporary <header data-print-header> before .cgFrame, swaps
 * document.title for a sensible PDF filename, calls window.print(), and
 * unwinds. No JS PDF library, no Tauri plugin, no platform.files change.
 *
 * Cancellation limitation: window.print() is synchronous from JS and
 * returns no signal indicating whether the user saved a file or
 * dismissed the dialog. The bridge resolves ok:true for "we opened the
 * dialog"; the ribbon status string explains. Same constraint every
 * web-based print-to-PDF flow has. */

/* Build the print-only header element with title + date + optional
 * source + optional chat ID. Pure (constructs and returns a node; no
 * DOM mutation outside the returned element). Reused by the smoke. */
function __ribbonBridge_buildPrintHeaderEl(snap, originalUrl){
  try {
    const header = document.createElement('header');
    header.setAttribute('data-print-header', 'true');

    const titleEl = document.createElement('h1');
    titleEl.textContent = String((snap && snap.title) || 'Studio transcript');
    header.appendChild(titleEl);

    const meta = document.createElement('div');
    meta.className = 'wbPrintHeaderMeta';

    /* Date from capturedAt ISO prefix; fall back to today's local date. */
    let date;
    const raw = (snap && snap.capturedAt) ? String(snap.capturedAt) : '';
    if (raw && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
      date = raw.slice(0, 10);
    } else {
      const d = new Date();
      date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    const dateSpan = document.createElement('span');
    dateSpan.textContent = 'Captured: ' + date;
    meta.appendChild(dateSpan);

    const src = String(originalUrl == null ? '' : originalUrl).trim();
    if (src) {
      const srcSpan = document.createElement('span');
      srcSpan.textContent = 'Source: ' + src;
      meta.appendChild(srcSpan);
    }
    const chatId = String((snap && snap.chatId) || '').trim();
    if (chatId) {
      const chatSpan = document.createElement('span');
      chatSpan.textContent = 'Chat ID: ' + chatId;
      meta.appendChild(chatSpan);
    }
    header.appendChild(meta);
    return header;
  } catch (_) {
    /* Last-resort minimal node so callers can still print. */
    try {
      const fallback = document.createElement('header');
      fallback.setAttribute('data-print-header', 'true');
      const h = document.createElement('h1');
      h.textContent = 'Studio transcript';
      fallback.appendChild(h);
      return fallback;
    } catch (_) { return null; }
  }
}

/* Suggested filename hint (the browser's save-as-PDF dialog ignores
 * this and uses document.title — we set that to a useful string below).
 * Kept for the bridge result + status messages. Reuses the Phase 3a
 * Markdown filename sanitizer; just swaps .md for .pdf. */
function __ribbonBridge_buildPdfFilename(snap){
  try {
    const md = __ribbonBridge_buildMarkdownFilename(snap);
    if (typeof md === 'string' && md.endsWith('.md')) return md.slice(0, -3) + '.pdf';
    return String(md || 'studio-transcript') + '.pdf';
  } catch (_) { return 'studio-transcript.pdf'; }
}

/* Coalesce concurrent print calls — only one print in flight at a time
 * (otherwise the document.title stash/restore can race). */
let __ribbonBridge_printInFlight = false;

/* Phase 3b — open the browser print dialog over the live reader DOM.
 * The CSS in studio.css (@media print block) hides Studio chrome and
 * keeps overlay decorations + the print-only header visible. The user
 * picks the destination (printer or Save as PDF) from the OS dialog.
 *
 * Returns Promise<{
 *   ok: boolean,
 *   reason?: 'no-snapshot' | 'no-content' | 'reader-unavailable' |
 *            'print-unavailable' | 'print-in-progress' | 'error',
 *   filename?: string,              suggested PDF filename
 *   overlayIncluded?: boolean,      mirrors getCleanTranscript shape
 *   overlaySkipped?: boolean,       true if drift detected
 *   overlayReason?: string,         'drift-detected' when applicable
 * }>. Never throws. */
function __ribbonBridge_openPrintView(opts){
  return Promise.resolve().then(function () {
    const options = (opts && typeof opts === 'object') ? opts : {};
    const includeHeader = options.includeHeader !== false; /* default true */

    if (__ribbonBridge_printInFlight) {
      return { ok: false, reason: 'print-in-progress' };
    }

    const snap = state && state.currentReaderSnapshot;
    if (!snap || !snap.snapshotId) {
      return { ok: false, reason: 'no-snapshot' };
    }

    /* Locate the reader DOM. Phase 2/3 conventions: #viewReader > .cgFrame */
    let frame = null;
    try {
      const readerEl = document.getElementById('viewReader');
      frame = readerEl && readerEl.querySelector('.cgFrame');
    } catch (_) { frame = null; }
    if (!frame) {
      return { ok: false, reason: 'reader-unavailable' };
    }

    if (typeof window === 'undefined' || typeof window.print !== 'function') {
      return { ok: false, reason: 'print-unavailable' };
    }

    /* Compute drift status diagnostically. We do NOT refuse on drift —
     * the user pressed print and expects a render. We just surface the
     * fact via overlaySkipped so the ribbon status can flag it. */
    let overlaySkipped = false;
    let overlayReason;
    let overlayIncluded = false;
    try {
      const ov = W.H2O?.Studio?.overlay;
      const ovStore = W.H2O?.Studio?.store?.editOverlay;
      if (ov && typeof ov.computeBaseDigest === 'function' && ovStore && typeof ovStore.get === 'function') {
        /* Synchronous best-effort: read the cached overlay if available
         * (editOverlay caches after first get/upsert). For our purposes
         * the diagnostic is advisory; not awaiting keeps the bridge
         * snappy and avoids racing with the print dialog opening. */
        try {
          const maybe = ovStore.get(String(snap.snapshotId));
          if (maybe && typeof maybe.then === 'function') {
            /* Async path — we can't await before print() without delaying
             * the dialog; just leave the flags at defaults. */
          } else if (maybe) {
            const currentDigest = ov.computeBaseDigest(snap);
            if (maybe.baseDigest && maybe.baseDigest !== currentDigest) {
              overlaySkipped = true;
              overlayReason = 'drift-detected';
            } else if (Array.isArray(maybe.undoStack) && maybe.undoStack.length > 0) {
              overlayIncluded = true;
            }
          }
        } catch (_) { /* swallow — diagnostic only */ }
      }
    } catch (_) { /* swallow */ }

    /* Resolve originalUrl from the ribbon context for the header line. */
    let originalUrl = '';
    try {
      const ribbon = W.H2O?.Studio?.ribbon;
      const ctx = (ribbon && typeof ribbon.getContext === 'function') ? ribbon.getContext() : null;
      if (ctx && typeof ctx.originalUrl === 'string') originalUrl = ctx.originalUrl;
    } catch (_) { originalUrl = ''; }

    const filename = __ribbonBridge_buildPdfFilename(snap);
    const titleForPdf = String((snap && snap.title) || 'Studio transcript') + ' — Studio';

    /* Stash state for restoration in finally. */
    let injectedHeader = null;
    let previousTitle = '';
    __ribbonBridge_printInFlight = true;

    try {
      previousTitle = document.title;
      try { document.title = titleForPdf; } catch (_) { /* swallow */ }

      if (includeHeader) {
        injectedHeader = __ribbonBridge_buildPrintHeaderEl(snap, originalUrl);
        if (injectedHeader) {
          try { frame.insertBefore(injectedHeader, frame.firstChild || null); }
          catch (_) { injectedHeader = null; /* couldn't inject; print anyway */ }
        }
      }

      /* Call into the browser print dialog. Synchronous from JS. */
      try {
        window.print();
      } catch (printErr) {
        return { ok: false, reason: 'error', error: String((printErr && printErr.message) || printErr || '') };
      }

      return {
        ok: true,
        filename: filename,
        overlayIncluded: overlayIncluded,
        overlaySkipped: overlaySkipped,
        overlayReason: overlayReason,
      };
    } finally {
      /* Always restore — even if window.print threw or we returned
       * early. The injected header is short-lived and must not leak
       * into the live reader. */
      if (injectedHeader && injectedHeader.parentNode) {
        try { injectedHeader.parentNode.removeChild(injectedHeader); }
        catch (_) { /* swallow */ }
      }
      try {
        if (previousTitle != null) document.title = previousTitle;
      } catch (_) { /* swallow */ }
      __ribbonBridge_printInFlight = false;
    }
  }).catch(function (err) {
    /* Last-resort floor — guarantees the never-throw contract even if
     * the synchronous body above somehow rejected before the finally
     * ran. The finally above runs first in normal flow so this is
     * primarily a paranoia net. */
    __ribbonBridge_printInFlight = false;
    return { ok: false, reason: 'error', error: String((err && err.message) || err || '') };
  });
}

/* Phase 2a — narrow read-only accessor for the per-snapshot edit
 * overlay. Returns a Promise resolving to the EditOverlay record or
 * null. Never throws. */
function __ribbonBridge_getOverlay(snapshotId){
  try {
    const sid = String(snapshotId == null ? '' : snapshotId);
    if (!sid) return Promise.resolve(null);
    const ovStore = W.H2O && W.H2O.Studio && W.H2O.Studio.store && W.H2O.Studio.store.editOverlay;
    if (!ovStore || typeof ovStore.get !== 'function') return Promise.resolve(null);
    const r = ovStore.get(sid);
    return (r && typeof r.then === 'function') ? r : Promise.resolve(r || null);
  } catch (_) { return Promise.resolve(null); }
}

/* Phase 2b — pure-read accessor: compute the current visual state of a
 * specific message in the open snapshot's overlay. Returns a Promise
 * that resolves to a default-shape state object when no overlay exists
 * or no snapshot is open; returns the computed state otherwise. Used
 * by ribbon action handlers to decide whether to apply or toggle off.
 * Never throws. */
function __ribbonBridge_getMessageStateForTurn(turnIdx){
  const empty = { heading: null, quote: false, code: false, callout: null, cleanSpacing: false };
  try {
    const snap = state && state.currentReaderSnapshot;
    if (!snap || !snap.snapshotId) return Promise.resolve(empty);
    const ovStore = W.H2O?.Studio?.store?.editOverlay;
    const ov = W.H2O?.Studio?.overlay;
    if (!ovStore || !ov || typeof ov.computeMessageState !== 'function') return Promise.resolve(empty);
    return Promise.resolve(ovStore.get(String(snap.snapshotId))).then(function (overlay) {
      if (!overlay) return empty;
      try { return ov.computeMessageState(overlay, Number(turnIdx)); }
      catch (_) { return empty; }
    }, function () { return empty; });
  } catch (_) { return Promise.resolve(empty); }
}

/* Phase 2c-A — pure-read accessor: compute the current structure state
 * (sections + page dividers + TOC slot) for the open snapshot's overlay.
 * Used by ribbon action handlers to decide auto-numbering for new
 * sections, to look up "is selected turn inside a section" for the
 * Split / Collapse enable rules, and (in Phase 2c-B) to toggle TOC.
 * Returns default-shape object when no overlay/snapshot. Never throws. */
function __ribbonBridge_getStructureState(){
  const empty = { sections: [], dividers: [], toc: { position: null } };
  try {
    const snap = state && state.currentReaderSnapshot;
    if (!snap || !snap.snapshotId) return Promise.resolve(empty);
    const ovStore = W.H2O?.Studio?.store?.editOverlay;
    const ov = W.H2O?.Studio?.overlay;
    if (!ovStore || !ov || typeof ov.computeStructureState !== 'function') return Promise.resolve(empty);
    return Promise.resolve(ovStore.get(String(snap.snapshotId))).then(function (overlay) {
      if (!overlay) return empty;
      try { return ov.computeStructureState(overlay); }
      catch (_) { return empty; }
    }, function () { return empty; });
  } catch (_) { return Promise.resolve(empty); }
}

/* Phase 2b — orchestrates a single overlay op: load-or-create overlay,
 * drift-check against current snapshot, append op (pure helper),
 * upsert to store, and re-apply to live reader DOM. Returns
 * Promise<{ ok, reason?, overlay?, outcome?, error? }>. Never throws.
 * Never mutates snap.messages. */
function __ribbonBridge_applyOverlayOp(opSpec){
  return Promise.resolve().then(function () {
    const snap = state && state.currentReaderSnapshot;
    if (!snap || !snap.snapshotId) {
      return { ok: false, reason: 'no-snapshot' };
    }
    const ov = W.H2O?.Studio?.overlay;
    const ovStore = W.H2O?.Studio?.store?.editOverlay;
    if (!ov || typeof ov.computeBaseDigest !== 'function' || typeof ov.appendOp !== 'function' || typeof ov.applyOverlay !== 'function') {
      return { ok: false, reason: 'overlay-unavailable' };
    }
    if (!ovStore || typeof ovStore.get !== 'function' || typeof ovStore.upsert !== 'function') {
      return { ok: false, reason: 'store-unavailable' };
    }
    const sid = String(snap.snapshotId);
    return Promise.resolve(ovStore.get(sid)).then(function (existing) {
      let overlay = existing;
      if (!overlay) {
        try { overlay = ov.createEmpty({ snapshot: snap }); }
        catch (_) { overlay = null; }
        if (!overlay) return { ok: false, reason: 'create-empty-failed' };
      }
      /* Drift check — refuse to mutate an overlay that no longer
       * matches the current snapshot. The applier ALSO refuses to
       * render on drift, but we check here first so we don't persist
       * a new op against a stale baseDigest. */
      const currentDigest = ov.computeBaseDigest(snap);
      if (overlay.baseDigest && overlay.baseDigest !== currentDigest) {
        return { ok: false, reason: 'drift-detected', overlay: overlay, currentDigest: currentDigest };
      }
      /* Append op (pure) */
      const next = ov.appendOp(overlay, opSpec);
      if (!next) return { ok: false, reason: 'append-failed' };
      /* Persist */
      return Promise.resolve(ovStore.upsert(next)).then(function (saved) {
        /* Re-apply to the live reader DOM */
        let outcome = null;
        try {
          const readerEl = document.getElementById('viewReader');
          const frame = readerEl && readerEl.querySelector('.cgFrame');
          if (frame) {
            outcome = ov.applyOverlay(frame, snap, saved);
            /* Phase 5b-1 — inline render pass after each forward op. */
            try { __inlineRender_apply(frame, snap, saved); } catch (_) {}
          }
        } catch (_) { /* swallow — apply failure does not invalidate the persisted op */ }
        /* Publish hasOverlay = true now.
         * Phase 2d — also republish undoCount / redoCount so the Home
         * tab Undo/Redo buttons immediately reflect the new stack
         * shape after each forward op (and after the redoStack clear
         * that appendOp performs). */
        try {
          const ribbon = W.H2O?.Studio?.ribbon;
          if (ribbon && typeof ribbon.setContext === 'function') {
            const ctx = ribbon.getContext();
            const hasOps = !!(saved && Array.isArray(saved.ops) && saved.ops.length > 0);
            const undoN = (saved && Array.isArray(saved.undoStack)) ? saved.undoStack.length : 0;
            const redoN = (saved && Array.isArray(saved.redoStack)) ? saved.redoStack.length : 0;
            ribbon.setContext(Object.assign({}, ctx, {
              hasOverlay: hasOps,
              undoCount: undoN,
              redoCount: redoN,
            }));
          }
        } catch (_) { /* swallow */ }
        return { ok: true, overlay: saved, outcome: outcome };
      }, function (err) {
        return { ok: false, reason: 'upsert-failed', error: String((err && err.message) || err || '') };
      });
    }, function (err) {
      return { ok: false, reason: 'get-failed', error: String((err && err.message) || err || '') };
    });
  }).catch(function (err) {
    return { ok: false, reason: 'error', error: String((err && err.message) || err || '') };
  });
}

/* Phase 2d — shared helper that re-applies an overlay record to the live
 * reader DOM and republishes hasOverlay/undoCount/redoCount to the
 * ribbon context. Used by RibbonBridge.undo / RibbonBridge.redo after
 * each stack manipulation. Never throws. */
function __ribbonBridge_publishAndRender(snap, saved){
  let outcome = null;
  try {
    const ov = W.H2O?.Studio?.overlay;
    const readerEl = document.getElementById('viewReader');
    const frame = readerEl && readerEl.querySelector('.cgFrame');
    if (frame && ov && typeof ov.applyOverlay === 'function') {
      outcome = ov.applyOverlay(frame, snap, saved);
      /* Phase 5b-1 — inline render pass after undo/redo stack change. */
      try { __inlineRender_apply(frame, snap, saved); } catch (_) {}
    }
  } catch (_) { /* swallow — apply failure does not invalidate the persisted stack change */ }
  try {
    const ribbon = W.H2O?.Studio?.ribbon;
    if (ribbon && typeof ribbon.setContext === 'function') {
      const ctx = ribbon.getContext();
      const hasOps = !!(saved && Array.isArray(saved.ops) && saved.ops.length > 0);
      const undoN = (saved && Array.isArray(saved.undoStack)) ? saved.undoStack.length : 0;
      const redoN = (saved && Array.isArray(saved.redoStack)) ? saved.redoStack.length : 0;
      ribbon.setContext(Object.assign({}, ctx, {
        hasOverlay: hasOps,
        undoCount: undoN,
        redoCount: redoN,
      }));
    }
  } catch (_) { /* swallow */ }
  return outcome;
}

/* Phase 8g-1 — message-level Format Painter apply. Replays a captured
 * message-level formatting set onto the target turn using ONLY the existing
 * message-level overlay ops (heading / quote / code / callout / list / align /
 * indent / text-color / font-family / font-size / bold / italic / underline /
 * strikethrough / visual-tag). Each dimension is SET to the source value —
 * including clearing to null/false when the source lacks it — so the target's
 * message-level look matches the source. To keep undo steps minimal, only
 * dimensions whose CURRENT target value differs from the source are appended.
 * NEVER touches message text / text-replace / inline ranges / structure /
 * highlights / snapshot; adds NO new OverlayOpType. Persists + re-renders
 * ONCE via publishAndRender. Read-only wrt the snapshot; never throws.
 * Returns { ok, applied:[dims], failed:[dims], reason? }. */
function __ribbonBridge_applyMessageFormatPaint(targetTurnIdx, formatPayload){
  return Promise.resolve().then(function () {
    const result = { ok: false, applied: [], failed: [], reason: '' };
    const idx = Number(targetTurnIdx);
    if (!Number.isInteger(idx) || idx < 1) { result.reason = 'invalid-turn'; return result; }
    const src = (formatPayload && typeof formatPayload === 'object') ? formatPayload : null;
    if (!src) { result.reason = 'no-payload'; return result; }

    const snap = state && state.currentReaderSnapshot;
    if (!snap || !snap.snapshotId) { result.reason = 'no-snapshot'; return result; }
    const messages = Array.isArray(snap.messages) ? snap.messages : [];
    if (idx > messages.length) { result.reason = 'invalid-turn'; return result; }
    const ov = W.H2O?.Studio?.overlay;
    const ovStore = W.H2O?.Studio?.store?.editOverlay;
    if (!ov || typeof ov.appendOp !== 'function' || typeof ov.computeBaseDigest !== 'function' || typeof ov.computeMessageState !== 'function') {
      result.reason = 'overlay-unavailable'; return result;
    }
    if (!ovStore || typeof ovStore.get !== 'function' || typeof ovStore.upsert !== 'function') { result.reason = 'store-unavailable'; return result; }

    const target = { kind: 'message', turnIdx: idx };
    const hLvl = (src.heading && (Number(src.heading.level) === 1 || Number(src.heading.level) === 2 || Number(src.heading.level) === 3)) ? Number(src.heading.level) : null;
    const alignVal = (src.align === 'left' || src.align === 'center' || src.align === 'right') ? src.align : null;
    const calloutKind = (src.callout && src.callout.kind) ? String(src.callout.kind) : null;
    const listKind = (src.list && src.list.kind) ? String(src.list.kind) : null;
    const colorKind = (src.textColor && src.textColor.kind) ? String(src.textColor.kind) : null;
    const ffTok = (src.fontFamily && src.fontFamily.token) ? String(src.fontFamily.token) : null;
    const fsTok = (src.fontSize && src.fontSize.token) ? String(src.fontSize.token) : null;
    const indentLvl = Number(src.indent) || 0;
    const VT = ['todo', 'important', 'question', 'definition', 'warning', 'idea'];
    const vt = (src.visualTags && typeof src.visualTags === 'object') ? src.visualTags : {};

    const sid = String(snap.snapshotId);
    return Promise.resolve(ovStore.get(sid)).then(function (existing) {
      let overlay = existing;
      if (!overlay) {
        try { overlay = ov.createEmpty({ snapshot: snap }); } catch (_) { overlay = null; }
        if (!overlay) { result.reason = 'create-empty-failed'; return result; }
      }
      const currentDigest = ov.computeBaseDigest(snap);
      if (overlay.baseDigest && overlay.baseDigest !== currentDigest) { result.reason = 'drift-detected'; return result; }

      /* Current target message-level state → append only CHANGED dimensions. */
      let cur = {};
      try { cur = ov.computeMessageState(overlay, idx) || {}; } catch (_) { cur = {}; }
      const curVt = (cur.visualTags && typeof cur.visualTags === 'object') ? cur.visualTags : {};
      const plan = [
        { dim: 'heading',       type: 'heading',       cur: (cur.heading && cur.heading.level) || null,        next: hLvl,        payload: { level: hLvl } },
        { dim: 'quote',         type: 'quote',         cur: !!cur.quote,                                        next: !!src.quote, payload: { enabled: !!src.quote } },
        { dim: 'code',          type: 'code',          cur: !!cur.code,                                         next: !!src.code,  payload: { enabled: !!src.code } },
        { dim: 'callout',       type: 'callout',       cur: (cur.callout && cur.callout.kind) || null,          next: calloutKind, payload: { kind: calloutKind } },
        { dim: 'list',          type: 'list',          cur: (cur.list && cur.list.kind) || null,                next: listKind,    payload: { kind: listKind } },
        { dim: 'align',         type: 'align',         cur: cur.align || null,                                  next: alignVal,    payload: { value: alignVal } },
        { dim: 'indent',        type: 'indent',        cur: Number(cur.indent) || 0,                            next: indentLvl,   payload: { level: indentLvl } },
        { dim: 'text-color',    type: 'text-color',    cur: (cur.textColor && cur.textColor.kind) || null,      next: colorKind,   payload: { kind: colorKind } },
        { dim: 'font-family',   type: 'font-family',   cur: (cur.fontFamily && cur.fontFamily.token) || null,   next: ffTok,       payload: { token: ffTok } },
        { dim: 'font-size',     type: 'font-size',     cur: (cur.fontSize && cur.fontSize.token) || null,       next: fsTok,       payload: { size: fsTok } },
        { dim: 'bold',          type: 'bold',          cur: !!cur.bold,          next: !!src.bold,          payload: { enabled: !!src.bold } },
        { dim: 'italic',        type: 'italic',        cur: !!cur.italic,        next: !!src.italic,        payload: { enabled: !!src.italic } },
        { dim: 'underline',     type: 'underline',     cur: !!cur.underline,     next: !!src.underline,     payload: { enabled: !!src.underline } },
        { dim: 'strikethrough', type: 'strikethrough', cur: !!cur.strikethrough, next: !!src.strikethrough, payload: { enabled: !!src.strikethrough } },
      ];
      for (let v = 0; v < VT.length; v += 1) {
        plan.push({ dim: 'visual-tag:' + VT[v], type: 'visual-tag', cur: !!curVt[VT[v]], next: !!vt[VT[v]], payload: { kind: VT[v], enabled: !!vt[VT[v]] } });
      }

      const base = Array.isArray(overlay.ops) ? overlay.ops.length : 0;
      let acc = overlay;
      for (let i = 0; i < plan.length; i += 1) {
        if (plan[i].cur === plan[i].next) continue; /* no change → skip (fewer undo steps) */
        try {
          const nx = ov.appendOp(acc, { type: plan[i].type, target: target, payload: plan[i].payload });
          if (nx) { acc = nx; result.applied.push(plan[i].dim); }
          else { result.failed.push(plan[i].dim); }
        } catch (_) { result.failed.push(plan[i].dim); }
      }
      if (result.applied.length === 0 && result.failed.length === 0) { result.ok = true; result.reason = 'no-change'; return result; }
      if (result.applied.length === 0) { result.reason = 'no-ops-applied'; return result; }

      /* Phase 8g-3b — group this multi-op paint for one-step undo/redo. */
      __ribbonBridge_stampGroupId(acc, base);

      return Promise.resolve(ovStore.upsert(acc)).then(function (saved) {
        try { __ribbonBridge_publishAndRender(snap, saved); } catch (_) { /* persisted ops stand */ }
        result.ok = true;
        return result;
      }, function (err) {
        result.reason = 'upsert-failed';
        result.error = String((err && err.message) || err || '');
        return result;
      });
    }, function () {
      result.reason = 'store-read-failed';
      return result;
    });
  }).catch(function () {
    return { ok: false, applied: [], failed: [], reason: 'error' };
  });
}

/* Phase 8g-2a — inline-range Format Painter apply. Replays a captured inline
 * STYLE SET (bold/italic/underline/strikethrough/subscript/superscript/
 * textColor) onto the TARGET's held selection range using ONLY existing
 * `inline-format` ops. Source character offsets are NEVER transferred — the
 * target range comes from `targetAnchor.textPos` (the target's own held
 * selection). Each channel is SET to the captured value (incl. clearing to
 * false/null), so the target range matches the source style set; sub/sup
 * mutual exclusion is enforced by the reducer. Only CHANGED channels are
 * appended (fewer undo steps); persist + render ONCE. Blocks a text-replaced
 * target (`target-text-replaced`) since inline is suppressed there and offsets
 * cannot rebase. Never touches text / message-level state / structure /
 * highlights / snapshot; adds NO new OverlayOpType. Never throws. Returns
 * { ok, applied:[dims], failed:[dims], reason? }. */
function __ribbonBridge_applyInlineFormatPaint(targetTurnIdx, targetAnchor, styles){
  return Promise.resolve().then(function () {
    const result = { ok: false, applied: [], failed: [], reason: '' };
    const idx = Number(targetTurnIdx);
    if (!Number.isInteger(idx) || idx < 1) { result.reason = 'invalid-turn'; return result; }
    const anchor = (targetAnchor && typeof targetAnchor === 'object') ? targetAnchor : null;
    const pos = anchor && anchor.textPos;
    const start = pos ? Number(pos.start) : NaN;
    const end = pos ? Number(pos.end) : NaN;
    if (!pos || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) { result.reason = 'invalid-anchor'; return result; }
    const sty = (styles && typeof styles === 'object') ? styles : null;
    if (!sty) { result.reason = 'no-styles'; return result; }

    const snap = state && state.currentReaderSnapshot;
    if (!snap || !snap.snapshotId) { result.reason = 'no-snapshot'; return result; }
    const ov = W.H2O?.Studio?.overlay;
    const ovStore = W.H2O?.Studio?.store?.editOverlay;
    if (!ov || typeof ov.appendOp !== 'function' || typeof ov.computeBaseDigest !== 'function' || typeof ov.computeInlineState !== 'function') { result.reason = 'overlay-unavailable'; return result; }
    if (!ovStore || typeof ovStore.get !== 'function' || typeof ovStore.upsert !== 'function') { result.reason = 'store-unavailable'; return result; }

    /* Kind of a color segment that FULLY covers [start,end], else null. */
    function colorKindOver(segs) {
      if (!Array.isArray(segs)) return null;
      for (let i = 0; i < segs.length; i += 1) {
        const g = segs[i];
        if (g && Number(g.start) <= start && Number(g.end) >= end) return (g.kind == null ? null : String(g.kind));
      }
      return null;
    }
    const wantColor = (sty.textColor && typeof sty.textColor === 'object' && sty.textColor.kind) ? String(sty.textColor.kind)
      : (typeof sty.textColor === 'string' && sty.textColor ? sty.textColor : null);

    const sid = String(snap.snapshotId);
    return Promise.resolve(ovStore.get(sid)).then(function (existing) {
      let overlay = existing;
      if (!overlay) {
        try { overlay = ov.createEmpty({ snapshot: snap }); } catch (_) { overlay = null; }
        if (!overlay) { result.reason = 'create-empty-failed'; return result; }
      }
      const currentDigest = ov.computeBaseDigest(snap);
      if (overlay.baseDigest && overlay.baseDigest !== currentDigest) { result.reason = 'drift-detected'; return result; }

      /* Block a text-replaced target: inline is suppressed + offsets can't rebase. */
      let ms = {};
      try { if (typeof ov.computeMessageState === 'function') ms = ov.computeMessageState(overlay, idx) || {}; } catch (_) { ms = {}; }
      if (ms.textReplace && typeof ms.textReplace.body === 'string') { result.reason = 'target-text-replaced'; return result; }

      /* Current target inline coverage over [start,end] → append only changed channels. */
      let cur = {};
      try { cur = ov.computeInlineState(overlay, idx) || {}; } catch (_) { cur = {}; }
      const cover = function (list) { return (typeof ov.intervalsCover === 'function' && Array.isArray(list)) ? !!ov.intervalsCover(list, start, end) : false; };
      const anchorTarget = { kind: 'inline', turnIdx: idx, messageId: (anchor.messageId || null), anchor: { textPos: { start: start, end: end } } };
      const plan = [
        { dim: 'bold',          cur: cover(cur.bold),          next: !!sty.bold,          payload: { style: 'bold',          enabled: !!sty.bold } },
        { dim: 'italic',        cur: cover(cur.italic),        next: !!sty.italic,        payload: { style: 'italic',        enabled: !!sty.italic } },
        { dim: 'underline',     cur: cover(cur.underline),     next: !!sty.underline,     payload: { style: 'underline',     enabled: !!sty.underline } },
        { dim: 'strikethrough', cur: cover(cur.strikethrough), next: !!sty.strikethrough, payload: { style: 'strikethrough', enabled: !!sty.strikethrough } },
        { dim: 'subscript',     cur: cover(cur.subscript),     next: !!sty.subscript,     payload: { style: 'subscript',     enabled: !!sty.subscript } },
        { dim: 'superscript',   cur: cover(cur.superscript),   next: !!sty.superscript,   payload: { style: 'superscript',   enabled: !!sty.superscript } },
        { dim: 'text-color',    cur: colorKindOver(cur.textColor), next: wantColor,        payload: { style: 'text-color',    kind: wantColor } },
      ];

      const base = Array.isArray(overlay.ops) ? overlay.ops.length : 0;
      let acc = overlay;
      for (let i = 0; i < plan.length; i += 1) {
        if (plan[i].cur === plan[i].next) continue; /* no change → skip (fewer undo steps) */
        try {
          const nx = ov.appendOp(acc, { type: 'inline-format', target: anchorTarget, payload: plan[i].payload });
          if (nx) { acc = nx; result.applied.push(plan[i].dim); }
          else { result.failed.push(plan[i].dim); }
        } catch (_) { result.failed.push(plan[i].dim); }
      }
      if (result.applied.length === 0 && result.failed.length === 0) { result.ok = true; result.reason = 'no-change'; return result; }
      if (result.applied.length === 0) { result.reason = 'no-ops-applied'; return result; }

      /* Phase 8g-3b — group this multi-op paint for one-step undo/redo. */
      __ribbonBridge_stampGroupId(acc, base);

      return Promise.resolve(ovStore.upsert(acc)).then(function (saved) {
        try { __ribbonBridge_publishAndRender(snap, saved); } catch (_) { /* persisted ops stand */ }
        result.ok = true;
        return result;
      }, function (err) {
        result.reason = 'upsert-failed';
        result.error = String((err && err.message) || err || '');
        return result;
      });
    }, function () {
      result.reason = 'store-read-failed';
      return result;
    });
  }).catch(function () {
    return { ok: false, applied: [], failed: [], reason: 'error' };
  });
}

/* Phase 2d — derive a short human label from an op (for status feedback
 * like "Undone: H2", "Redone: Section"). Returns null when the op has no
 * recognisable shape. Synchronous, never throws. Labels are advisory
 * only — no i18n. */
function __ribbonBridge_labelForOp(op){
  try {
    if (!op || typeof op !== 'object') return null;
    const type = String(op.type || '');
    const payload = (op.payload && typeof op.payload === 'object') ? op.payload : {};
    switch (type) {
      case 'heading': {
        const lvl = Number(payload.level);
        if (lvl === 1 || lvl === 2 || lvl === 3) return 'H' + lvl;
        return 'Heading';
      }
      case 'quote':         return 'Quote';
      case 'code':
      case 'code-block':    return 'Code block';
      case 'callout':       return 'Callout';
      case 'clean-spacing': return 'Clean spacing';
      case 'add-section':
      case 'split-section': return 'Section';
      case 'collapse-section': return payload.collapsed ? 'Collapse' : 'Expand';
      case 'page-divider':  return 'Divider';
      case 'toc':           return payload.position ? 'TOC on' : 'TOC off';
      default:              return type || null;
    }
  } catch (_) { return null; }
}

/* Phase 8g-3b — find an op by id (most-recent-first). Shared by group-aware
 * undo/redo. Synchronous, never throws. */
function __ribbonBridge_findOpById(overlay, id){
  const ops = (overlay && Array.isArray(overlay.ops)) ? overlay.ops : [];
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    if (ops[i] && String(ops[i].id) === String(id)) return ops[i];
  }
  return null;
}

/* Phase 8g-3b — stamp a shared groupId on the ops appended since `base`
 * (only when 2+ were added). Mutates overlay.ops in place — these are the
 * fresh, unshared op objects this paint just appended — so the whole batch
 * undoes/redoes in ONE step. groupId rides along inside the wholesale-cloned
 * ops and is inert to reducers/serializers. No new op type; no schema change.
 * Returns the gid, or null when nothing was stamped. Never throws. */
function __ribbonBridge_stampGroupId(overlay, base){
  try {
    const ops = (overlay && Array.isArray(overlay.ops)) ? overlay.ops : null;
    if (!ops || (ops.length - base) < 2) return null;
    const gid = 'fpg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    for (let i = base; i < ops.length; i += 1) { if (ops[i]) ops[i].groupId = gid; }
    return gid;
  } catch (_) { return null; }
}

/* Phase 2d — undo the most recent active op on the current snapshot's
 * overlay. Uses the reducer-filter active-set model: ops are NOT deleted
 * from overlay.ops; instead the op id is moved from undoStack to
 * redoStack and the reducer simply stops applying it. Drift-checks
 * against the current snapshot baseDigest with the same logic
 * applyOverlayOp uses — refuses safely on drift without mutating the
 * stacks. Returns Promise<{ ok, reason?, overlay?, outcome?,
 * undoCount?, redoCount?, label? }>. Never throws. */
function __ribbonBridge_undo(){
  return Promise.resolve().then(function () {
    const snap = state && state.currentReaderSnapshot;
    if (!snap || !snap.snapshotId) return { ok: false, reason: 'no-snapshot' };
    const ov = W.H2O?.Studio?.overlay;
    const ovStore = W.H2O?.Studio?.store?.editOverlay;
    if (!ov || typeof ov.computeBaseDigest !== 'function' || typeof ov.popUndo !== 'function') {
      return { ok: false, reason: 'overlay-unavailable' };
    }
    if (!ovStore || typeof ovStore.get !== 'function' || typeof ovStore.upsert !== 'function') {
      return { ok: false, reason: 'store-unavailable' };
    }
    const sid = String(snap.snapshotId);
    return Promise.resolve(ovStore.get(sid)).then(function (existing) {
      if (!existing) return { ok: false, reason: 'no-overlay' };
      const undo = Array.isArray(existing.undoStack) ? existing.undoStack : [];
      if (undo.length === 0) return { ok: false, reason: 'no-undo', undoCount: 0, redoCount: Array.isArray(existing.redoStack) ? existing.redoStack.length : 0 };
      /* Drift check — same precedent as applyOverlayOp. Refuses safely
       * without mutating either stack. */
      const currentDigest = ov.computeBaseDigest(snap);
      if (existing.baseDigest && existing.baseDigest !== currentDigest) {
        return { ok: false, reason: 'drift-detected', overlay: existing, currentDigest: currentDigest };
      }
      /* Identify the op about to be undone (for the label + group check). */
      const undoneOpId = undo[undo.length - 1];
      const undoneOp = __ribbonBridge_findOpById(existing, undoneOpId);
      /* Phase 8g-3b — one-step group undo: when the top op belongs to a
       * Format Painter batch, pop the whole contiguous same-groupId run in
       * memory (bounded guard), then persist + render ONCE. Ungrouped ops
       * keep the pre-8g-3b single-pop behavior. */
      const gid = (undoneOp && undoneOp.groupId != null) ? String(undoneOp.groupId) : null;
      let next = existing;
      if (gid) {
        let popped = 0, guard = 0;
        while (next && Array.isArray(next.undoStack) && next.undoStack.length && guard < 1000) {
          const tId = next.undoStack[next.undoStack.length - 1];
          const tOp = __ribbonBridge_findOpById(next, tId);
          if (!tOp || String(tOp.groupId) !== gid) break;
          const p = ov.popUndo(next);
          if (!p) break;
          next = p; popped += 1; guard += 1;
        }
        if (popped === 0) next = ov.popUndo(existing);
      } else {
        next = ov.popUndo(existing);
      }
      if (!next) return { ok: false, reason: 'pop-undo-failed' };
      return Promise.resolve(ovStore.upsert(next)).then(function (saved) {
        const outcome = __ribbonBridge_publishAndRender(snap, saved);
        return {
          ok: true,
          overlay: saved,
          outcome: outcome,
          undoCount: (saved && Array.isArray(saved.undoStack)) ? saved.undoStack.length : 0,
          redoCount: (saved && Array.isArray(saved.redoStack)) ? saved.redoStack.length : 0,
          label: gid ? 'Format Painter' : __ribbonBridge_labelForOp(undoneOp),
        };
      }, function (err) {
        return { ok: false, reason: 'upsert-failed', error: String((err && err.message) || err || '') };
      });
    }, function (err) {
      return { ok: false, reason: 'get-failed', error: String((err && err.message) || err || '') };
    });
  }).catch(function (err) {
    return { ok: false, reason: 'error', error: String((err && err.message) || err || '') };
  });
}

/* Phase 2d — redo the most recently-undone op on the current snapshot's
 * overlay. Mirror of __ribbonBridge_undo: moves an id from redoStack
 * back onto undoStack, re-renders, republishes counts. Drift-checks
 * identically. Never throws. */
function __ribbonBridge_redo(){
  return Promise.resolve().then(function () {
    const snap = state && state.currentReaderSnapshot;
    if (!snap || !snap.snapshotId) return { ok: false, reason: 'no-snapshot' };
    const ov = W.H2O?.Studio?.overlay;
    const ovStore = W.H2O?.Studio?.store?.editOverlay;
    if (!ov || typeof ov.computeBaseDigest !== 'function' || typeof ov.popRedo !== 'function') {
      return { ok: false, reason: 'overlay-unavailable' };
    }
    if (!ovStore || typeof ovStore.get !== 'function' || typeof ovStore.upsert !== 'function') {
      return { ok: false, reason: 'store-unavailable' };
    }
    const sid = String(snap.snapshotId);
    return Promise.resolve(ovStore.get(sid)).then(function (existing) {
      if (!existing) return { ok: false, reason: 'no-overlay' };
      const redo = Array.isArray(existing.redoStack) ? existing.redoStack : [];
      if (redo.length === 0) return { ok: false, reason: 'no-redo', undoCount: Array.isArray(existing.undoStack) ? existing.undoStack.length : 0, redoCount: 0 };
      const currentDigest = ov.computeBaseDigest(snap);
      if (existing.baseDigest && existing.baseDigest !== currentDigest) {
        return { ok: false, reason: 'drift-detected', overlay: existing, currentDigest: currentDigest };
      }
      const redoneOpId = redo[redo.length - 1];
      const redoneOp = __ribbonBridge_findOpById(existing, redoneOpId);
      /* Phase 8g-3b — one-step group redo: mirror of the group undo, against
       * redoStack. Re-promotes the whole Format Painter batch in one call. */
      const gid = (redoneOp && redoneOp.groupId != null) ? String(redoneOp.groupId) : null;
      let next = existing;
      if (gid) {
        let promoted = 0, guard = 0;
        while (next && Array.isArray(next.redoStack) && next.redoStack.length && guard < 1000) {
          const tId = next.redoStack[next.redoStack.length - 1];
          const tOp = __ribbonBridge_findOpById(next, tId);
          if (!tOp || String(tOp.groupId) !== gid) break;
          const p = ov.popRedo(next);
          if (!p) break;
          next = p; promoted += 1; guard += 1;
        }
        if (promoted === 0) next = ov.popRedo(existing);
      } else {
        next = ov.popRedo(existing);
      }
      if (!next) return { ok: false, reason: 'pop-redo-failed' };
      return Promise.resolve(ovStore.upsert(next)).then(function (saved) {
        const outcome = __ribbonBridge_publishAndRender(snap, saved);
        return {
          ok: true,
          overlay: saved,
          outcome: outcome,
          undoCount: (saved && Array.isArray(saved.undoStack)) ? saved.undoStack.length : 0,
          redoCount: (saved && Array.isArray(saved.redoStack)) ? saved.redoStack.length : 0,
          label: gid ? 'Format Painter' : __ribbonBridge_labelForOp(redoneOp),
        };
      }, function (err) {
        return { ok: false, reason: 'upsert-failed', error: String((err && err.message) || err || '') };
      });
    }, function (err) {
      return { ok: false, reason: 'get-failed', error: String((err && err.message) || err || '') };
    });
  }).catch(function (err) {
    return { ok: false, reason: 'error', error: String((err && err.message) || err || '') };
  });
}

/* Phase 2d — pure-read accessor for the Home tab Undo/Redo enable
 * rules. Returns Promise<{ undoCount, redoCount, lastUndoLabel?,
 * lastRedoLabel? }>. Empty stacks → 0/0 with no label fields. Never
 * throws. Treats missing undoStack as 0 (the active-set migration only
 * applies to the renderer; history counts always reflect the actual
 * arrays). */
function __ribbonBridge_getHistoryState(){
  const empty = { undoCount: 0, redoCount: 0 };
  try {
    const snap = state && state.currentReaderSnapshot;
    if (!snap || !snap.snapshotId) return Promise.resolve(empty);
    const ovStore = W.H2O?.Studio?.store?.editOverlay;
    if (!ovStore || typeof ovStore.get !== 'function') return Promise.resolve(empty);
    return Promise.resolve(ovStore.get(String(snap.snapshotId))).then(function (overlay) {
      if (!overlay) return empty;
      const undo = Array.isArray(overlay.undoStack) ? overlay.undoStack : [];
      const redo = Array.isArray(overlay.redoStack) ? overlay.redoStack : [];
      const ops = Array.isArray(overlay.ops) ? overlay.ops : [];
      const out = { undoCount: undo.length, redoCount: redo.length };
      if (undo.length > 0) {
        const topUndoId = String(undo[undo.length - 1]);
        for (let i = ops.length - 1; i >= 0; i -= 1) {
          if (ops[i] && String(ops[i].id) === topUndoId) {
            const lbl = __ribbonBridge_labelForOp(ops[i]);
            if (lbl) out.lastUndoLabel = lbl;
            break;
          }
        }
      }
      if (redo.length > 0) {
        const topRedoId = String(redo[redo.length - 1]);
        for (let j = ops.length - 1; j >= 0; j -= 1) {
          if (ops[j] && String(ops[j].id) === topRedoId) {
            const lbl2 = __ribbonBridge_labelForOp(ops[j]);
            if (lbl2) out.lastRedoLabel = lbl2;
            break;
          }
        }
      }
      return out;
    }, function () { return empty; });
  } catch (_) { return Promise.resolve(empty); }
}

/* Phase 5a — passive inline selection diagnostics. This mirrors the
 * existing highlighter anchor strategy (text quote + text position + XPath)
 * but does not write overlays, stores, snapshots, or DOM. */
function __inlineSelection_toElement(node){
  if (!node) return null;
  if (node.nodeType === 1) return node;
  return node.parentElement || null;
}

function __inlineSelection_normalizeText(value){
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function __inlineSelection_cssEscape(value){
  const raw = String(value || '');
  if (W.CSS && typeof W.CSS.escape === 'function') {
    try { return W.CSS.escape(raw); } catch (_) {}
  }
  return raw.replace(/["\\]/g, '\\$&');
}

function __inlineSelection_getReaderScroll(){
  try {
    const readerEl = document.getElementById('viewReader');
    if (!readerEl || readerEl.hidden) return null;
    const frame = readerEl.querySelector('.cgFrame');
    return frame && frame.querySelector('.cgScroll');
  } catch (_) { return null; }
}

function __inlineSelection_isSavedReaderMounted(){
  try {
    return !!(state && state.currentReaderSnapshot && state.currentReaderSnapshot.snapshotId && __inlineSelection_getReaderScroll());
  } catch (_) { return false; }
}

function __inlineSelection_isExcludedUi(node){
  const el = __inlineSelection_toElement(node);
  if (!el || typeof el.closest !== 'function') return true;
  return !!el.closest([
    '#studioRibbon',
    '.wbRibbon',
    '.wbRibbonMetadataPopover',
    '.wbTop',
    '#studioDock',
    '.wbDock',
    '[role="dialog"]',
    '.wbEditWrap',
    '.wbEditTextarea',
    'button',
    'input',
    'select',
    'textarea',
    '[contenteditable="true"]'
  ].join(','));
}

function __inlineSelection_turnForNode(node, scrollEl){
  const el = __inlineSelection_toElement(node);
  if (!el || !scrollEl || typeof el.closest !== 'function') return null;
  const turn = el.closest('[data-turn]');
  if (!turn || !scrollEl.contains(turn)) return null;
  return turn;
}

function __inlineSelection_turnIndex(turnEl, scrollEl){
  if (!turnEl || !scrollEl) return 0;
  const turns = Array.prototype.slice.call(scrollEl.querySelectorAll('[data-turn]'));
  return turns.indexOf(turnEl) + 1;
}

function __inlineSelection_messageForNode(node, turnEl){
  const el = __inlineSelection_toElement(node);
  if (!el || !turnEl || typeof el.closest !== 'function') return null;
  const direct = el.closest('[data-message-author-role], [data-message-id]');
  if (direct && turnEl.contains(direct)) return direct;
  return turnEl.querySelector('[data-message-author-role], [data-message-id]') || turnEl;
}

function __inlineSelection_readMessageId(messageEl, turnEl){
  const candidates = [messageEl, turnEl];
  try {
    const nested = turnEl && turnEl.querySelector && turnEl.querySelector('[data-message-id]');
    if (nested) candidates.push(nested);
  } catch (_) {}
  for (let i = 0; i < candidates.length; i += 1) {
    const el = candidates[i];
    const value = String(
      (el && el.getAttribute && el.getAttribute('data-message-id'))
      || (el && el.dataset && el.dataset.messageId)
      || ''
    ).trim();
    if (value) return value;
  }
  return null;
}

function __inlineSelection_readRole(messageEl, turnEl){
  const raw = String(
    (messageEl && messageEl.getAttribute && messageEl.getAttribute('data-message-author-role'))
    || (turnEl && turnEl.getAttribute && turnEl.getAttribute('data-turn'))
    || ''
  ).trim().toLowerCase();
  return raw || null;
}

function __inlineSelection_flatten(root){
  const out = { plain: '', map: [], length: 0 };
  if (!root || !document.createTreeWalker) return out;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node){
      return node && node.nodeValue && node.nodeValue.length
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    }
  });
  let node = null;
  while ((node = walker.nextNode())) {
    const text = String(node.nodeValue || '');
    const start = out.length;
    const end = start + text.length;
    out.map.push({ node, start, end });
    out.plain += text;
    out.length = end;
  }
  return out;
}

function __inlineSelection_offsetInRoot(root, node, offset){
  if (!root || !node) return null;
  try {
    const r = document.createRange();
    r.selectNodeContents(root);
    r.setEnd(node, Math.max(0, Number(offset) || 0));
    return r.toString().length;
  } catch (_) { return null; }
}

function __inlineSelection_rangeToPos(range, root){
  if (!range || !root) return null;
  const start = __inlineSelection_offsetInRoot(root, range.startContainer, range.startOffset);
  const end = __inlineSelection_offsetInRoot(root, range.endContainer, range.endOffset);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null;
  return { start, end };
}

function __inlineSelection_posToRange(pos, root){
  if (!pos || !root) return null;
  const flat = __inlineSelection_flatten(root);
  const start = Math.max(0, Math.floor(Number(pos.start) || 0));
  const end = Math.max(0, Math.floor(Number(pos.end) || 0));
  if (start >= end || end > flat.length) return null;
  const locate = (offset) => {
    for (let i = 0; i < flat.map.length; i += 1) {
      const seg = flat.map[i];
      if (offset >= seg.start && offset <= seg.end) return { node: seg.node, offset: offset - seg.start };
    }
    return null;
  };
  const a = locate(start);
  const b = locate(end);
  if (!a || !b) return null;
  try {
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    return r;
  } catch (_) { return null; }
}

function __inlineSelection_rangeToQuote(range, root, ctx){
  const pos = __inlineSelection_rangeToPos(range, root);
  if (!pos) return null;
  const flat = __inlineSelection_flatten(root);
  const size = Math.max(0, Math.floor(Number(ctx) || 32));
  return {
    exact: flat.plain.slice(pos.start, pos.end),
    prefix: flat.plain.slice(Math.max(0, pos.start - size), pos.start),
    suffix: flat.plain.slice(pos.end, Math.min(flat.length, pos.end + size)),
    approx: pos.start,
  };
}

function __inlineSelection_findByQuote(root, quote){
  if (!root || !quote || !quote.exact) return null;
  const flat = __inlineSelection_flatten(root);
  const exact = String(quote.exact || '');
  const prefix = String(quote.prefix || '');
  const suffix = String(quote.suffix || '');
  const approx = Number.isFinite(Number(quote.approx)) ? Math.max(0, Math.floor(Number(quote.approx))) : null;
  const matches = [];
  for (let idx = flat.plain.indexOf(exact); idx !== -1; idx = flat.plain.indexOf(exact, idx + 1)) {
    const end = idx + exact.length;
    if (prefix && !flat.plain.slice(Math.max(0, idx - prefix.length), idx).endsWith(prefix)) continue;
    if (suffix && !flat.plain.slice(end, end + suffix.length).startsWith(suffix)) continue;
    matches.push({ start: idx, dist: approx == null ? 0 : Math.abs(idx - approx) });
  }
  if (!matches.length) return null;
  matches.sort(function (a, b) {
    if (a.dist !== b.dist) return a.dist - b.dist;
    return a.start - b.start;
  });
  return __inlineSelection_posToRange({ start: matches[0].start, end: matches[0].start + exact.length }, root);
}

function __inlineSelection_rangeMatchesQuote(range, quote){
  if (!range) return false;
  if (!quote || !quote.exact) return true;
  const actual = String(range.toString() || '');
  if (actual === String(quote.exact || '')) return true;
  return __inlineSelection_normalizeText(actual) === __inlineSelection_normalizeText(quote.exact);
}

function __inlineSelection_textSiblingIndex(node){
  let index = 1;
  let prev = node;
  while ((prev = prev.previousSibling)) {
    if (prev.nodeType === 3) index += 1;
  }
  return index;
}

function __inlineSelection_elementSiblingIndex(node){
  let index = 1;
  let prev = node;
  while ((prev = prev.previousSibling)) {
    if (prev.nodeType === 1 && prev.nodeName === node.nodeName) index += 1;
  }
  return index;
}

function __inlineSelection_xpathFromNode(node, root){
  if (!node || !root) return '';
  if (node === root) return '.';
  const parts = [];
  let cur = node;
  while (cur && cur !== root) {
    if (cur.nodeType === 3) {
      parts.unshift('text()[' + __inlineSelection_textSiblingIndex(cur) + ']');
    } else if (cur.nodeType === 1) {
      parts.unshift(cur.nodeName.toLowerCase() + '[' + __inlineSelection_elementSiblingIndex(cur) + ']');
    }
    cur = cur.parentNode;
  }
  return cur === root ? './' + parts.join('/') : '';
}

function __inlineSelection_nodeFromXPath(xpath, root){
  if (!xpath || !root) return null;
  try {
    const result = document.evaluate(String(xpath), root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return result && result.singleNodeValue ? result.singleNodeValue : null;
  } catch (_) { return null; }
}

function __inlineSelection_rangeToXPath(range, root){
  const pos = __inlineSelection_rangeToPos(range, root);
  const normalized = pos ? __inlineSelection_posToRange(pos, root) : null;
  if (!normalized) return null;
  return {
    startXPath: __inlineSelection_xpathFromNode(normalized.startContainer, root),
    startOffset: normalized.startOffset,
    endXPath: __inlineSelection_xpathFromNode(normalized.endContainer, root),
    endOffset: normalized.endOffset,
  };
}

function __inlineSelection_xpathToRange(anchor, root){
  if (!anchor || !root || !anchor.startXPath || !anchor.endXPath) return null;
  const startNode = __inlineSelection_nodeFromXPath(anchor.startXPath, root);
  const endNode = __inlineSelection_nodeFromXPath(anchor.endXPath, root);
  if (!startNode || !endNode || startNode.nodeType !== 3 || endNode.nodeType !== 3) return null;
  try {
    const r = document.createRange();
    const startOffset = Math.max(0, Math.min(startNode.nodeValue.length, Number(anchor.startOffset) || 0));
    const endOffset = Math.max(0, Math.min(endNode.nodeValue.length, Number(anchor.endOffset) || 0));
    r.setStart(startNode, startOffset);
    r.setEnd(endNode, endOffset);
    return r.collapsed ? null : r;
  } catch (_) { return null; }
}

function __inlineSelection_findRootFromDiagnostic(diag){
  const scrollEl = __inlineSelection_getReaderScroll();
  if (!scrollEl || !diag) return null;
  const messageId = String(diag.selectedMessageId || '').trim();
  if (messageId) {
    const sel = '[data-message-id="' + __inlineSelection_cssEscape(messageId) + '"]';
    try {
      const byId = scrollEl.querySelector(sel);
      const turn = byId && byId.closest && byId.closest('[data-turn]');
      if (byId && turn && scrollEl.contains(turn)) return { root: byId, turn };
    } catch (_) {}
  }
  const turnIdx = Math.max(1, Math.floor(Number(diag.selectedTurnIdx) || 0));
  if (turnIdx > 0) {
    const turns = Array.prototype.slice.call(scrollEl.querySelectorAll('[data-turn]'));
    const turn = turns[turnIdx - 1] || null;
    if (turn) {
      const root = turn.querySelector('[data-message-author-role], [data-message-id]') || turn;
      return { root, turn };
    }
  }
  return null;
}

function __inlineSelection_resolve(input){
  try {
    if (!__inlineSelection_isSavedReaderMounted()) return { ok: false, reason: 'not-saved-reader' };
    const diag = input && input.ok ? input : (input || {});
    const anchor = diag.anchor && typeof diag.anchor === 'object' ? diag.anchor : {};
    const located = __inlineSelection_findRootFromDiagnostic(diag);
    if (!located || !located.root) return { ok: false, reason: 'message-not-found' };
    let range = null;
    let method = '';
    if (anchor.textQuote) {
      range = __inlineSelection_findByQuote(located.root, anchor.textQuote);
      if (range) method = 'textQuote';
    }
    if (!range && anchor.textPos) {
      const byPos = __inlineSelection_posToRange(anchor.textPos, located.root);
      if (byPos && __inlineSelection_rangeMatchesQuote(byPos, anchor.textQuote)) {
        range = byPos;
        method = 'textPos';
      }
    }
    if (!range && anchor.xpath) {
      const byXpath = __inlineSelection_xpathToRange(anchor.xpath, located.root);
      if (byXpath && __inlineSelection_rangeMatchesQuote(byXpath, anchor.textQuote)) {
        range = byXpath;
        method = 'xpath';
      }
    }
    if (!range) return { ok: false, reason: 'selection-not-resolved' };
    return {
      ok: true,
      selectedText: String(range.toString() || ''),
      selectedTurnIdx: Math.max(1, Math.floor(Number(diag.selectedTurnIdx) || __inlineSelection_turnIndex(located.turn, __inlineSelection_getReaderScroll()))),
      selectedMessageId: diag.selectedMessageId || __inlineSelection_readMessageId(located.root, located.turn),
      role: diag.role || __inlineSelection_readRole(located.root, located.turn),
      method,
    };
  } catch (err) {
    return { ok: false, reason: 'resolve-error', error: String(err && (err.message || err) || err) };
  }
}

function __inlineSelection_capture(){
  try {
    if (!__inlineSelection_isSavedReaderMounted()) return { ok: false, reason: 'not-saved-reader' };
    if (typeof W.getSelection !== 'function') return { ok: false, reason: 'selection-api-unavailable' };
    const selection = W.getSelection();
    if (!selection || selection.rangeCount < 1) return { ok: false, reason: 'empty-selection' };
    const raw = selection.getRangeAt(0);
    if (!raw || raw.collapsed) return { ok: false, reason: 'empty-selection' };
    const selectedText = String(raw.toString() || '');
    if (!__inlineSelection_normalizeText(selectedText)) return { ok: false, reason: 'empty-selection' };
    if (__inlineSelection_isExcludedUi(raw.startContainer) || __inlineSelection_isExcludedUi(raw.endContainer) || __inlineSelection_isExcludedUi(raw.commonAncestorContainer)) {
      return { ok: false, reason: 'non-reader-selection' };
    }
    const scrollEl = __inlineSelection_getReaderScroll();
    const startTurn = __inlineSelection_turnForNode(raw.startContainer, scrollEl);
    const endTurn = __inlineSelection_turnForNode(raw.endContainer, scrollEl);
    if (!startTurn || !endTurn) return { ok: false, reason: 'non-reader-selection' };
    if (startTurn !== endTurn) return { ok: false, reason: 'selection-crosses-turns' };
    const startMsg = __inlineSelection_messageForNode(raw.startContainer, startTurn);
    const endMsg = __inlineSelection_messageForNode(raw.endContainer, startTurn);
    if (startMsg && endMsg && startMsg !== endMsg) return { ok: false, reason: 'selection-crosses-messages' };
    const messageEl = startMsg || endMsg || startTurn;
    if (!messageEl.contains(raw.startContainer) || !messageEl.contains(raw.endContainer)) {
      return { ok: false, reason: 'selection-outside-message' };
    }
    const range = raw.cloneRange();
    const textPos = __inlineSelection_rangeToPos(range, messageEl);
    const textQuote = __inlineSelection_rangeToQuote(range, messageEl, 32);
    const xpath = __inlineSelection_rangeToXPath(range, messageEl);
    if (!textPos || !textQuote || !xpath) return { ok: false, reason: 'anchor-unavailable' };
    return {
      ok: true,
      selectedText,
      selectedTurnIdx: __inlineSelection_turnIndex(startTurn, scrollEl),
      selectedMessageId: __inlineSelection_readMessageId(messageEl, startTurn),
      role: __inlineSelection_readRole(messageEl, startTurn),
      anchor: { textQuote, textPos, xpath },
    };
  } catch (err) {
    return { ok: false, reason: 'capture-error', error: String(err && (err.message || err) || err) };
  }
}

function __inlineSelection_selfCheck(){
  return {
    ok: true,
    version: '0.1.0-phase-5b-1',
    passive: true,
    hasSelectionApi: typeof W.getSelection === 'function',
    hasRangeApi: typeof document.createRange === 'function',
    savedReaderMounted: __inlineSelection_isSavedReaderMounted(),
    captureAvailable: typeof __inlineSelection_capture === 'function',
    resolveAvailable: typeof __inlineSelection_resolve === 'function',
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * Phase 5b-1 — inline Bold / Italic: range resolver + reader render pass
 *
 * resolveToRange is the range-returning sibling of Phase 5a's resolve()
 * (resolve returns only metadata). It reuses the same three-tier anchor
 * strategy (textQuote → textPos → xpath) and returns a live Range.
 *
 * The render pass is idempotent: it unwraps every prior
 * [data-overlay-inline] span in scope, then re-wraps from the overlay's
 * reduced interval sets. It NEVER mutates snap.messages and only touches
 * the live reader DOM (which is rebuilt from snapshot on every reader
 * mount, so injected spans are disposable). On baseDigest drift it skips
 * (mirrors the applier's no-op-on-drift invariant). Unresolved intervals
 * are counted and skipped — never thrown. Reader-only in 5b-1.
 * ───────────────────────────────────────────────────────────────────── */

function __inlineSelection_resolveToRange(anchorOrDiag, root){
  try {
    if (!root) return null;
    const anchor = (anchorOrDiag && anchorOrDiag.anchor && typeof anchorOrDiag.anchor === 'object')
      ? anchorOrDiag.anchor
      : (anchorOrDiag && typeof anchorOrDiag === 'object' ? anchorOrDiag : {});
    if (anchor.textQuote) {
      const byQuote = __inlineSelection_findByQuote(root, anchor.textQuote);
      if (byQuote) return byQuote;
    }
    if (anchor.textPos) {
      const byPos = __inlineSelection_posToRange(anchor.textPos, root);
      if (byPos && (!anchor.textQuote || __inlineSelection_rangeMatchesQuote(byPos, anchor.textQuote))) return byPos;
    }
    if (anchor.xpath) {
      const byXpath = __inlineSelection_xpathToRange(anchor.xpath, root);
      if (byXpath && (!anchor.textQuote || __inlineSelection_rangeMatchesQuote(byXpath, anchor.textQuote))) return byXpath;
    }
    return null;
  } catch (_) { return null; }
}

/* Unwrap every prior inline span in `scope`, hoisting children and
 * normalising adjacent text nodes. Returns the count removed. */
function __inlineRender_unwrapAll(scope){
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  let removed = 0;
  try {
    const els = scope.querySelectorAll('[data-overlay-inline]');
    for (let i = 0; i < els.length; i += 1) {
      const el = els[i];
      const p = el.parentNode;
      if (!p) continue;
      while (el.firstChild) p.insertBefore(el.firstChild, el);
      p.removeChild(el);
      try { if (p.normalize) p.normalize(); } catch (_) {}
      removed += 1;
    }
  } catch (_) { /* swallow */ }
  return removed;
}

/* Collect text nodes intersecting a range whose endpoints are text nodes
 * (posToRange guarantees this). Single-node fast path + multi-node walk. */
function __inlineRender_collectTextNodes(range){
  const startNode = range.startContainer;
  const endNode = range.endContainer;
  if (startNode === endNode) return [startNode];
  const root = range.commonAncestorContainer;
  const out = [];
  try {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let started = false;
    let n = null;
    while ((n = walker.nextNode())) {
      if (n === startNode) started = true;
      if (started) out.push(n);
      if (n === endNode) break;
    }
  } catch (_) { return [startNode]; }
  return out;
}

/* Wrap a resolved range in <strong>/<em data-overlay-inline>. Wraps
 * per-text-node (never surroundContents — that throws on partial node
 * selection). Skips slices already inside a same-style wrapper. Returns
 * the number of wrapper elements inserted. Mirrors the highlighter's
 * proven splitText technique. */
function __inlineRender_wrapRange(range, style, colorKind){
  if (!range || range.collapsed) return 0;
  const startNode = range.startContainer;
  const startOff = range.startOffset;
  const endNode = range.endContainer;
  const endOff = range.endOffset;
  if (!startNode || !endNode || startNode.nodeType !== 3 || endNode.nodeType !== 3) return 0;
  /* Phase 5b-1: bold→<strong>, italic→<em>. Phase 5c-1: underline→<u>,
   * strikethrough→<s>. Phase 5c-2: text-color→<span> carrying the color
   * VALUE in data-overlay-inline-color. The attribute value mirrors the
   * style name (text-color spans always use val="text-color"). */
  const TAG_BY_STYLE = { bold: 'strong', italic: 'em', underline: 'u', strikethrough: 's', subscript: 'sub', superscript: 'sup', 'text-color': 'span' };
  const isColor = (style === 'text-color');
  const val = (TAG_BY_STYLE[style] ? style : 'bold');
  const tag = TAG_BY_STYLE[val];
  /* Value-aware guard for color: skip only when already wrapped in the
   * SAME color (so red→blue re-wraps, same-color re-render does not). */
  const sel = isColor
    ? '[data-overlay-inline="text-color"][data-overlay-inline-color="' + String(colorKind) + '"]'
    : '[data-overlay-inline="' + val + '"]';
  let wrapped = 0;
  const nodes = __inlineRender_collectTextNodes(range);
  for (let i = 0; i < nodes.length; i += 1) {
    let tn = nodes[i];
    if (!tn || tn.nodeType !== 3) continue;
    let s = 0;
    let e = tn.nodeValue.length;
    if (tn === startNode) s = startOff;
    if (tn === endNode) e = endOff;
    if (e <= s) continue;
    const slice = tn.nodeValue.slice(s, e);
    if (!slice) continue;
    if (isColor && !slice.trim()) continue;
    try {
      if (tn.parentElement && typeof tn.parentElement.closest === 'function' && tn.parentElement.closest(sel)) {
        continue; /* already wrapped in same style (same color for text-color) */
      }
    } catch (_) { /* ignore */ }
    try {
      if (e < tn.nodeValue.length) tn.splitText(e);
      let mid = tn;
      if (s > 0) mid = tn.splitText(s);
      const el = document.createElement(tag);
      el.setAttribute('data-overlay-inline', val);
      if (isColor) el.setAttribute('data-overlay-inline-color', String(colorKind));
      if (mid.parentNode) {
        mid.parentNode.insertBefore(el, mid);
        el.appendChild(mid);
        wrapped += 1;
      }
    } catch (_) { /* swallow per-node */ }
  }
  return wrapped;
}

/* Idempotent inline render pass. Runs after ov.applyOverlay on the same
 * scope element. Never throws; never mutates snap.messages. */
function __inlineRender_apply(scopeEl, snap, overlay){
  const result = { applied: false, wrapped: 0, skipped: 0, unwrapped: 0 };
  try {
    if (!scopeEl || typeof scopeEl.querySelectorAll !== 'function') return result;
    /* Always unwrap prior spans first — guarantees DOM converges to the
     * current overlay state regardless of prior renders. */
    result.unwrapped = __inlineRender_unwrapAll(scopeEl);
    const ov = W.H2O?.Studio?.overlay;
    if (!ov || typeof ov.computeInlineState !== 'function') return result;
    if (!overlay || typeof overlay !== 'object') return result;
    /* Skip on drift — mirror the applier's no-op-on-drift invariant. */
    try {
      if (overlay.baseDigest && typeof ov.computeBaseDigest === 'function') {
        const cur = ov.computeBaseDigest(snap);
        if (cur !== overlay.baseDigest) return result;
      }
    } catch (_) { /* ignore digest failure — fall through */ }
    const turns = Array.prototype.slice.call(scopeEl.querySelectorAll('[data-turn]'));
    for (let t = 0; t < turns.length; t += 1) {
      const turn = turns[t];
      const turnIdx = t + 1;
      /* Phase 7b — Skip turns with an open editor (wbTurn--editing). The
       * inline unwrap pass above + the per-turn applyEditedMessageBody
       * below would otherwise clobber the in-flight textarea. The
       * editor's save handler explicitly re-renders this turn after
       * dispatching the text-replace op, so skipping here is safe. */
      if (turn.classList && turn.classList.contains('wbTurn--editing')) continue;
      /* Phase 7b — Apply full body text-replace BEFORE the inline
       * interval passes. computeInlineState short-circuits to empty for
       * replaced turns (intervals point at pre-edit offsets and cannot
       * be safely rebased), so the loops below are a no-op for them —
       * but we still need to paint the replacement body. Idempotent:
       * re-running with the same overlay produces the same DOM. */
      try {
        if (ov && typeof ov.computeMessageState === 'function') {
          const ms = ov.computeMessageState(overlay, turnIdx);
          if (ms && ms.textReplace && typeof ms.textReplace.body === 'string') {
            const msgEl = turn.querySelector('[data-message-author-role]');
            const role = msgEl && String(msgEl.getAttribute('data-message-author-role') || '');
            if (msgEl && role) {
              try { turn.classList.add('wbTurn--edited'); } catch (_) {}
              try { turn.setAttribute('data-overlay-edited', 'true'); } catch (_) {}
              getStudioChatRenderer().applyEditedMessageBody(msgEl, role, ms.textReplace.body);
            }
            continue;
          }
        }
      } catch (_) { /* swallow — fall through to inline pass */ }
      let inline = null;
      try { inline = ov.computeInlineState(overlay, turnIdx); }
      catch (_) { inline = null; }
      if (!inline) continue;
      const boldIv = Array.isArray(inline.bold) ? inline.bold : [];
      const italicIv = Array.isArray(inline.italic) ? inline.italic : [];
      const underlineIv = Array.isArray(inline.underline) ? inline.underline : [];
      const strikeIv = Array.isArray(inline.strikethrough) ? inline.strikethrough : [];
      /* Phase 8e-1 — vertical-align channels: subscript→<sub>, superscript→<sup>. */
      const subIv = Array.isArray(inline.subscript) ? inline.subscript : [];
      const supIv = Array.isArray(inline.superscript) ? inline.superscript : [];
      /* Phase 5c-2 — color segments: array of { start, end, kind }. */
      const colorSegs = Array.isArray(inline.textColor) ? inline.textColor : [];
      if (!boldIv.length && !italicIv.length && !underlineIv.length && !strikeIv.length && !subIv.length && !supIv.length && !colorSegs.length) continue;
      /* Same message-root basis as Phase 5a capture. */
      const msgRoot = (turn.querySelector && turn.querySelector('[data-message-author-role], [data-message-id]')) || turn;
      /* Fixed apply order → deterministic nesting + idempotent re-render.
       * Color is applied LAST so its <span> nests innermost. */
      const styles = [['bold', boldIv], ['italic', italicIv], ['underline', underlineIv], ['strikethrough', strikeIv], ['subscript', subIv], ['superscript', supIv]];
      for (let k = 0; k < styles.length; k += 1) {
        const style = styles[k][0];
        const intervals = styles[k][1];
        for (let m = 0; m < intervals.length; m += 1) {
          const iv = intervals[m];
          if (!Array.isArray(iv)) { result.skipped += 1; continue; }
          const span = Number(iv[1]) - Number(iv[0]);
          /* Re-resolve from offsets each time. Wrapping never changes
           * text CONTENT (only node boundaries), so the flattened-text
           * coordinate space stays valid across successive wraps. */
          const range = __inlineSelection_posToRange({ start: iv[0], end: iv[1] }, msgRoot);
          if (!range) { result.skipped += 1; continue; }
          const got = String(range.toString() || '').length;
          if (got !== span) { result.skipped += 1; continue; }
          const w = __inlineRender_wrapRange(range, style);
          if (w > 0) result.wrapped += w; else result.skipped += 1;
        }
      }
      /* Phase 5c-2 — paint color segments (value-carrying). */
      for (let cs = 0; cs < colorSegs.length; cs += 1) {
        const seg = colorSegs[cs];
        if (!seg || typeof seg !== 'object') { result.skipped += 1; continue; }
        const cstart = Number(seg.start);
        const cend = Number(seg.end);
        const ckind = seg.kind;
        if (!isFinite(cstart) || !isFinite(cend) || cend <= cstart || !ckind) { result.skipped += 1; continue; }
        const crange = __inlineSelection_posToRange({ start: cstart, end: cend }, msgRoot);
        if (!crange) { result.skipped += 1; continue; }
        if (String(crange.toString() || '').length !== (cend - cstart)) { result.skipped += 1; continue; }
        const cw = __inlineRender_wrapRange(crange, 'text-color', ckind);
        if (cw > 0) result.wrapped += cw; else result.skipped += 1;
      }
    }
    result.applied = true;
  } catch (_) { /* never throw — inline render must not break the reader */ }
  return result;
}

/* Phase 5b-1 — held inline-selection capture. The ribbon B/I buttons
 * read this at click time: clicking a ribbon button blurs the reader and
 * collapses window.getSelection(), so we snapshot the LAST SUCCESSFUL
 * capture on selectionchange and never overwrite it with a failure. The
 * consumer validates turnIdx + re-resolution before using it. */
var __heldInlineCapture = null;
function __inlineSelection_getHeldCapture(){ return __heldInlineCapture; }
function __inlineSelection_clearHeldCapture(){ __heldInlineCapture = null; }
try {
  if (!W.__h2oInlineSelectionListenerInstalled && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    W.__h2oInlineSelectionListenerInstalled = true;
    document.addEventListener('selectionchange', function () {
      try {
        const cap = __inlineSelection_capture();
        /* Only store OK captures so a button-click selection collapse
         * does not wipe the held value. */
        if (cap && cap.ok) { cap.__heldAt = Date.now(); __heldInlineCapture = cap; }
      } catch (_) { /* swallow */ }
    });
  }
} catch (_) { /* swallow */ }

/* Phase 5b-1 — bridge accessor: inline interval state for a turn. Thin
 * wrapper over computeInlineState; used by the ribbon to decide
 * toggle-off vs toggle-on for a selected range. Never throws. */
function __ribbonBridge_getInlineStateForTurn(turnIdx){
  const empty = { bold: [], italic: [], underline: [], strikethrough: [], textColor: [] };
  try {
    const snap = state && state.currentReaderSnapshot;
    if (!snap || !snap.snapshotId) return Promise.resolve(empty);
    const ovStore = W.H2O?.Studio?.store?.editOverlay;
    const ov = W.H2O?.Studio?.overlay;
    if (!ovStore || !ov || typeof ov.computeInlineState !== 'function') return Promise.resolve(empty);
    return Promise.resolve(ovStore.get(String(snap.snapshotId))).then(function (overlay) {
      if (!overlay) return empty;
      try { return ov.computeInlineState(overlay, Number(turnIdx)); }
      catch (_) { return empty; }
    }, function () { return empty; });
  } catch (_) { return Promise.resolve(empty); }
}

try {
  W.H2O = W.H2O || {};
  W.H2O.Studio = W.H2O.Studio || {};
  W.H2O.Studio.inlineSelection = Object.assign({}, W.H2O.Studio.inlineSelection || {}, {
    __installed: true,
    version: '0.1.0-phase-5b-1',
    capture: __inlineSelection_capture,
    resolve: __inlineSelection_resolve,
    resolveToRange: __inlineSelection_resolveToRange,
    getHeldCapture: __inlineSelection_getHeldCapture,
    clearHeldCapture: __inlineSelection_clearHeldCapture,
    selfCheck: __inlineSelection_selfCheck,
  });
  if (!W.H2O.Studio.RibbonBridge || !W.H2O.Studio.RibbonBridge.__installed) {
    W.H2O.Studio.RibbonBridge = {
      __installed: true,
      version: '0.1.0-phase-3c-b',
      getCleanTranscript: __ribbonBridge_getCleanTranscript,
      getTurnClean: __ribbonBridge_getTurnClean,
      getTurnHtml: __ribbonBridge_getTurnHtml,
      getOverlay: __ribbonBridge_getOverlay,
      getMessageStateForTurn: __ribbonBridge_getMessageStateForTurn,
      getInlineStateForTurn: __ribbonBridge_getInlineStateForTurn,
      getStructureState: __ribbonBridge_getStructureState,
      applyOverlayOp: __ribbonBridge_applyOverlayOp,
      applyMessageFormatPaint: __ribbonBridge_applyMessageFormatPaint,
      applyInlineFormatPaint: __ribbonBridge_applyInlineFormatPaint,
      undo: __ribbonBridge_undo,
      redo: __ribbonBridge_redo,
      getHistoryState: __ribbonBridge_getHistoryState,
      /* Phase 3a — Markdown export. */
      exportMarkdown: __ribbonBridge_exportMarkdown,
      _sanitizeFilenameStem: __ribbonBridge_sanitizeFilenameStem,
      _buildMarkdownFilename: __ribbonBridge_buildMarkdownFilename,
      _buildMarkdownHeader: __ribbonBridge_buildMarkdownHeader,
      /* Phase 3b — PDF / print view. */
      openPrintView: __ribbonBridge_openPrintView,
      _buildPrintHeaderEl: __ribbonBridge_buildPrintHeaderEl,
      _buildPdfFilename: __ribbonBridge_buildPdfFilename,
      /* Phase 3c-B — DOCX export. */
      exportDocx: __ribbonBridge_exportDocx,
      _buildDocxFilename: __ribbonBridge_buildDocxFilename,
    };
  } else {
    /* Idempotent additive upgrade. */
    if (!W.H2O.Studio.RibbonBridge.getOverlay) W.H2O.Studio.RibbonBridge.getOverlay = __ribbonBridge_getOverlay;
    if (!W.H2O.Studio.RibbonBridge.getMessageStateForTurn) W.H2O.Studio.RibbonBridge.getMessageStateForTurn = __ribbonBridge_getMessageStateForTurn;
    if (!W.H2O.Studio.RibbonBridge.getInlineStateForTurn) W.H2O.Studio.RibbonBridge.getInlineStateForTurn = __ribbonBridge_getInlineStateForTurn;
    if (!W.H2O.Studio.RibbonBridge.getStructureState) W.H2O.Studio.RibbonBridge.getStructureState = __ribbonBridge_getStructureState;
    if (!W.H2O.Studio.RibbonBridge.applyOverlayOp) W.H2O.Studio.RibbonBridge.applyOverlayOp = __ribbonBridge_applyOverlayOp;
    if (!W.H2O.Studio.RibbonBridge.applyMessageFormatPaint) W.H2O.Studio.RibbonBridge.applyMessageFormatPaint = __ribbonBridge_applyMessageFormatPaint;
    if (!W.H2O.Studio.RibbonBridge.applyInlineFormatPaint) W.H2O.Studio.RibbonBridge.applyInlineFormatPaint = __ribbonBridge_applyInlineFormatPaint;
    /* Phase 2d — undo/redo/getHistoryState additive upgrade. */
    if (!W.H2O.Studio.RibbonBridge.undo) W.H2O.Studio.RibbonBridge.undo = __ribbonBridge_undo;
    if (!W.H2O.Studio.RibbonBridge.redo) W.H2O.Studio.RibbonBridge.redo = __ribbonBridge_redo;
    if (!W.H2O.Studio.RibbonBridge.getHistoryState) W.H2O.Studio.RibbonBridge.getHistoryState = __ribbonBridge_getHistoryState;
    /* Phase 2e — getCleanTranscript shape changed from sync string to
     * async object. Reinstall the function reference even when an
     * older RibbonBridge is already installed, so hot-reloads pick up
     * the new contract instead of holding the Phase 1b sync version. */
    W.H2O.Studio.RibbonBridge.getCleanTranscript = __ribbonBridge_getCleanTranscript;
    /* Phase 8f-1 — turn-scoped clean copy. Reinstall reference on hot reload. */
    W.H2O.Studio.RibbonBridge.getTurnClean = __ribbonBridge_getTurnClean;
    /* Phase 8f-2a — turn-scoped HTML serialization. Reinstall on hot reload. */
    W.H2O.Studio.RibbonBridge.getTurnHtml = __ribbonBridge_getTurnHtml;
    /* Phase 3a — Markdown export. Reinstall reference on hot reload. */
    W.H2O.Studio.RibbonBridge.exportMarkdown = __ribbonBridge_exportMarkdown;
    if (!W.H2O.Studio.RibbonBridge._sanitizeFilenameStem) W.H2O.Studio.RibbonBridge._sanitizeFilenameStem = __ribbonBridge_sanitizeFilenameStem;
    if (!W.H2O.Studio.RibbonBridge._buildMarkdownFilename) W.H2O.Studio.RibbonBridge._buildMarkdownFilename = __ribbonBridge_buildMarkdownFilename;
    if (!W.H2O.Studio.RibbonBridge._buildMarkdownHeader) W.H2O.Studio.RibbonBridge._buildMarkdownHeader = __ribbonBridge_buildMarkdownHeader;
    /* Phase 3b — PDF / print view. Reinstall reference on hot reload. */
    W.H2O.Studio.RibbonBridge.openPrintView = __ribbonBridge_openPrintView;
    if (!W.H2O.Studio.RibbonBridge._buildPrintHeaderEl) W.H2O.Studio.RibbonBridge._buildPrintHeaderEl = __ribbonBridge_buildPrintHeaderEl;
    if (!W.H2O.Studio.RibbonBridge._buildPdfFilename) W.H2O.Studio.RibbonBridge._buildPdfFilename = __ribbonBridge_buildPdfFilename;
    /* Phase 3c-B — DOCX export. Reinstall reference on hot reload. */
    W.H2O.Studio.RibbonBridge.exportDocx = __ribbonBridge_exportDocx;
    if (!W.H2O.Studio.RibbonBridge._buildDocxFilename) W.H2O.Studio.RibbonBridge._buildDocxFilename = __ribbonBridge_buildDocxFilename;
    W.H2O.Studio.RibbonBridge.version = '0.1.0-phase-3c-b';
  }
} catch (_) { /* swallow */ }
