// @version 1.1.0
import { makeChromeLivePopupDataSource } from "./chrome-live-popup-data.mjs";
import { makeChromeLivePopupStorageSource } from "./chrome-live-popup-storage.mjs";
import { makeChromeLivePopupViewPreludeSource, makeChromeLivePopupViewRenderSource } from "./chrome-live-popup-view.mjs";
import { resolveChromeBuildVisibilityFromEnvironment } from "../chrome-live-build-context.mjs";

export function makeChromeLivePopupJs({
  PROXY_PACK_URL,
  STORAGE_KEY,
  STORAGE_ORDER_OVERRIDES_KEY,
  DEV_ORDER_SECTIONS_SNAPSHOT,
  DEV_ALIAS_FILENAME_MAP,
}) {
  // T03 (leased, additive; semantic owner L-DEVELOPER-CONTROLS): loaded-build identity
  // renderer. Emitted only for opt-in build-visibility builds; the embedded constants
  // are the deterministic build stamp of THIS artifact, and runtime facts
  // (getManifest(), chrome.runtime.id, user agent) are always shown as loaded truth.
  const buildVisibility = resolveChromeBuildVisibilityFromEnvironment();
  const buildIdentitySource = buildVisibility.enabled
    ? makeLoadedBuildIdentitySource({
      version: buildVisibility.version,
      versionName: buildVisibility.versionName,
      sourceRevision: buildVisibility.sourceRevision,
      sourceRevisionShort: buildVisibility.sourceRevisionShort,
      channel: buildVisibility.channel,
      variant: buildVisibility.variant,
      registeredExtensionId: buildVisibility.registeredExtensionId,
      laneKey: buildVisibility.laneKey,
      surfaceSet: buildVisibility.surfaceSet,
      btpKey: buildVisibility.btpKey,
      profileRole: buildVisibility.profileRole,
      promotionState: buildVisibility.promotionState,
    })
    : "";
  return `(() => {
  "use strict";

  const PROXY_PACK_URL = ${JSON.stringify(PROXY_PACK_URL)};
  const STORAGE_KEY = ${JSON.stringify(STORAGE_KEY)};
  const STORAGE_SETS_KEY = "h2oExtDevToggleSetsV1";
  const STORAGE_INFO_KEY = "h2oExtDevInfoColsV1";
  const STORAGE_RUNTIME_KEY = "h2oExtDevRuntimeStatsV1";
  const STORAGE_RUNTIME_ADVANCED_KEY = "h2oExtDevRuntimeAdvancedV1";
  const STORAGE_SORT_MODE_KEY = "h2oExtDevSortModeV1";
  const STORAGE_TOPN_MODE_KEY = "h2oExtDevTopNModeV1";
  const STORAGE_TOPN_SCOPE_KEY = "h2oExtDevTopNScopeV1";
  const STORAGE_GROUP_LABELS_KEY = "h2oExtDevGroupLabelsV1";
  const STORAGE_COL_WIDTHS_KEY = "h2oExtDevColWidthsV1";
  const STORAGE_SCRIPT_COL_WIDTH_KEY = "h2oExtDevScriptColWidthV1";
  const STORAGE_POPUP_BG_MODE_KEY = "h2oExtDevPopupBgModeV1";
  const STORAGE_LEFTBAR_COLLAPSED_KEY = "h2oExtDevLeftbarCollapsedV1";
  const STORAGE_SET_CLICK_RELOAD_KEY = "h2oExtDevSetClickReloadV1";
  const STORAGE_CHAT_BINDINGS_KEY = "h2oExtDevChatSetBindingsV1";
  const STORAGE_CHAT_SET_BYPASS_KEY = "h2oExtDevChatSetBypassV1";
  const STORAGE_GLOBAL_DEFAULT_SET_KEY = "h2oExtDevGlobalDefaultSetV1";
  const STORAGE_ORDER_OVERRIDES_KEY = ${JSON.stringify(STORAGE_ORDER_OVERRIDES_KEY)};
  const POPUP_BG_BODY = "body";
  const POPUP_BG_BAR = "bar";
  const POPUP_BG_SIDE = "side";
  const SET_SLOTS = [1, 2, 3, 4, 5, 6];
  const MSG_FETCH_TEXT = "h2o-ext-live:fetch-text";
  const MSG_HTTP = "h2o-ext-live:http";
  const MSG_PAGE_DISABLE_ONCE = "h2o-ext-live:page-disable-once";
  const MSG_PAGE_SET_LINK = "h2o-ext-live:page-set-link";
  const MSG_IDENTITY = "h2o-ext-identity:v1";
  const IDENTITY_GET_DERIVED_STATE_ACTION = "identity:get-derived-state";
  const IDENTITY_REQUEST_PROVIDER_PERMISSION_ACTION = "identity:request-provider-permission";
  const HDR_RE = /\\/\\/\\s*==H2O Module==[\\s\\S]*?\\/\\/\\s*==\\/H2O Module==/g;
  const DEV_ORDER_SECTIONS = ${JSON.stringify(DEV_ORDER_SECTIONS_SNAPSHOT)};
  const DEV_ALIAS_FILENAME_MAP = ${JSON.stringify(DEV_ALIAS_FILENAME_MAP)};

  const COL_DEFS = [
    { key: "lines", label: "Lines", width: 64, toggleable: true, defaultOn: true },
    { key: "size", label: "Size", width: 64, toggleable: true, defaultOn: true },
    { key: "weight", label: "Weight", width: 86, toggleable: true, defaultOn: true },
    { key: "watchers", label: "Watchers", width: 82, toggleable: true, defaultOn: false },
    { key: "rt", label: "RT", width: 56, toggleable: true, defaultOn: true },
    { key: "runs", label: "Runs", width: 64, toggleable: true, defaultOn: true },
    { key: "fail", label: "Fail", width: 64, toggleable: true, defaultOn: true },
    { key: "seen", label: "Seen", width: 74, toggleable: true, defaultOn: true },
    { key: "phase", label: "Phase", width: 76, toggleable: true, defaultOn: true },
    { key: "load", label: "Load", width: 80, toggleable: true, defaultOn: true },
    { key: "load_ewma", label: "Load EWMA", width: 90, toggleable: true, defaultOn: true, advancedOnly: true },
    { key: "heap", label: "Heap", width: 82, toggleable: true, defaultOn: false },
  ];

  const INFO_OPTIONS = COL_DEFS
    .filter((c) => c.toggleable)
    .map((c) => ({ key: c.key, label: c.label + (c.advancedOnly ? " (adv)" : "") }));

  const elApp = document.getElementById("app");
  const elLeftbarRail = document.getElementById("leftbar-rail");
  const elList = document.getElementById("list");
  const elTableShell = document.getElementById("table-shell") || elList;
  const elCounts = document.getElementById("counts");
  const elPackUrl = document.getElementById("pack-url");
  const elTotals = document.getElementById("totals");
  const elHint = document.getElementById("hint");
  const elLogoToggle = document.getElementById("logo-toggle");
  const elRailLogoToggle = document.getElementById("rail-logo-toggle");
  const railTabButtons = Array.from(document.querySelectorAll("button[data-rail-tab]"));
  const elRailSettings = document.getElementById("rail-settings");
  const elBrandTitleToggle = document.getElementById("brand-title-toggle");
  const elBrandUtility = document.getElementById("brand-utility");
  const elAppearanceToggle = document.getElementById("appearance-toggle");
  const elAppearancePop = document.getElementById("appearance-pop");
  const elSettingsDock = document.getElementById("controls-tail-dock");
  const elSettingsToggle = document.getElementById("settings-toggle");
  const elSettingsPop = document.getElementById("settings-pop");
  const leftTabButtons = Array.from(document.querySelectorAll("button[data-controls-tab]"));
  const leftTabPages = Array.from(document.querySelectorAll("[data-controls-page]"));
  const settingsAnchors = Array.from(document.querySelectorAll("[data-settings-anchor]"));
  const elInfoGrid = document.getElementById("info-grid");
  const elSetSlots = document.getElementById("set-slots");
  const elSetClickReload = document.getElementById("set-click-reload");
  const elSetSave = document.getElementById("set-save");
  const elSetEdit = document.getElementById("set-edit");
  const elSetClear = document.getElementById("set-clear");
  const elSetsMeta = document.getElementById("sets-meta");
  const elPageSetStatus = document.getElementById("page-set-status");
  const elPageSetChat = document.getElementById("page-set-chat");
  const elPageSetGlobal = document.getElementById("page-set-global");
  const elPageSetBypass = document.getElementById("page-set-bypass");
  const elSortMode = document.getElementById("sort-mode");
  const elTopNMode = document.getElementById("topn-mode");
  const elTopNScope = document.getElementById("topn-scope");
  const elAdvancedRuntime = document.getElementById("advanced-runtime");
  const elHiddenWindow = document.getElementById("off-window");
  const elHiddenWindowCount = document.getElementById("off-window-count");
  const elHiddenWindowBody = document.getElementById("off-window-body");
  const bgModeButtons = Array.from(document.querySelectorAll("button[data-popup-bg-mode]"));
  const elProviderPermissionPanel = document.getElementById("identity-provider-permission-panel");
  const elProviderPermissionButton = document.getElementById("grant-supabase-permission");
  const elProviderPermissionStatus = document.getElementById("identity-provider-permission-status");

  let scripts = [];
  let toggleMap = {};
  let toggleSets = {};
  let infoPrefs = {};
  let runtimeStats = {};
  let selectedSetSlot = 1;
  let resolvedSetSlot = 0;
  let resolvedSource = "global-toggles";
  let chatBindingSlot = 0;
  let globalDefaultSlot = 0;
  let previewPendingSlot = 0;
  let currentTabId = 0;
  let currentChatUrl = "";
  let currentChatUrlKey = "";
  let chatBypassEnabled = false;
  let editArmed = false;
  let editableSlot = 0;
  let allGroups = [];
  let viewGroups = [];
  let runtimeAdvanced = false;
  let sortMode = "pack";
  let topNMode = "all";
  let topNScope = "group";
  let groupLabels = {};
  let colWidthMap = {};
  let scriptColWidth = 248;
  let scriptFixedAnchorWidth = null;
  let popupBgMode = POPUP_BG_BAR;
  let leftbarCollapsed = false;
  let currentColKeys = [];
  let currentColWidths = [];
  let colResizeState = null;
  let orderSectionsBase = normalizeDevOrderSections(DEV_ORDER_SECTIONS);
  let orderSections = cloneDevOrderSections(orderSectionsBase);
  let orderOverrideMap = {};
  let groupExpectedTotals = {};
  let hiddenNonVisibleSections = [];
  let hiddenNonVisibleTotal = 0;
  let hiddenOffTotal = 0;
  let activeControlsTab = "main";
  let headerUtilityOpen = false;
  let activeUtilityPanel = "";
  let setClickReload = true;
  const forcedVisibleAliasIds = new Set();
  let pendingRevealAliasId = "";
  const aliasFilenameMap = normalizeAliasFilenameMap(DEV_ALIAS_FILENAME_MAP);

  let seenCellRefs = [];
  let seenTimer = 0;
  let metricsScrollX = 0;
  let scriptScrollX = 0;

  elPackUrl.textContent = PROXY_PACK_URL;

  function setDot(mode) {}

  function sendIdentityRequest(action, extra = {}) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: MSG_IDENTITY, req: { ...extra, action } }, (res) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message || String(err)));
            return;
          }
          resolve(res || null);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function setProviderPermissionPanelVisible(visible) {
    if (elProviderPermissionPanel instanceof HTMLElement) {
      elProviderPermissionPanel.hidden = !visible;
    }
  }

  function setProviderPermissionStatus(message, disabled = false) {
    if (elProviderPermissionStatus instanceof HTMLElement) {
      elProviderPermissionStatus.textContent = message;
    }
    if (elProviderPermissionButton instanceof HTMLButtonElement) {
      elProviderPermissionButton.disabled = !!disabled;
    }
  }

  function shouldShowProviderPermissionGrant(status) {
    const cfg = status && typeof status === "object" ? status : {};
    return cfg.providerKind === "supabase"
      && cfg.providerMode === "provider_backed"
      && cfg.providerConfigured === true
      && cfg.valid === true
      && cfg.permissionRequired === true
      && cfg.permissionReady === false
      && cfg.permissionHostKind === "exact_supabase_project"
      && cfg.phaseNetworkEnabled === true;
  }

  async function refreshProviderPermissionUi() {
    try {
      const state = await sendIdentityRequest(IDENTITY_GET_DERIVED_STATE_ACTION);
      const cfg = state && state.providerConfigStatus && typeof state.providerConfigStatus === "object"
        ? state.providerConfigStatus
        : {};
      const visible = shouldShowProviderPermissionGrant(cfg);
      setProviderPermissionPanelVisible(visible);
      if (!visible) {
        setProviderPermissionStatus(cfg.permissionReady === true ? "Provider permission granted." : "Provider permission unavailable.", true);
        return cfg;
      }
      setProviderPermissionStatus("Exact provider permission is required.", false);
      return cfg;
    } catch (_) {
      setProviderPermissionPanelVisible(false);
      setProviderPermissionStatus("Provider permission status unavailable.", true);
      return null;
    }
  }

  async function requestProviderPermissionFromPopup() {
    if (!(elProviderPermissionButton instanceof HTMLButtonElement)) return;
    elProviderPermissionButton.disabled = true;
    setProviderPermissionStatus("Requesting provider permission.", true);
    try {
      const res = await sendIdentityRequest(IDENTITY_REQUEST_PROVIDER_PERMISSION_ACTION);
      if (res && res.ok === true && res.permissionReady === true) {
        setProviderPermissionStatus("Provider permission granted.", true);
      } else {
        const code = res && res.errorCode ? String(res.errorCode) : "permission not granted";
        setProviderPermissionStatus("Provider permission not granted: " + code, false);
      }
    } catch (e) {
      setProviderPermissionStatus("Provider permission request failed.", false);
    }
    await refreshProviderPermissionUi();
  }

  function applyLeftbarCollapsed(collapsedRaw) {
    leftbarCollapsed = !!collapsedRaw;
    if (elApp instanceof HTMLElement) {
      elApp.classList.toggle("leftbar-collapsed", leftbarCollapsed);
    }
    if (elLeftbarRail instanceof HTMLElement) {
      elLeftbarRail.hidden = !leftbarCollapsed;
    }
    for (const btn of [elLogoToggle, elRailLogoToggle]) {
      if (!(btn instanceof HTMLButtonElement)) continue;
      btn.setAttribute("aria-pressed", leftbarCollapsed ? "true" : "false");
      btn.title = leftbarCollapsed ? "Open leftbar" : "Collapse leftbar";
      btn.setAttribute("aria-label", btn.title);
    }
    if (leftbarCollapsed) {
      setHeaderUtilityOpen(false);
    }
  }

  function setLeftbarCollapsed(collapsedRaw) {
    applyLeftbarCollapsed(collapsedRaw);
    return storageSetLeftbarCollapsed(leftbarCollapsed);
  }

  async function openLeftbarForTab(tabRaw, options = null) {
    const nextTab = normalizeControlsTab(tabRaw);
    setControlsTab(nextTab);
    await setLeftbarCollapsed(false);
    if (options && options.openUtilityPanel) {
      setHeaderUtilityOpen(true, options.openUtilityPanel);
      return;
    }
    if (options && options.revealUtilities === true) {
      setHeaderUtilityOpen(true);
    }
  }

  function normalizeControlsTab(raw) {
    const tab = String(raw || "").toLowerCase();
    if (tab === "info" || tab === "hidden") return tab;
    return "main";
  }

  function setControlsTab(nextTab) {
    activeControlsTab = normalizeControlsTab(nextTab);
    for (const btn of leftTabButtons) {
      if (!(btn instanceof HTMLButtonElement)) continue;
      const isActive = String(btn.dataset.controlsTab || "") === activeControlsTab;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
      btn.tabIndex = isActive ? 0 : -1;
    }
    for (const btn of railTabButtons) {
      if (!(btn instanceof HTMLButtonElement)) continue;
      const isActive = String(btn.dataset.railTab || "") === activeControlsTab;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    }
    for (const page of leftTabPages) {
      if (!(page instanceof HTMLElement)) continue;
      const isActive = String(page.dataset.controlsPage || "") === activeControlsTab;
      page.hidden = !isActive;
      page.classList.toggle("is-active", isActive);
    }
    if (elSettingsDock instanceof HTMLElement) {
      const anchor = settingsAnchors.find((node) => (
        node instanceof HTMLElement && String(node.dataset.settingsAnchor || "") === activeControlsTab
      ));
      if (anchor instanceof HTMLElement) {
        anchor.appendChild(elSettingsDock);
      }
    }
  }

  function normalizeUtilityPanel(raw) {
    const panel = String(raw || "").toLowerCase();
    if (panel === "appearance" || panel === "settings") return panel;
    return "";
  }

  function setHeaderUtilityOpen(openRaw, panelRaw = "") {
    headerUtilityOpen = !!openRaw;
    activeUtilityPanel = headerUtilityOpen ? normalizeUtilityPanel(panelRaw) : "";

    if (elBrandUtility instanceof HTMLElement) {
      elBrandUtility.hidden = !headerUtilityOpen;
    }
    if (elBrandTitleToggle instanceof HTMLButtonElement) {
      elBrandTitleToggle.setAttribute("aria-expanded", headerUtilityOpen ? "true" : "false");
    }

    const togglePairs = [
      [elAppearanceToggle, "appearance"],
      [elSettingsToggle, "settings"],
    ];
    for (const [btn, panel] of togglePairs) {
      if (!(btn instanceof HTMLButtonElement)) continue;
      const isActive = headerUtilityOpen && activeUtilityPanel === panel;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-expanded", isActive ? "true" : "false");
    }

    if (elAppearancePop instanceof HTMLElement) {
      elAppearancePop.hidden = !(headerUtilityOpen && activeUtilityPanel === "appearance");
    }
    if (elSettingsPop instanceof HTMLElement) {
      elSettingsPop.hidden = !(headerUtilityOpen && activeUtilityPanel === "settings");
    }
  }

  function toggleHeaderUtilityPanel(panelRaw) {
    const panel = normalizeUtilityPanel(panelRaw);
    if (!panel) return;
    if (!headerUtilityOpen) {
      setHeaderUtilityOpen(true, panel);
      return;
    }
    if (activeUtilityPanel === panel) {
      setHeaderUtilityOpen(false);
      return;
    }
    setHeaderUtilityOpen(true, panel);
  }

  function applyPopupBgMode(modeRaw) {
    popupBgMode = normalizePopupBgMode(modeRaw);
    document.body.dataset.bgMode = popupBgMode;
    for (const btn of bgModeButtons) {
      if (!(btn instanceof HTMLButtonElement)) continue;
      const mode = normalizePopupBgMode(btn.dataset.popupBgMode || "");
      const active = mode === popupBgMode;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

${makeChromeLivePopupDataSource()}
${makeChromeLivePopupViewPreludeSource()}${makeChromeLivePopupStorageSource()}
${makeChromeLivePopupViewRenderSource()}  function commitGroupTitleInput(inputEl) {
    if (!(inputEl instanceof HTMLInputElement)) return;
    const key = String(inputEl.dataset.groupTitleEditKey || "").trim();
    if (!key) return;
    const defaultTitle = String(inputEl.dataset.groupDefaultTitle || "");
    setGroupLabel(key, inputEl.value, defaultTitle).catch((e) => {
      elHint.textContent = "Group title save failed: " + String(e && (e.message || e));
    });
  }

  function snapshotCurrentEnabledMap() {
    const map = {};
    for (const it of scripts) {
      map[it.aliasId] = isEnabled(it);
    }
    return map;
  }

  async function saveCurrentToSlot(slotNum) {
    if (!scripts.length) return;
    const slot = normalizeSetSlot(slotNum) || normalizeSetSlot(selectedSetSlot) || 1;
    selectedSetSlot = slot;
    const slotKey = String(slot);
    if (toggleSets[slotKey] && !(editArmed && editableSlot === slot)) {
      render();
      elHint.textContent = "Set " + slot + " already exists. Click Edit before Save to overwrite it.";
      return;
    }
    toggleSets[slotKey] = {
      savedAt: Date.now(),
      map: snapshotCurrentEnabledMap(),
    };
    editArmed = false;
    editableSlot = 0;
    await storageSetSets(toggleSets);
    await loadCurrentPageSetLink(currentTabId, currentChatUrl);
    render();
    elHint.textContent = "Saved current toggles to Set " + slot + ".";
  }

  function armEditForSlot(slotNum) {
    const slot = normalizeSetSlot(slotNum) || normalizeSetSlot(selectedSetSlot) || 1;
    selectedSetSlot = slot;
    if (!getSetRecord(slot)) {
      editArmed = false;
      editableSlot = 0;
      render();
      elHint.textContent = "Set " + slot + " is empty. Save fills it directly; Edit is only for overwrite.";
      return;
    }
    editArmed = true;
    editableSlot = slot;
    render();
    elHint.textContent = "Edit armed for Set " + slot + ". Save will overwrite it.";
  }

  async function clearSlot(slotNum) {
    const slot = normalizeSetSlot(slotNum) || normalizeSetSlot(selectedSetSlot) || 1;
    selectedSetSlot = slot;
    const slotKey = String(slot);
    if (!toggleSets[slotKey]) {
      render();
      elHint.textContent = "Set " + slot + " is already empty.";
      return;
    }
    delete toggleSets[slotKey];
    if (editableSlot === slot) {
      editArmed = false;
      editableSlot = 0;
    }
    await storageSetSets(toggleSets);
    await sendPageSetLink("clear-slot-references", currentTabId, slot, currentChatUrl);
    await loadCurrentPageSetLink(currentTabId, currentChatUrl);
    render();
    elHint.textContent = "Cleared Set " + slot + " and cleaned any matching binding/default/preview references.";
  }

  async function previewSlotForCurrentTab(slotNum, opts = null) {
    const slot = normalizeSetSlot(slotNum) || 0;
    if (!slot) return;
    selectedSetSlot = slot;
    const rec = getSetRecord(slot);
    if (!rec) {
      render();
      elHint.textContent = "Set " + slot + " is empty. Save current first.";
      return;
    }
    const tab = await getActiveTab();
    if (!tab || typeof tab.id !== "number") {
      elHint.textContent = "No active tab found.";
      return;
    }
    currentTabId = tab.id;
    currentChatUrl = String(tab.url || currentChatUrl || "");
    await sendPageSetLink("arm-preview-once", tab.id, slot, currentChatUrl);
    await loadCurrentPageSetLink(tab.id, currentChatUrl);
    render();
    const shouldReload = !opts || opts.reload !== false;
    if (shouldReload) {
      await chrome.tabs.reload(tab.id);
      elHint.textContent = "Preview Set " + slot + " armed and reloading now for one test load.";
      return;
    }
    elHint.textContent = "Preview Set " + slot + " armed for the next manual reload only.";
  }

  async function setChatBinding(slotNum) {
    try {
      const tab = await getActiveTab();
      if (!tab || typeof tab.id !== "number") {
        elHint.textContent = "No active tab found.";
        return;
      }
      currentTabId = tab.id;
      currentChatUrl = String(tab.url || currentChatUrl || "");
      const slot = normalizeSetSlot(slotNum);
      if (slot) {
        const rec = getSetRecord(slot);
        if (!rec) {
          elHint.textContent = "Set " + slot + " is empty. Save current first.";
          return;
        }
        await sendPageSetLink("set-chat-binding", tab.id, slot, currentChatUrl);
        elHint.textContent = "This Chat now points to Set " + slot + ". Reload the page to apply.";
      } else {
        await sendPageSetLink("clear-chat-binding", tab.id, 0, currentChatUrl);
        elHint.textContent = "This Chat binding cleared. Reload the page to apply.";
      }
      await loadCurrentPageSetLink(tab.id, currentChatUrl);
      render();
    } catch (e) {
      elHint.textContent = "This Chat binding failed: " + String(e && (e.message || e));
    }
  }

  async function setGlobalDefaultBinding(slotNum) {
    try {
      const slot = normalizeSetSlot(slotNum);
      if (slot) {
        const rec = getSetRecord(slot);
        if (!rec) {
          elHint.textContent = "Set " + slot + " is empty. Save current first.";
          return;
        }
        await sendPageSetLink("set-global-default", currentTabId, slot, currentChatUrl);
        elHint.textContent = "Global default now points to Set " + slot + ". Reload unbound chats to apply.";
      } else {
        await sendPageSetLink("clear-global-default", currentTabId, 0, currentChatUrl);
        elHint.textContent = "Global default cleared. Unbound chats fall back to global toggles.";
      }
      await loadCurrentPageSetLink(currentTabId, currentChatUrl);
      render();
    } catch (e) {
      elHint.textContent = "Global default failed: " + String(e && (e.message || e));
    }
  }

  async function setChatBypass(nextRaw) {
    try {
      const tab = await getActiveTab();
      if (!tab || typeof tab.id !== "number") {
        elHint.textContent = "No active tab found.";
        return;
      }
      currentTabId = tab.id;
      currentChatUrl = String(tab.url || currentChatUrl || "");
      const enabled = !!nextRaw;
      if (enabled) {
        await sendPageSetLink("set-chat-bypass", tab.id, 0, currentChatUrl);
        elHint.textContent = "This Chat will reload with all scripts off.";
      } else {
        await sendPageSetLink("clear-chat-bypass", tab.id, 0, currentChatUrl);
        elHint.textContent = "This Chat can use its Set or Global default again. Reload the page to apply.";
      }
      await loadCurrentPageSetLink(tab.id, currentChatUrl);
      render();
    } catch (e) {
      elHint.textContent = "All-off reload toggle failed: " + String(e && (e.message || e));
    }
  }

  async function resetToggles() {
    const next = {};
    for (const it of scripts) next[it.aliasId] = true;
    const persistentSetSlot = currentPersistentSetSlot();
    if (persistentSetSlot) {
      await persistWorkingEnabledMap(next, {
        set: "Set " + persistentSetSlot + " reset to default (all on). Reload the page to apply.",
      });
      return;
    }
    await storageResetMap();
    toggleMap = {};
    await loadCurrentPageSetLink(currentTabId, currentChatUrl);
    render();
    elHint.textContent = "Toggles reset to default (all on). Reload the page to apply.";
  }

  async function reloadActiveTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (!tab || typeof tab.id !== "number") {
        elHint.textContent = "No active tab found.";
        return;
      }
      await chrome.tabs.reload(tab.id);
      elHint.textContent = "Active tab reloaded.";
    } catch (e) {
      elHint.textContent = "Reload failed: " + String(e && (e.message || e));
    }
  }

  async function disableCurrentPageOnce() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (!tab || typeof tab.id !== "number") {
        elHint.textContent = "No active tab found.";
        return;
      }
      await sendPageDisableOnce("arm", tab.id);
      await chrome.tabs.reload(tab.id);
      elHint.textContent = "Active tab reloaded with H2O scripts disabled for this load only.";
    } catch (e) {
      elHint.textContent = "This-page disable failed: " + String(e && (e.message || e));
    }
  }

  async function setSetClickReload(enabled) {
    setClickReload = !!enabled;
    syncControlValues();
    await storageSetSetClickReload(setClickReload);
    elHint.textContent = setClickReload
      ? "Clicking a Set will arm a one-shot preview and reload immediately."
      : "Clicking a Set will arm a one-shot preview for the next manual reload.";
  }

  function render() {
    syncVisibleScriptsWithOrder();
    recomputeOrderDerivedState();
    syncControlValues();
    syncPageSetStatus();
    elCounts.textContent = countsText();
    renderSetSlots();
    renderInfoToggles();
    renderTotals();

    if (!scripts.length) {
      const host = elTableShell || elList;
      host.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No scripts available from proxy pack/catalog.";
      host.appendChild(empty);
      renderHiddenWindow();
      return;
    }

    allGroups = groupScripts(scripts);
    viewGroups = buildViewGroups();
    renderTable();
    renderHiddenWindow();
  }

  async function loadAndRender() {
    setDot();
    elCounts.textContent = "Loading proxy pack...";
    try {
      const [packRes, state, liveOrderSections] = await Promise.all([
        sendFetchText(PROXY_PACK_URL),
        storageGetState(),
        fetchLiveDevOrderSections(),
      ]);
      if (!packRes.ok) throw new Error(packRes.error || "failed to fetch proxy pack");
      scripts = parseProxyPack(packRes.text);
      toggleMap = state.toggleMap || {};
      toggleSets = state.toggleSets || {};
      infoPrefs = normalizeInfoPrefs(state.infoPrefs || {});
      runtimeStats = normalizeRuntimeStats(state.runtimeStats || {});
      runtimeAdvanced = !!state.runtimeAdvanced;
      sortMode = normalizeSortMode(state.sortMode);
      topNMode = normalizeTopNMode(state.topNMode);
      topNScope = normalizeTopNScope(state.topNScope);
      groupLabels = normalizeGroupLabels(state.groupLabels || {});
      colWidthMap = normalizeColWidthMap(state.colWidthMap || {});
      scriptColWidth = normalizeScriptColWidth(state.scriptColWidth, 248);
      popupBgMode = normalizePopupBgMode(state.popupBgMode);
      leftbarCollapsed = normalizeBool(state.leftbarCollapsed, false);
      setClickReload = normalizeBool(state.setClickReload, true);
      orderOverrideMap = normalizeOrderOverrideMap(state.orderOverrideMap || {});
      orderSectionsBase = Array.isArray(liveOrderSections) && liveOrderSections.length
        ? cloneDevOrderSections(liveOrderSections)
        : normalizeDevOrderSections(DEV_ORDER_SECTIONS);
      applyCurrentOrderOverrides();
      applyPopupBgMode(popupBgMode);
      applyLeftbarCollapsed(leftbarCollapsed);
      const activeTab = await getActiveTab();
      await loadCurrentPageSetLink(
        activeTab && typeof activeTab.id === "number" ? activeTab.id : 0,
        activeTab && typeof activeTab.url === "string" ? activeTab.url : ""
      );
      setDot("ok");
      elHint.textContent = "";
      render();
    } catch (e) {
      setDot("err");
      elCounts.textContent = "Failed to load proxy pack";
      const host = elTableShell || elList;
      host.innerHTML = "";
      const errBox = document.createElement("div");
      errBox.className = "error";
      errBox.textContent = String(e && (e.message || e));
      host.appendChild(errBox);
      elHint.textContent = "Check local server and run Common build first.";
    }
  }

  document.addEventListener("change", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement || t instanceof HTMLSelectElement)) return;

    const inlineKind = String(t.dataset.inlineKind || "");
    if (inlineKind) {
      if (inlineKind === "adv" && t instanceof HTMLInputElement) {
        setRuntimeAdvanced(!!t.checked);
        return;
      }
      if (t instanceof HTMLSelectElement && inlineKind === "sort") {
        setSortMode(t.value);
        return;
      }
      if (t instanceof HTMLSelectElement && inlineKind === "topn") {
        setTopNMode(t.value);
        return;
      }
      if (t instanceof HTMLSelectElement && inlineKind === "scope") {
        setTopNScope(t.value);
        return;
      }
    }

    if (t instanceof HTMLInputElement && t.id === "advanced-runtime") {
      setRuntimeAdvanced(!!t.checked);
      return;
    }

    if (t instanceof HTMLSelectElement && t.id === "sort-mode") {
      setSortMode(t.value);
      return;
    }
    if (t instanceof HTMLSelectElement && t.id === "topn-mode") {
      setTopNMode(t.value);
      return;
    }
    if (t instanceof HTMLSelectElement && t.id === "topn-scope") {
      setTopNScope(t.value);
      return;
    }

    if (!(t instanceof HTMLInputElement)) return;
    if (t.type !== "checkbox") return;

    const infoKey = String(t.dataset.infoKey || "");
    if (infoKey) {
      setInfoPref(infoKey, !!t.checked);
      return;
    }

    const aliasId = String(t.dataset.aliasId || "");
    if (!aliasId) return;
    setAliasEnabled(aliasId, !!t.checked);
  });

  document.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;

    const rowHideBtn = target.closest("button.row-hide-dot[data-hide-alias-id]");
    if (rowHideBtn) {
      const aliasId = String(rowHideBtn.getAttribute("data-hide-alias-id") || "").trim();
      if (aliasId) {
        setHiddenAliasEnabled(aliasId, false, { removeFromVisible: true }).catch((e) => {
          elHint.textContent = "Move to hidden failed: " + String(e && (e.message || e));
        });
      }
      return;
    }

    const hiddenDotBtn = target.closest("button.off-dot-btn[data-off-alias-id]");
    if (hiddenDotBtn) {
      const aliasId = String(hiddenDotBtn.getAttribute("data-off-alias-id") || "").trim();
      const enabledNow = String(hiddenDotBtn.getAttribute("data-off-enabled") || "") === "1";
      if (aliasId) {
        setHiddenAliasEnabled(aliasId, !enabledNow).catch((e) => {
          elHint.textContent = "Hidden toggle failed: " + String(e && (e.message || e));
        });
      }
      return;
    }

    const groupToggle = target.closest("button[data-group-toggle-key]");
    if (groupToggle) {
      const key = String(groupToggle.getAttribute("data-group-toggle-key") || "");
      const enabledNow = String(groupToggle.getAttribute("data-group-enabled") || "") === "1";
      if (key) setGroupEnabled(key, !enabledNow);
      return;
    }

    const setBtn = target.closest("button[data-set-slot]");
    if (setBtn) {
      const slot = Number(setBtn.getAttribute("data-set-slot"));
      if (Number.isFinite(slot)) previewSlotForCurrentTab(slot, { reload: setClickReload });
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && headerUtilityOpen) {
      setHeaderUtilityOpen(false);
    }
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.dataset.groupTitleEditKey) return;
    if (ev.key === "Enter") {
      ev.preventDefault();
      target.blur();
      return;
    }
    if (ev.key === "Escape") {
      const fallback = sanitizeGroupLabel(target.dataset.groupDefaultTitle || "", "");
      target.value = fallback;
      target.blur();
    }
  });

  document.addEventListener("focusout", (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.dataset.groupTitleEditKey) return;
    commitGroupTitleInput(target);
  });

  window.addEventListener("unload", () => {
    if (seenTimer) {
      clearInterval(seenTimer);
      seenTimer = 0;
    }
  });

  document.getElementById("all-on").addEventListener("click", () => setAll(true));
  document.getElementById("all-off").addEventListener("click", () => setAll(false));
  document.getElementById("page-off").addEventListener("click", () => disableCurrentPageOnce());
  document.getElementById("reset").addEventListener("click", () => resetToggles());
  document.getElementById("reset-layout").addEventListener("click", () => resetTableLayout());
  document.getElementById("reload").addEventListener("click", () => reloadActiveTab());
  if (elProviderPermissionButton instanceof HTMLButtonElement) {
    elProviderPermissionButton.addEventListener("click", () => {
      requestProviderPermissionFromPopup().catch(() => {
        setProviderPermissionStatus("Provider permission request failed.", false);
      });
    });
  }
  if (elLogoToggle instanceof HTMLButtonElement) {
    elLogoToggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (elApp?.dataset.workspaceMode === "diagnostics") {
        const workspace = document.getElementById("diagnostics-workspace");
        document.dispatchEvent(new CustomEvent("h2o:title-diagnostics-workspace-toggle-sidebar", {
          detail: { collapsed: !workspace?.classList.contains("is-sidebar-collapsed") }
        }));
        return;
      }
      setLeftbarCollapsed(!leftbarCollapsed).catch((e) => {
        elHint.textContent = "Leftbar toggle save failed: " + String(e && (e.message || e));
      });
    });
  }
  if (elRailLogoToggle instanceof HTMLButtonElement) {
    elRailLogoToggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (elApp?.dataset.workspaceMode === "diagnostics") {
        document.dispatchEvent(new CustomEvent("h2o:title-diagnostics-workspace-toggle-sidebar", {
          detail: { collapsed: false }
        }));
        return;
      }
      setLeftbarCollapsed(false).catch((e) => {
        elHint.textContent = "Leftbar toggle save failed: " + String(e && (e.message || e));
      });
    });
  }
  for (const btn of leftTabButtons) {
    if (!(btn instanceof HTMLButtonElement)) continue;
    btn.addEventListener("click", () => {
      setControlsTab(btn.dataset.controlsTab || "main");
    });
  }
  for (const btn of railTabButtons) {
    if (!(btn instanceof HTMLButtonElement)) continue;
    btn.addEventListener("click", () => {
      openLeftbarForTab(btn.dataset.railTab || "main").catch((e) => {
        elHint.textContent = "Open leftbar failed: " + String(e && (e.message || e));
      });
    });
  }
  if (elRailSettings instanceof HTMLButtonElement) {
    elRailSettings.addEventListener("click", () => {
      openLeftbarForTab(activeControlsTab || "main", { openUtilityPanel: "settings" }).catch((e) => {
        elHint.textContent = "Open settings failed: " + String(e && (e.message || e));
      });
    });
  }
  if (elBrandTitleToggle instanceof HTMLButtonElement) {
    elBrandTitleToggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
    });
    elBrandTitleToggle.addEventListener("dblclick", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      setHeaderUtilityOpen(!headerUtilityOpen);
    });
    elBrandTitleToggle.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      ev.stopPropagation();
      setHeaderUtilityOpen(!headerUtilityOpen);
    });
  }
  if (elBrandUtility instanceof HTMLElement) {
    elBrandUtility.addEventListener("click", (ev) => {
      ev.stopPropagation();
    });
  }
  if (elAppearanceToggle instanceof HTMLButtonElement) {
    elAppearanceToggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleHeaderUtilityPanel("appearance");
    });
  }
  if (elSettingsToggle instanceof HTMLButtonElement) {
    elSettingsToggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleHeaderUtilityPanel("settings");
    });
  }
  if (elAppearancePop instanceof HTMLElement) {
    elAppearancePop.addEventListener("click", (ev) => {
      ev.stopPropagation();
    });
  }
  if (elSettingsPop instanceof HTMLElement) {
    elSettingsPop.addEventListener("click", (ev) => {
      ev.stopPropagation();
    });
  }
  for (const btn of bgModeButtons) {
    if (!(btn instanceof HTMLButtonElement)) continue;
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      setPopupBgMode(btn.dataset.popupBgMode || POPUP_BG_BAR).catch((e) => {
        elHint.textContent = "Background save failed: " + String(e && (e.message || e));
      });
    });
  }
  if (elSetSave instanceof HTMLButtonElement) {
    elSetSave.addEventListener("click", () => {
      saveCurrentToSlot(selectedSetSlot);
    });
  }
  if (elSetEdit instanceof HTMLButtonElement) {
    elSetEdit.addEventListener("click", () => {
      armEditForSlot(selectedSetSlot);
    });
  }
  if (elSetClear instanceof HTMLButtonElement) {
    elSetClear.addEventListener("click", () => {
      clearSlot(selectedSetSlot);
    });
  }
  if (elSetClickReload instanceof HTMLInputElement) {
    elSetClickReload.addEventListener("change", () => {
      setSetClickReload(!!elSetClickReload.checked).catch((e) => {
        elHint.textContent = "Set-click reload save failed: " + String(e && (e.message || e));
      });
    });
  }
  if (elPageSetChat instanceof HTMLSelectElement) {
    elPageSetChat.addEventListener("change", () => {
      setChatBinding(elPageSetChat.value);
    });
  }
  if (elPageSetGlobal instanceof HTMLSelectElement) {
    elPageSetGlobal.addEventListener("change", () => {
      setGlobalDefaultBinding(elPageSetGlobal.value);
    });
  }
  if (elPageSetBypass instanceof HTMLInputElement) {
    elPageSetBypass.addEventListener("change", () => {
      setChatBypass(!!elPageSetBypass.checked);
    });
  }
  document.addEventListener("click", () => {
    if (headerUtilityOpen) setHeaderUtilityOpen(false);
  });

  if (chrome.storage && chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === "function") {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes || typeof changes !== "object") return;
      let shouldRender = false;

      if (Object.prototype.hasOwnProperty.call(changes, STORAGE_RUNTIME_KEY)) {
        runtimeStats = normalizeRuntimeStats(changes[STORAGE_RUNTIME_KEY]?.newValue || {});
        shouldRender = true;
      }
      if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) {
        const nextMap = changes[STORAGE_KEY]?.newValue;
        toggleMap = normalizeGlobalToggleMap(nextMap);
        shouldRender = true;
      }
      if (Object.prototype.hasOwnProperty.call(changes, STORAGE_SETS_KEY)) {
        toggleSets = normalizeSets(changes[STORAGE_SETS_KEY]?.newValue || {});
        if (editableSlot && !getSetRecord(editableSlot)) {
          editArmed = false;
          editableSlot = 0;
        }
        loadCurrentPageSetLink(currentTabId, currentChatUrl).catch(() => {});
        shouldRender = true;
      }
      if (Object.prototype.hasOwnProperty.call(changes, STORAGE_INFO_KEY)) {
        infoPrefs = normalizeInfoPrefs(changes[STORAGE_INFO_KEY]?.newValue || {});
        shouldRender = true;
      }
      if (Object.prototype.hasOwnProperty.call(changes, STORAGE_RUNTIME_ADVANCED_KEY)) {
        runtimeAdvanced = normalizeBool(changes[STORAGE_RUNTIME_ADVANCED_KEY]?.newValue, false);
        shouldRender = true;
      }
      if (Object.prototype.hasOwnProperty.call(changes, STORAGE_SET_CLICK_RELOAD_KEY)) {
        setClickReload = normalizeBool(changes[STORAGE_SET_CLICK_RELOAD_KEY]?.newValue, true);
        shouldRender = true;
      }
      if (Object.prototype.hasOwnProperty.call(changes, STORAGE_CHAT_BINDINGS_KEY) || Object.prototype.hasOwnProperty.call(changes, STORAGE_CHAT_SET_BYPASS_KEY) || Object.prototype.hasOwnProperty.call(changes, STORAGE_GLOBAL_DEFAULT_SET_KEY)) {
        loadCurrentPageSetLink(currentTabId, currentChatUrl).catch(() => {});
        shouldRender = true;
      }
      if (Object.prototype.hasOwnProperty.call(changes, STORAGE_SORT_MODE_KEY)) {
        sortMode = normalizeSortMode(changes[STORAGE_SORT_MODE_KEY]?.newValue);
        shouldRender = true;
      }
      if (Object.prototype.hasOwnProperty.call(changes, STORAGE_TOPN_MODE_KEY)) {
        topNMode = normalizeTopNMode(changes[STORAGE_TOPN_MODE_KEY]?.newValue);
        shouldRender = true;
      }
      if (Object.prototype.hasOwnProperty.call(changes, STORAGE_TOPN_SCOPE_KEY)) {
        topNScope = normalizeTopNScope(changes[STORAGE_TOPN_SCOPE_KEY]?.newValue);
        shouldRender = true;
      }
      if (Object.prototype.hasOwnProperty.call(changes, STORAGE_GROUP_LABELS_KEY)) {
        groupLabels = normalizeGroupLabels(changes[STORAGE_GROUP_LABELS_KEY]?.newValue || {});
        shouldRender = true;
      }
      if (Object.prototype.hasOwnProperty.call(changes, STORAGE_COL_WIDTHS_KEY)) {
        colWidthMap = normalizeColWidthMap(changes[STORAGE_COL_WIDTHS_KEY]?.newValue || {});
        shouldRender = true;
      }
      if (Object.prototype.hasOwnProperty.call(changes, STORAGE_SCRIPT_COL_WIDTH_KEY)) {
        scriptColWidth = normalizeScriptColWidth(changes[STORAGE_SCRIPT_COL_WIDTH_KEY]?.newValue, 248);
        shouldRender = true;
      }
      if (Object.prototype.hasOwnProperty.call(changes, STORAGE_POPUP_BG_MODE_KEY)) {
        popupBgMode = normalizePopupBgMode(changes[STORAGE_POPUP_BG_MODE_KEY]?.newValue);
        applyPopupBgMode(popupBgMode);
      }
      if (Object.prototype.hasOwnProperty.call(changes, STORAGE_LEFTBAR_COLLAPSED_KEY)) {
        leftbarCollapsed = normalizeBool(changes[STORAGE_LEFTBAR_COLLAPSED_KEY]?.newValue, false);
        applyLeftbarCollapsed(leftbarCollapsed);
      }
      if (Object.prototype.hasOwnProperty.call(changes, STORAGE_ORDER_OVERRIDES_KEY)) {
        orderOverrideMap = normalizeOrderOverrideMap(changes[STORAGE_ORDER_OVERRIDES_KEY]?.newValue || {});
        applyCurrentOrderOverrides();
        shouldRender = true;
      }

      if (shouldRender) render();
    });
  }

  setControlsTab(activeControlsTab);
  setHeaderUtilityOpen(false);
  applyPopupBgMode(popupBgMode);
  applyLeftbarCollapsed(leftbarCollapsed);
  ensureSeenTicker();
  loadAndRender();
  refreshProviderPermissionUi().catch(() => {
    setProviderPermissionPanelVisible(false);
  });
${buildIdentitySource}})();
`;
}

function makeLoadedBuildIdentitySource(identity) {
  return `
  // T03 loaded build identity (read-only). Build stamp of this artifact:
  const H2O_BUILD_IDENTITY = Object.freeze(${JSON.stringify(identity)});
  (function renderLoadedBuildIdentity() {
    const badge = document.getElementById("h2o-env-badge");
    const list = document.getElementById("h2o-env-identity-list");
    const section = document.getElementById("h2o-env-identity");
    if (!badge && !list) return;
    let manifest = {};
    try { manifest = chrome.runtime.getManifest() || {}; } catch {}
    let runtimeId = "UNKNOWN";
    try { runtimeId = chrome.runtime.id || "UNKNOWN"; } catch {}
    const loadedVersion = String(manifest.version || "UNKNOWN");
    const loadedVersionName = String(manifest.version_name || "NOT_ESTABLISHED");
    const built = H2O_BUILD_IDENTITY;
    const stampAgrees = built.versionName === loadedVersionName;
    const idAgrees = built.registeredExtensionId ? built.registeredExtensionId === runtimeId : null;
    const chromeMatch = /Chrome\\/(\\d+\\.\\d+\\.\\d+\\.\\d+)/.exec(String(navigator.userAgent || ""));
    const chromeVersion = chromeMatch ? chromeMatch[1] : "UNKNOWN";
    if (badge) {
      badge.textContent = built.laneKey + " \\u00b7 " + built.surfaceSet + " \\u00b7 " + loadedVersionName;
      badge.dataset.loadedVersionName = loadedVersionName;
      badge.dataset.stampAgrees = stampAgrees ? "1" : "0";
      badge.dataset.runtimeId = runtimeId;
    }
    if (list) {
      const diagnosticsBuild = section && section.dataset.h2oDiagnosticsBuild === "1" ? "ENABLED" : "DISABLED";
      const rows = [
        ["canonical_lane_key", built.laneKey],
        ["btp_key", built.btpKey],
        ["profile_role", built.profileRole],
        ["surface_set", built.surfaceSet],
        ["extension_family", built.variant || "UNKNOWN"],
        ["extension_id", runtimeId + (idAgrees === false ? " (loaded id differs from registered " + built.registeredExtensionId + ")" : "")],
        ["promotion_state", built.promotionState],
        ["version", loadedVersion],
        ["version_name", loadedVersionName + (stampAgrees ? "" : " (build stamp: " + built.versionName + ")")],
        ["channel", built.channel],
        ["source_revision", built.sourceRevision],
        ["artifact_identity", (built.variant || "UNKNOWN") + "/" + runtimeId + "/" + loadedVersionName + "/g" + built.sourceRevisionShort],
        ["artifact_digest", "registry-side (see h2o-browser)"],
        ["chrome_version", chromeVersion + " (observed)"],
        ["diagnostics_build", diagnosticsBuild],
      ];
      list.textContent = "";
      for (const [key, value] of rows) {
        const dt = document.createElement("dt");
        dt.textContent = key;
        const dd = document.createElement("dd");
        dd.textContent = String(value);
        dd.dataset.h2oIdentityKey = key;
        list.appendChild(dt);
        list.appendChild(dd);
      }
    }
  })();
`;
}
