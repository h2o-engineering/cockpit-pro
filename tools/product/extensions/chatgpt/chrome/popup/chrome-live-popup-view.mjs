// @version 1.0.0
export function makeChromeLivePopupViewPreludeSource() {
  return `  function expectedGroupTotal(groupKey, fallback = 0) {
    const k = String(groupKey || "");
    const fromOrder = Number(groupExpectedTotals[k]);
    if (Number.isFinite(fromOrder) && fromOrder > 0) {
      return Math.max(Number(fallback) || 0, Math.round(fromOrder));
    }
    return Number(fallback) || 0;
  }

  function renderHiddenWindow() {
    if (!(elHiddenWindow instanceof HTMLElement)) return;
    if (!(elHiddenWindowCount instanceof HTMLElement)) return;
    if (!(elHiddenWindowBody instanceof HTMLElement)) return;

    elHiddenWindow.hidden = false;
    elHiddenWindowCount.textContent = hiddenOffTotal + " hidden OFF · " + hiddenNonVisibleTotal + " non-visible";

    elHiddenWindowBody.innerHTML = "";
    if (!hiddenNonVisibleSections.length) {
      const empty = document.createElement("div");
      empty.className = "off-empty";
      empty.textContent = "No non-visible scripts in dev-order.";
      elHiddenWindowBody.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const sec of hiddenNonVisibleSections) {
      const secEl = document.createElement("section");
      secEl.className = "off-sec";

      const title = document.createElement("div");
      title.className = "off-sec-title";
      title.textContent = String(sec.title || "");
      secEl.appendChild(title);

      for (const it of sec.items) {
        const isEnabled = it && it.enabled === true;
        const row = document.createElement("div");
        row.className = "off-row" + (isEnabled ? " is-on" : " is-off");

        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = "off-dot-btn" + (isEnabled ? " on" : " off");
        dot.dataset.offAliasId = String(it.aliasId || "");
        dot.dataset.offEnabled = isEnabled ? "1" : "0";
        dot.title = isEnabled ? "Mark hidden (OFF)" : "Mark visible (ON)";
        dot.setAttribute("aria-label", dot.title);

        const alias = document.createElement("span");
        alias.className = "off-alias" + (isEnabled ? " on" : " off");
        alias.textContent = displayFilenameForAlias(it.aliasId);

        row.appendChild(dot);
        row.appendChild(alias);
        secEl.appendChild(row);
      }

      frag.appendChild(secEl);
    }
    elHiddenWindowBody.appendChild(frag);
  }

  function sendFetchText(url) {
    return new Promise((resolve) => {
      const reqUrl = url + (url.includes("?") ? "&" : "?") + "popupcb=" + encodeURIComponent(Date.now());
      chrome.runtime.sendMessage({ type: MSG_FETCH_TEXT, url: reqUrl }, (resp) => {
        const le = chrome.runtime.lastError;
        if (le) return resolve({ ok: false, error: String(le.message || le) });
        if (!resp || !resp.ok) {
          return resolve({ ok: false, error: resp?.error || ("HTTP " + Number(resp?.status || 0)) });
        }
        resolve({ ok: true, text: String(resp.text || "") });
      });
    });
  }

  function sendHttp(req) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: MSG_HTTP, req: req || {} }, (resp) => {
        const le = chrome.runtime.lastError;
        if (le) return resolve({ ok: false, status: 0, error: String(le.message || le) });
        resolve(resp && typeof resp === "object" ? resp : { ok: false, status: 0, error: "empty response" });
      });
    });
  }

  function sendPageDisableOnce(op, tabId = 0) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({
          type: MSG_PAGE_DISABLE_ONCE,
          op: String(op || ""),
          tabId: Number(tabId) || 0,
        }, (resp) => {
          const le = chrome.runtime.lastError;
          if (le) {
            reject(new Error(String(le.message || le)));
            return;
          }
          if (!resp || resp.ok === false) {
            reject(new Error(String(resp && resp.error || "page-disable request failed")));
            return;
          }
          resolve(resp);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function isHttpOk(resp) {
    const status = Number(resp && resp.status || 0);
    return status >= 200 && status < 300;
  }

  function orderFilenameMatchesAlias(fileRaw, aliasIdRaw) {
    const file = String(fileRaw || "").trim();
    const aliasId = String(aliasIdRaw || "").trim();
    if (!file || !aliasId) return false;
    if (file === aliasId) return true;
    const sourceFile = String(aliasFilenameMap[aliasId] || "").trim();
    if (sourceFile && file === sourceFile) return true;
    return false;
  }

  // Developer Controls sends INTENT only. Canonical dev-order mutation,
  // projection regeneration and readback all belong to the Runtime-owned
  // command behind this endpoint: no file contents, no filesystem paths and no
  // popup-side parsing cross this boundary.
  const DEV_ORDER_COMMAND_URL = devServerUrl("/__h2o/dev-order/command");

  async function sendDevOrderCommand(payload) {
    const res = await sendHttp({
      method: "POST",
      url: DEV_ORDER_COMMAND_URL,
      timeoutMs: 90000,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    if (!res || !res.ok) {
      return { ok: false, code: "transport/unreachable", error: String((res && res.error) || "dev server unreachable") };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(String(res.responseText || ""));
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, code: "transport/unreadable-result", error: "dev-order command returned no structured result" };
    }
    return parsed;
  }

  function devOrderCommandFailureText(result) {
    const raw = String((result && (result.error || result.code)) || "command failed").replace(/\s+/g, " ").trim();
    return raw.length > 160 ? raw.slice(0, 159) + "…" : raw;
  }

  // Source-side synchronization is NOT an artifact rebuild. Say so plainly
  // instead of implying a page reload is enough.
  function devOrderSuccessText(prefix, result) {
    const base = prefix + " Canonical dev-order updated and projections synchronized.";
    return (result && result.needsRebuild)
      ? base + " Rebuild the extension to apply it; reloading alone will not."
      : base;
  }

  async function fetchLiveDevOrderSections() {
    const res = await sendFetchText(DEV_ORDER_TSV_URL);
    if (!res || !res.ok) return null;
    const parsed = parseDevOrderSectionsFromTsv(res.text);
    return parsed.length ? parsed : null;
  }

  async function setHiddenAliasEnabled(aliasIdRaw, enabledRaw, options = null) {
    const aliasId = String(aliasIdRaw || "").trim();
    if (!aliasId) return;
    const enabled = enabledRaw === true;
    const removeFromVisible = !!(options && typeof options === "object" && options.removeFromVisible === true);
    setOrderEnabledInBase(aliasId, enabled);

    orderOverrideMap = normalizeOrderOverrideMap({ ...orderOverrideMap, [aliasId]: enabled });
    applyCurrentOrderOverrides();

    if (enabled) {
      delete toggleMap[aliasId];
      ensureVisibleScriptRow(aliasId);
      forcedVisibleAliasIds.add(aliasId);
      pendingRevealAliasId = aliasId;
    } else {
      toggleMap[aliasId] = false;
      forcedVisibleAliasIds.delete(aliasId);
      if (removeFromVisible) {
        removeVisibleScriptRow(aliasId);
        if (pendingRevealAliasId === aliasId) pendingRevealAliasId = "";
      }
    }

    await Promise.all([
      storageSetMap(toggleMap),
      storageSetOrderOverrideMap(orderOverrideMap),
    ]);

    render();
    elHint.textContent = (enabled ? "Marked visible: " : "Marked hidden: ") + aliasId + ". Requesting dev-order update...";

    const result = await sendDevOrderCommand({ operation: "set-enabled", sourceFile: aliasId, enabled });
    if (result && result.ok === true) {
      // Canonical state now matches, so the extension-local override is dropped.
      const nextOverrides = { ...orderOverrideMap };
      delete nextOverrides[aliasId];
      orderOverrideMap = normalizeOrderOverrideMap(nextOverrides);
      applyCurrentOrderOverrides();
      await storageSetOrderOverrideMap(orderOverrideMap);
      render();
      elHint.textContent = devOrderSuccessText((enabled ? "Visible." : "Hidden."), result);
      return;
    }

    // Runtime refused. The override stays, which is exactly what keeps the row
    // presentation-only, and the text must not claim canonical state changed.
    render();
    elHint.textContent = (enabled ? "Visible" : "Hidden")
      + " in this extension only \u2014 canonical dev-order unchanged: "
      + devOrderCommandFailureText(result);
  }

  function normalizeSetMap(rawMap) {
    const out = {};
    if (!rawMap || typeof rawMap !== "object") return out;
    for (const [k, v] of Object.entries(rawMap)) {
      const aliasId = normalizeAliasId(k);
      if (!aliasId) continue;
      out[aliasId] = v !== false;
    }
    return out;
  }

  function normalizeSets(rawSets) {
    const out = {};
    if (!rawSets || typeof rawSets !== "object") return out;

    for (const [slot, rawRec] of Object.entries(rawSets)) {
      const slotNum = Number(slot);
      if (!SET_SLOTS.includes(slotNum)) continue;
      if (!rawRec || typeof rawRec !== "object") continue;

      const maybeMap = rawRec && typeof rawRec.map === "object" ? rawRec.map : rawRec;
      const savedAt = Number(rawRec.savedAt || 0);
      out[String(slotNum)] = {
        savedAt: Number.isFinite(savedAt) ? savedAt : 0,
        map: normalizeSetMap(maybeMap),
      };
    }
    return out;
  }

  function normalizeSetSlot(raw) {
    const n = Number(raw);
    return SET_SLOTS.includes(n) ? n : 0;
  }

  function normalizeGlobalToggleMap(rawMap) {
    const out = {};
    if (!rawMap || typeof rawMap !== "object") return out;
    for (const [k, v] of Object.entries(rawMap)) {
      const aliasId = normalizeAliasId(k);
      if (!aliasId || v !== false) continue;
      out[aliasId] = false;
    }
    return out;
  }

  function selectedSetRecord() {
    return selectedSetSlot ? getSetRecord(selectedSetSlot) : null;
  }

  function currentResolvedSetRecord() {
    return resolvedSetSlot ? getSetRecord(resolvedSetSlot) : null;
  }

  function currentPersistentSetSlot() {
    const chatSlot = normalizeSetSlot(chatBindingSlot);
    if (chatSlot && getSetRecord(chatSlot)) return chatSlot;
    const globalSlot = normalizeSetSlot(globalDefaultSlot);
    if (globalSlot && getSetRecord(globalSlot)) return globalSlot;
    return 0;
  }

  function currentWorkingMap() {
    const rec = currentResolvedSetRecord();
    return rec && rec.map ? rec.map : toggleMap;
  }

  function currentResolvedStatusMeta() {
    if (!currentTabId) {
      return {
        text: "Resolved now: Unavailable",
        mode: "none",
      };
    }
    if (resolvedSource === "preview" && resolvedSetSlot) {
      return {
        text: "Preview runs with Set " + resolvedSetSlot,
        mode: "preview",
      };
    }
    if (chatBypassEnabled || resolvedSource === "all-off") {
      return {
        text: "This page reloads with All Off",
        mode: "all-off",
      };
    }
    if (resolvedSetSlot) {
      return {
        text: "This page runs with Set " + resolvedSetSlot,
        mode: "chat",
      };
    }
    if (!normalizeSetSlot(globalDefaultSlot)) {
      return {
        text: "Resolved now: Select Global",
        mode: "none",
      };
    }
    return {
      text: "This page runs with Global",
      mode: "global-toggles",
    };
  }

  function syncPageSetStatus() {
    if (!normalizeSetSlot(selectedSetSlot)) {
      selectedSetSlot = currentPersistentSetSlot() || normalizeSetSlot(resolvedSetSlot) || 1;
    }
    if (editArmed && editableSlot !== selectedSetSlot) {
      editArmed = false;
      editableSlot = 0;
    }
    const meta = currentResolvedStatusMeta();
    if (elPageSetStatus) {
      elPageSetStatus.textContent = meta.text;
      elPageSetStatus.dataset.mode = meta.mode;
    }
    if (elPageSetChat instanceof HTMLSelectElement) {
      elPageSetChat.value = String(normalizeSetSlot(chatBindingSlot) || 0);
      elPageSetChat.disabled = !currentTabId || !currentChatUrlKey;
      elPageSetChat.title = currentChatUrlKey || "No chat URL detected";
    }
    if (elPageSetGlobal instanceof HTMLSelectElement) {
      elPageSetGlobal.value = String(normalizeSetSlot(globalDefaultSlot) || 0);
    }
    if (elPageSetBypass instanceof HTMLInputElement) {
      elPageSetBypass.checked = !!chatBypassEnabled;
      elPageSetBypass.disabled = !currentTabId || !currentChatUrlKey;
      elPageSetBypass.title = currentChatUrlKey
        ? "Reload this Chat with all scripts off and ignore Set bindings"
        : "No chat URL detected";
    }
    if (elSetSave instanceof HTMLButtonElement) {
      const rec = selectedSetRecord();
      elSetSave.title = rec && !editArmed
        ? "Click Edit before overwriting Set " + selectedSetSlot
        : "Save current state to Set " + selectedSetSlot;
    }
    if (elSetEdit instanceof HTMLButtonElement) {
      const rec = selectedSetRecord();
      elSetEdit.disabled = !rec;
      elSetEdit.title = rec ? "Allow overwrite for Set " + selectedSetSlot : "Selected Set is empty";
      elSetEdit.classList.toggle("active", !!rec && editArmed && editableSlot === selectedSetSlot);
    }
    if (elSetClear instanceof HTMLButtonElement) {
      const rec = selectedSetRecord();
      elSetClear.disabled = !rec;
      elSetClear.title = rec ? "Clear Set " + selectedSetSlot : "Selected Set is already empty";
    }
  }

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    return tab && typeof tab.id === "number" ? tab : null;
  }

  function sendPageSetLink(op, tabId = 0, slot = 0, url = "") {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({
          type: MSG_PAGE_SET_LINK,
          op: String(op || ""),
          tabId: Number(tabId) || 0,
          slot: Number(slot) || 0,
          url: String(url || ""),
        }, (resp) => {
          const le = chrome.runtime.lastError;
          if (le) {
            reject(new Error(String(le.message || le)));
            return;
          }
          if (!resp || resp.ok === false) {
            reject(new Error(String(resp && resp.error || "page-set request failed")));
            return;
          }
          resolve(resp);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function loadCurrentPageSetLink(tabIdRaw = 0, urlRaw = "") {
    const tabId = Number(tabIdRaw) || currentTabId;
    const url = String(urlRaw || currentChatUrl || "");
    if (!tabId) {
      currentTabId = 0;
      currentChatUrl = "";
      currentChatUrlKey = "";
      resolvedSetSlot = 0;
      resolvedSource = "none";
      chatBindingSlot = 0;
      globalDefaultSlot = 0;
      previewPendingSlot = 0;
      chatBypassEnabled = false;
      syncPageSetStatus();
      return;
    }
    currentTabId = tabId;
    currentChatUrl = url;
    try {
      const [resolved, chatBinding, chatBypass, globalDefault] = await Promise.all([
        sendPageSetLink("resolve", tabId, 0, url),
        sendPageSetLink("get-chat-binding", tabId, 0, url),
        sendPageSetLink("get-chat-bypass", tabId, 0, url),
        sendPageSetLink("get-global-default", tabId, 0, url),
      ]);
      resolvedSetSlot = normalizeSetSlot(resolved && (resolved.slot || resolved.resolvedSetSlot));
      resolvedSource = String(resolved && (resolved.source || resolved.resolvedSource) || "global-toggles");
      previewPendingSlot = normalizeSetSlot(resolved && resolved.previewPendingSlot);
      chatBindingSlot = normalizeSetSlot(chatBinding && chatBinding.slot);
      chatBypassEnabled = !!(resolved && resolved.chatBypassEnabled || chatBypass && chatBypass.enabled);
      globalDefaultSlot = normalizeSetSlot(globalDefault && globalDefault.slot);
      currentChatUrlKey = String(resolved && resolved.urlKey || chatBinding && chatBinding.urlKey || chatBypass && chatBypass.urlKey || "");
      if (!normalizeSetSlot(selectedSetSlot)) {
        selectedSetSlot = chatBindingSlot || globalDefaultSlot || resolvedSetSlot || 1;
      }
    } catch {
      resolvedSetSlot = 0;
      resolvedSource = "global-toggles";
      chatBindingSlot = 0;
      globalDefaultSlot = 0;
      previewPendingSlot = 0;
      currentChatUrlKey = "";
      chatBypassEnabled = false;
    }
    syncPageSetStatus();
  }

`;
}

export function makeChromeLivePopupViewRenderSource() {
  return `  function isEnabled(item) {
    return currentWorkingMap()[item.aliasId] !== false;
  }

  function countsText() {
    const total = scripts.length;
    const enabled = scripts.filter(isEnabled).length;
    const disabled = total - enabled;
    return enabled + "/" + total + " enabled · " + disabled + " disabled";
  }

  function fmtInt(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "0";
    return Math.max(0, Math.round(v)).toLocaleString();
  }

  function topNLimit(mode) {
    if (mode === "top10") return 10;
    if (mode === "top20") return 20;
    return Infinity;
  }

  function runtimeHasSamples(runtime) {
    const r = runtime && typeof runtime === "object" ? runtime : null;
    if (!r) return false;
    return (Number(r.loads) || 0) + (Number(r.failures) || 0) > 0;
  }

  function runtimeLoadSortValue(runtime, preferEwma) {
    const r = runtime && typeof runtime === "object" ? runtime : null;
    if (!r) return 0;
    const first = preferEwma ? Number(r.ewmaLoadMs) : Number(r.lastLoadMs);
    if (Number.isFinite(first) && first > 0) return first;
    const second = preferEwma ? Number(r.lastLoadMs) : Number(r.ewmaLoadMs);
    if (Number.isFinite(second) && second > 0) return second;
    return runtimeHasSamples(r) ? 0.1 : 0;
  }

  function runtimeLoadValueForTotals(runtime) {
    return runtimeLoadSortValue(runtime, runtimeAdvanced);
  }

  function formatBytes(bytesRaw) {
    const bytes = Number(bytesRaw);
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    if (bytes < 1024) return Math.round(bytes) + "B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) + "KB";
    return (bytes / (1024 * 1024)).toFixed(2) + "MB";
  }

  function formatLoadMs(runtime, preferEwma = false) {
    if (!runtime || typeof runtime !== "object") return "";
    const raw = preferEwma
      ? (Number(runtime.ewmaLoadMs) > 0 ? Number(runtime.ewmaLoadMs) : Number(runtime.lastLoadMs))
      : (Number(runtime.lastLoadMs) > 0 ? Number(runtime.lastLoadMs) : Number(runtime.ewmaLoadMs));
    if (Number.isFinite(raw) && raw > 0) {
      return raw.toFixed(raw < 10 ? 1 : 0) + "ms";
    }
    const loads = Number(runtime.loads);
    if (Number.isFinite(loads) && loads > 0) return "<0.1ms";
    return "";
  }

  function formatHeapDeltaBytes(bytesRaw, allowZero = false) {
    const bytes = Number(bytesRaw);
    if (!Number.isFinite(bytes)) return "";
    if (bytes === 0) return allowZero ? "0KB" : "";
    const kb = bytes / 1024;
    const abs = Math.abs(kb);
    const shown = abs >= 10 ? String(Math.round(abs)) : abs.toFixed(1);
    return (kb > 0 ? "+" : "-") + shown + "KB";
  }

  function formatHeapDelta(runtime) {
    if (!runtime || typeof runtime !== "object") return "";
    if (runtime.heapSupported === false) return "n/a";
    return formatHeapDeltaBytes(Number(runtime.lastHeapDeltaBytes), runtimeHasSamples(runtime));
  }

  function toneForLoad(label) {
    const n = Number(String(label || "").replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(n)) return "";
    if (n >= 30) return "bad";
    if (n >= 15) return "warn";
    return "good";
  }

  function mapPhaseLabel(rawPhase) {
    const raw = String(rawPhase || "").trim().toLowerCase();
    if (!raw) return "phase —";
    if (raw === "boot" || raw === "start" || raw.includes("document-start")) return "phase boot";
    if (raw === "idle" || raw.includes("document-idle")) return "phase idle";
    if (raw === "late" || raw === "end" || raw.includes("document-end")) return "phase late";
    return "phase —";
  }

  function formatSeenAge(tsRaw) {
    const ts = Number(tsRaw);
    if (!Number.isFinite(ts) || ts <= 0) return "seen —";
    const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (secs < 60) return "seen " + secs + "s";
    const mins = Math.floor(secs / 60);
    if (mins < 60) return "seen " + mins + "m";
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return "seen " + hrs + "h";
    const days = Math.floor(hrs / 24);
    return "seen " + days + "d";
  }

  function normalizeDecorated(item, group) {
    const runtime = runtimeStats[item.aliasId] || null;
    const runs = runtime ? (Number(runtime.loads) || 0) : 0;
    const failures = runtime ? (Number(runtime.failures) || 0) : 0;
    const rtPresent = runs + failures > 0;
    return {
      item,
      groupKey: group.key,
      groupTitle: group.title,
      runtime,
      runs,
      failures,
      rtPresent,
      enabled: isEnabled(item),
      phaseLabel: mapPhaseLabel(runtime ? (runtime.lastPhase || runtime.phase || "") : ""),
      seenLabel: formatSeenAge(runtime ? (runtime.lastSeen || runtime.ts || 0) : 0),
    };
  }

  function sortDecoratedRows(rows) {
    const list = rows.slice();
    list.sort((a, b) => {
      if (sortMode === "load_desc") {
        const av = runtimeLoadSortValue(a.runtime, runtimeAdvanced);
        const bv = runtimeLoadSortValue(b.runtime, runtimeAdvanced);
        if (av !== bv) return bv - av;
      } else if (sortMode === "score_desc") {
        const av = Number(a.item.metrics && a.item.metrics.score) || 0;
        const bv = Number(b.item.metrics && b.item.metrics.score) || 0;
        if (av !== bv) return bv - av;
      } else if (sortMode === "watchers_desc") {
        const av = Number(a.item.metrics && a.item.metrics.watchers) || 0;
        const bv = Number(b.item.metrics && b.item.metrics.watchers) || 0;
        if (av !== bv) return bv - av;
      }
      const ai = Number.isFinite(Number(a.item && a.item.displayIndex))
        ? Number(a.item.displayIndex)
        : (Number(a.item && a.item.packIndex) || 0);
      const bi = Number.isFinite(Number(b.item && b.item.displayIndex))
        ? Number(b.item.displayIndex)
        : (Number(b.item && b.item.packIndex) || 0);
      return ai - bi;
    });
    return list;
  }

  function mergeForcedVisibleRows(visibleRows, orderedRows) {
    const out = Array.isArray(visibleRows) ? visibleRows.slice() : [];
    const seen = new Set(out.map((r) => String(r && r.item && r.item.aliasId || "").trim()).filter(Boolean));
    const src = Array.isArray(orderedRows) ? orderedRows : [];
    for (const row of src) {
      const aliasId = String(row && row.item && row.item.aliasId || "").trim();
      if (!aliasId) continue;
      if (!forcedVisibleAliasIds.has(aliasId)) continue;
      if (seen.has(aliasId)) continue;
      out.push(row);
      seen.add(aliasId);
    }
    return out;
  }

  function buildViewGroups() {
    const baseGroups = allGroups.slice();
    const n = topNLimit(topNMode);
    const GLOBAL_GROUP_KEY = "__GLOBAL__";
    const GLOBAL_GROUP_TITLE = "Global";

    if (topNScope === "global") {
      const allRows = [];
      for (const g of baseGroups) {
        for (const item of g.items) allRows.push(normalizeDecorated(item, g));
      }
      const sorted = sortDecoratedRows(allRows);
      const baseVisible = n === Infinity ? sorted : sorted.slice(0, n);
      const visibleRows = mergeForcedVisibleRows(baseVisible, sorted);
      return [{
        key: GLOBAL_GROUP_KEY,
        title: GLOBAL_GROUP_TITLE,
        fullRows: sorted,
        visibleRows,
      }];
    }

    return baseGroups.map((g) => {
      const fullRows = g.items.map((it) => normalizeDecorated(it, g));
      const sorted = sortDecoratedRows(fullRows);
      const baseVisible = n === Infinity ? sorted : sorted.slice(0, n);
      const visibleRows = mergeForcedVisibleRows(baseVisible, sorted);
      return {
        key: g.key,
        title: g.title,
        fullRows,
        visibleRows,
      };
    }).filter((g) => g.visibleRows.length > 0 || n === Infinity);
  }

  function computeRowsTotals(rows, includeDisabled = false) {
    const sourceRows = includeDisabled ? rows.slice() : rows.filter((r) => r.enabled);
    const profiled = sourceRows.filter((r) => r.rtPresent);

    let lines = 0;
    let bytes = 0;
    let score = 0;
    let watchers = 0;
    let runs = 0;
    let failures = 0;
    let loadSum = 0;
    let loadCount = 0;
    let heapSum = 0;
    let heapSupportedCount = 0;
    let heapUnsupportedCount = 0;

    for (const row of sourceRows) {
      const m = row.item.metrics || {};
      lines += Number(m.lines) || 0;
      bytes += Number(m.bytes) || 0;
      score += Number(m.score) || 0;
      watchers += Number(m.watchers) || 0;
      runs += Number(row.runs) || 0;
      failures += Number(row.failures) || 0;

      const runtime = row.runtime;
      if (!runtime) continue;
      const lv = runtimeLoadValueForTotals(runtime);
      if (lv > 0) {
        loadSum += lv;
        loadCount += 1;
      }

      if (!runtimeHasSamples(runtime)) continue;
      if (runtime.heapSupported === false) {
        heapUnsupportedCount += 1;
      } else {
        heapSupportedCount += 1;
        const hv = Number(runtime.lastHeapDeltaBytes);
        if (Number.isFinite(hv)) heapSum += hv;
      }
    }

    const avgLoad = loadCount > 0 ? (loadSum / loadCount).toFixed(1) + "ms" : "--";
    let heap = "--";
    if (heapSupportedCount > 0) heap = formatHeapDeltaBytes(heapSum, true);
    else if (heapUnsupportedCount > 0) heap = "n/a";

    return {
      enabledCount: sourceRows.length,
      profiledCount: profiled.length,
      lines,
      bytes,
      score,
      watchers,
      runs,
      failures,
      avgLoad,
      heap,
      profiledLabel: profiled.length + "/" + sourceRows.length,
    };
  }

  function syncControlValues() {
    if (elSortMode) elSortMode.value = sortMode;
    if (elTopNMode) elTopNMode.value = topNMode;
    if (elTopNScope) elTopNScope.value = topNScope;
    if (elAdvancedRuntime) elAdvancedRuntime.checked = !!runtimeAdvanced;
    if (elSetClickReload instanceof HTMLInputElement) elSetClickReload.checked = !!setClickReload;
  }

  function visibleColumns() {
    const out = [];
    for (const col of COL_DEFS) {
      if (col.advancedOnly && !runtimeAdvanced) continue;
      if (col.toggleable && infoPrefs[col.key] === false) continue;
      out.push(col);
    }
    return out;
  }

  function renderSetSlots() {
    elSetSlots.innerHTML = "";

    let savedCount = 0;
    for (const slot of SET_SLOTS) {
      if (getSetRecord(slot)) savedCount++;
    }
    elSetsMeta.textContent = savedCount + "/" + SET_SLOTS.length + " saved" + (editArmed && editableSlot ? " · Edit Set " + editableSlot : "");

    const frag = document.createDocumentFragment();
    for (const slot of SET_SLOTS) {
      const rec = getSetRecord(slot);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "set-btn";
      btn.dataset.setSlot = String(slot);
      if (rec) btn.classList.add("has");
      if (selectedSetSlot === slot) btn.classList.add("selected");
      if (resolvedSetSlot === slot && currentResolvedSetRecord()) btn.classList.add("resolved");
      if (previewPendingSlot === slot) btn.classList.add("preview-pending");

      const main = document.createElement("div");
      main.className = "set-main";
      main.textContent = "Set " + slot;

      const sub = document.createElement("div");
      sub.className = "set-sub";
      if (!rec) {
        sub.textContent = "empty";
        btn.title = "Set " + slot + " is empty";
      } else {
        const setOn = scripts.reduce((n, it) => n + (rec.map[it.aliasId] !== false ? 1 : 0), 0);
        sub.textContent = setOn + "/" + scripts.length;
        btn.title = "Set " + slot + ": " + setOn + "/" + scripts.length + " on";
        if (previewPendingSlot === slot) btn.title += " · preview armed";
        if (resolvedSetSlot === slot && currentResolvedSetRecord()) btn.title += " · resolved now";
      }

      btn.appendChild(main);
      btn.appendChild(sub);
      frag.appendChild(btn);
    }
    elSetSlots.appendChild(frag);
  }

  function renderInfoToggles() {
    if (!elInfoGrid) return;
    elInfoGrid.innerHTML = "";

    const frag = document.createDocumentFragment();
    for (const opt of INFO_OPTIONS) {
      const label = document.createElement("label");
      label.className = "info-opt";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = infoPrefs[opt.key] !== false;
      cb.dataset.infoKey = opt.key;

      const text = document.createElement("span");
      text.textContent = opt.label;

      label.appendChild(cb);
      label.appendChild(text);
      frag.appendChild(label);
    }
    elInfoGrid.appendChild(frag);
    syncControlValues();
  }

  function totalRow(label, value, tone = "") {
    const row = document.createElement("div");
    row.className = "total-line";
    if (tone) row.dataset.tone = tone;
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = label;
    const v = document.createElement("span");
    v.className = "v";
    const rawValue = String(value || "");
    const slashIdx = rawValue.indexOf("/");
    if (slashIdx > 0 && slashIdx < rawValue.length - 1) {
      const main = document.createElement("span");
      main.className = "v-main";
      main.textContent = rawValue.slice(0, slashIdx);
      const sep = document.createElement("span");
      sep.className = "v-sep";
      sep.textContent = "/";
      const em = document.createElement("span");
      em.className = "v-em";
      em.textContent = rawValue.slice(slashIdx + 1);
      v.appendChild(main);
      v.appendChild(sep);
      v.appendChild(em);
    } else {
      const single = document.createElement("span");
      single.className = "v-single";
      single.textContent = rawValue;
      v.appendChild(single);
    }
    row.appendChild(k);
    row.appendChild(v);
    return row;
  }

  function renderTotals() {
    if (!elTotals) return;
    elTotals.innerHTML = "";
    if (!scripts.length) return;

    const onRows = [];
    const allRowsFlat = [];
    let linesOn = 0;
    let bytesOn = 0;
    let scoreOn = 0;
    let watchersOn = 0;
    let linesAll = 0;
    let bytesAll = 0;
    let scoreAll = 0;
    let watchersAll = 0;

    for (const g of allGroups) {
      for (const item of g.items) {
        const m = item.metrics || {};
        linesAll += Number(m.lines) || 0;
        bytesAll += Number(m.bytes) || 0;
        scoreAll += Number(m.score) || 0;
        watchersAll += Number(m.watchers) || 0;

        const row = normalizeDecorated(item, g);
        allRowsFlat.push(row);
        if (row.enabled) {
          onRows.push(row);
          linesOn += Number(m.lines) || 0;
          bytesOn += Number(m.bytes) || 0;
          scoreOn += Number(m.score) || 0;
          watchersOn += Number(m.watchers) || 0;
        }
      }
    }

    const onTotals = computeRowsTotals(onRows);
    const frag = document.createDocumentFragment();
    frag.appendChild(totalRow("Lines on/all", fmtInt(linesOn) + "/" + fmtInt(linesAll), "lines"));
    frag.appendChild(totalRow("Size on/all", (formatBytes(bytesOn) || "0B") + "/" + (formatBytes(bytesAll) || "0B"), "size"));
    frag.appendChild(totalRow("Score on/all", fmtInt(scoreOn) + "/" + fmtInt(scoreAll), "score"));
    frag.appendChild(totalRow("Watch on/all", fmtInt(watchersOn) + "/" + fmtInt(watchersAll), "watch"));
    frag.appendChild(totalRow("Profiled on", onTotals.profiledLabel, "profiled"));
    frag.appendChild(totalRow("Avg load on", onTotals.avgLoad, "load"));
    frag.appendChild(totalRow("Heap sum on", onTotals.heap, "heap"));
    if (onTotals.enabledCount > 0) {
      const failures = onRows.reduce((n, r) => n + r.failures, 0);
      if (failures > 0) frag.appendChild(totalRow("Load failures", fmtInt(failures), "failures"));
    }
    elTotals.appendChild(frag);
  }

  function getSetRecord(slotNum) {
    const rec = toggleSets[String(slotNum)];
    if (!rec || typeof rec !== "object" || !rec.map || typeof rec.map !== "object") return null;
    return rec;
  }

  function makeMetricChip(text, tone = "") {
    const chip = document.createElement("span");
    chip.className = "stat-chip" + (tone ? " " + tone : "");
    chip.textContent = text;
    return chip;
  }

  function metricCellDescriptor(col, row) {
    const runtime = row.runtime;
    const m = row.item.metrics || {};
    const key = String(col && col.key || "");

    if (key === "lines") return { text: String(Number(m.lines) || 0) + "L", tone: "" };
    if (key === "size") return { text: formatBytes(m.bytes) || "0B", tone: "" };
    if (key === "weight") {
      const score = Number(m.score) || 0;
      const weight = String(m.weight || "").toLowerCase();
      const tone = weight === "heavy" ? "bad" : (weight === "medium" ? "warn" : "good");
      return { text: "score " + (score || "?"), tone };
    }
    if (key === "watchers") {
      const w = Number(m.watchers) || 0;
      const tone = w >= 4 ? "bad" : (w >= 2 ? "warn" : "");
      return { text: "watch " + w, tone };
    }
    if (key === "rt") return { text: row.rtPresent ? "rt ✅" : "rt —", tone: row.rtPresent ? "good" : "" };
    if (key === "runs") return { text: "runs " + row.runs, tone: "" };
    if (key === "fail") return { text: row.failures > 0 ? ("fail " + row.failures) : "ok", tone: row.failures > 0 ? "bad" : "good" };
    if (key === "seen") return { text: row.seenLabel, tone: "", seenAliasId: row.item.aliasId };
    if (key === "phase") return { text: row.phaseLabel, tone: "" };
    if (key === "load") {
      const load = formatLoadMs(runtime, false);
      return load ? { text: "load " + load, tone: toneForLoad(load) } : { text: "load --", tone: "" };
    }
    if (key === "load_ewma") {
      const load = formatLoadMs(runtime, true);
      return load ? { text: "ewma " + load, tone: toneForLoad(load) } : { text: "ewma --", tone: "" };
    }
    if (key === "heap") {
      const heap = formatHeapDelta(runtime);
      if (!heap) return { text: "heap --", tone: "" };
      const tone = heap === "n/a" ? "" : (heap.startsWith("+") ? "warn" : "good");
      return { text: "heap " + heap, tone };
    }
    return { text: "--", tone: "" };
  }

  function totalsMetricDescriptor(col, onTotals, allTotals, label) {
    const on = onTotals || {};
    const all = allTotals || onTotals || {};
    const key = String(col && col.key || "");

    if (key === "lines") return { text: fmtInt(on.lines || 0) + "/" + fmtInt(all.lines || 0) + "L", tone: "" };
    if (key === "size") {
      const onSize = formatBytes(on.bytes) || "0B";
      const allSize = formatBytes(all.bytes) || "0B";
      return { text: onSize + "/" + allSize, tone: "" };
    }
    if (key === "weight") {
      const score = Number(on.score) || 0;
      const tone = score >= 120 ? "bad" : (score >= 60 ? "warn" : "good");
      return { text: "score " + fmtInt(on.score || 0) + "/" + fmtInt(all.score || 0), tone };
    }
    if (key === "watchers") {
      const watchers = Number(on.watchers) || 0;
      const tone = watchers >= 12 ? "bad" : (watchers >= 6 ? "warn" : "");
      return { text: "watch " + fmtInt(on.watchers || 0) + "/" + fmtInt(all.watchers || 0), tone };
    }
    if (key === "rt") return { text: "rt " + fmtInt(on.profiledCount || 0) + "/" + fmtInt(all.profiledCount || 0), tone: "good" };
    if (key === "runs") return { text: "runs " + fmtInt(on.runs || 0) + "/" + fmtInt(all.runs || 0), tone: "" };
    if (key === "fail") {
      const failures = Number(on.failures) || 0;
      const tone = failures > 0 ? "bad" : "good";
      return { text: "fail " + fmtInt(on.failures || 0) + "/" + fmtInt(all.failures || 0), tone };
    }
    if (key === "seen") return { text: "seen " + fmtInt(on.enabledCount || 0) + "/" + fmtInt(all.enabledCount || 0), tone: "" };
    if (key === "phase") return { text: "phase " + fmtInt(on.profiledCount || 0) + "/" + fmtInt(all.profiledCount || 0), tone: "" };
    if (key === "load" || key === "load_ewma") {
      const onLoad = String(on.avgLoad || "--");
      const allLoad = String(all.avgLoad || "--");
      const tone = onLoad === "--" ? "" : toneForLoad(onLoad);
      return { text: "avg " + onLoad + "/" + allLoad, tone };
    }
    if (key === "heap") {
      const onHeap = String(on.heap || "--");
      const allHeap = String(all.heap || "--");
      const tone = onHeap === "n/a" ? "" : (onHeap.startsWith("+") ? "warn" : "good");
      return { text: "sum " + onHeap + "/" + allHeap, tone };
    }
    return { text: "--", tone: "" };
  }

  function estimateChipWidth(text, header = false) {
    const t = String(text || "");
    const base = Math.ceil((t.length * 6.6) + (header ? 18 : 22));
    return Math.max(header ? 52 : 58, base);
  }

  function makeMetricCell(col, row, seenRefs) {
    const cell = document.createElement("div");
    cell.className = "metric-cell";
    const desc = metricCellDescriptor(col, row);
    const chip = makeMetricChip(desc.text, desc.tone || "");
    if (desc.seenAliasId) {
      chip.dataset.seenAliasId = desc.seenAliasId;
      seenRefs.push(chip);
    }
    cell.appendChild(chip);
    return cell;
  }

  function makeTotalsMetricCell(col, onTotals, allTotals, label) {
    const cell = document.createElement("div");
    cell.className = "metric-cell";
    const desc = totalsMetricDescriptor(col, onTotals, allTotals, label);
    cell.appendChild(makeMetricChip(desc.text, desc.tone || ""));
    return cell;
  }

  function computeAdaptiveColumnWidths(cols, groups) {
    const widthByKey = new Map();
    const listCols = Array.isArray(cols) ? cols : [];
    const listGroups = Array.isArray(groups) ? groups : [];

    for (const col of listCols) {
      const key = String(col.key || "");
      widthByKey.set(key, Math.max(Number(col.width || 80), estimateChipWidth(col.label, true)));
    }

    for (const group of listGroups) {
      const groupOnTotals = computeRowsTotals(group.fullRows || [], false);
      const groupAllTotals = computeRowsTotals(group.fullRows || [], true);
      for (const col of listCols) {
        const key = String(col.key || "");
        const d = totalsMetricDescriptor(col, groupOnTotals, groupAllTotals, "full");
        widthByKey.set(key, Math.max(Number(widthByKey.get(key) || 0), estimateChipWidth(d.text, false)));
      }
      const rows = Array.isArray(group.visibleRows) ? group.visibleRows : [];
      for (const row of rows) {
        for (const col of listCols) {
          const key = String(col.key || "");
          const d = metricCellDescriptor(col, row);
          widthByKey.set(key, Math.max(Number(widthByKey.get(key) || 0), estimateChipWidth(d.text, false)));
        }
      }
    }

    return listCols.map((col) => Math.max(Number(col.width || 80), Number(widthByKey.get(String(col.key || "")) || 0)));
  }

  function linkMetricsScrollTable(master, followers) {
    if (!master || typeof master.addEventListener !== "function") return;
    const nodes = Array.isArray(followers)
      ? followers.filter((el) => el && typeof el.scrollLeft === "number")
      : [];
    const applyX = (x) => {
      for (const node of nodes) {
        node.scrollLeft = x;
      }
    };
    let syncing = false;
    master.addEventListener("scroll", () => {
      if (syncing) return;
      try {
        syncing = true;
        metricsScrollX = master.scrollLeft;
        applyX(metricsScrollX);
      } finally {
        syncing = false;
      }
    }, { passive: true });
    const initX = Number.isFinite(metricsScrollX) ? metricsScrollX : 0;
    if (initX > 0) master.scrollLeft = initX;
    applyX(master.scrollLeft || initX);
  }

  function linkScriptScrollTable(followers) {
    const nodes = Array.isArray(followers)
      ? followers.filter((el) => el && typeof el.scrollLeft === "number")
      : [];
    if (!nodes.length) return;

    let syncing = false;
    const applyX = (x, src = null) => {
      for (const node of nodes) {
        if (!node || node === src) continue;
        node.scrollLeft = x;
      }
    };

    for (const node of nodes) {
      node.addEventListener("scroll", () => {
        if (syncing) return;
        try {
          syncing = true;
          scriptScrollX = node.scrollLeft || 0;
          applyX(scriptScrollX, node);
        } finally {
          syncing = false;
        }
      }, { passive: true });

      node.addEventListener("wheel", (ev) => {
        const hasHorizontal = Math.abs(Number(ev.deltaX) || 0) > 0;
        const delta = hasHorizontal ? Number(ev.deltaX) : (ev.shiftKey ? Number(ev.deltaY) : 0);
        if (!delta) return;
        ev.preventDefault();
        node.scrollLeft += delta;
      }, { passive: false });
    }

    const initX = Number.isFinite(scriptScrollX) ? scriptScrollX : 0;
    if (initX > 0) {
      for (const node of nodes) node.scrollLeft = initX;
    }
  }

  function refreshSeenLabels() {
    for (const chip of seenCellRefs) {
      if (!(chip instanceof HTMLElement)) continue;
      const aliasId = String(chip.dataset.seenAliasId || "").trim();
      if (!aliasId) continue;
      const runtime = runtimeStats[aliasId] || null;
      chip.textContent = formatSeenAge(runtime ? (runtime.lastSeen || runtime.ts || 0) : 0);
    }
  }

  function ensureSeenTicker() {
    if (seenTimer) return;
    seenTimer = setInterval(() => refreshSeenLabels(), 15000);
  }

  function renderTable() {
    const host = elTableShell || elList;
    host.innerHTML = "";
    seenCellRefs = [];
    if (colResizeState && typeof colResizeState.cleanup === "function") {
      try { colResizeState.cleanup(); } catch {}
      colResizeState = null;
    }

    if (!viewGroups.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No scripts available from proxy pack/catalog.";
      host.appendChild(empty);
      return;
    }

    const cols = visibleColumns();
    const colKeys = cols.map((col) => String(col && col.key || ""));
    const baseColWidths = computeAdaptiveColumnWidths(cols, viewGroups);
    const colWidths = baseColWidths.map((w, idx) => {
      const key = colKeys[idx] || "";
      if (key && Object.prototype.hasOwnProperty.call(colWidthMap, key)) {
        return normalizeColWidth(colWidthMap[key], w);
      }
      return normalizeColWidth(w, w);
    });
    currentColKeys = colKeys.slice();
    currentColWidths = colWidths.slice();
    const buildGridTemplate = () => currentColWidths.map((w) => String(normalizeColWidth(w, 80)) + "px").join(" ");
    const computeTotalWidth = () => currentColWidths.reduce((n, w) => n + Number(normalizeColWidth(w, 80) || 0), 0) + Math.max(0, cols.length - 1) * 2 + 10;
    scriptColWidth = normalizeScriptColWidth(scriptColWidth, 248);
    scriptFixedAnchorWidth = scriptColWidth;
    const gridTemplate = buildGridTemplate();
    const totalWidth = computeTotalWidth();

    const shell = document.createElement("div");
    shell.className = "table-shell";
    shell.style.setProperty("--script-col-w", scriptColWidth + "px");
    shell.style.setProperty("--script-col-min-w", scriptColWidth + "px");
    shell.style.setProperty("--metrics-table-min", totalWidth + "px");

    const sortInlineOptions = [
      { value: "pack", label: "Display" },
      { value: "load_desc", label: "Load" },
      { value: "score_desc", label: "Score" },
      { value: "watchers_desc", label: "Watch" },
    ];
    const topNInlineOptions = [
      { value: "all", label: "All" },
      { value: "top10", label: "Top10" },
      { value: "top20", label: "Top20" },
    ];
    const scopeInlineOptions = [
      { value: "group", label: "Group" },
      { value: "global", label: "Global" },
    ];
    function makeInlineSelect(kind, options, value) {
      const sel = document.createElement("select");
      sel.className = "sf-inline-select";
      sel.dataset.inlineKind = kind;
      for (const opt of options) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        sel.appendChild(o);
      }
      sel.value = value;
      return sel;
    }

    const globalHead = document.createElement("div");
    globalHead.className = "table-head grp-rowwrap";

    const globalHeadScript = document.createElement("div");
    globalHeadScript.className = "script-head table-head-script";
    const globalHeadMain = document.createElement("div");
    globalHeadMain.className = "script-head-main";
    const globalHeadTop = document.createElement("div");
    globalHeadTop.className = "script-head-top";
    const globalScriptHeadTitle = document.createElement("span");
    globalScriptHeadTitle.className = "script-head-title";
    globalScriptHeadTitle.textContent = "Scripts";

    const inlineControls = document.createElement("div");
    inlineControls.className = "sf-inline-controls";
    inlineControls.appendChild(makeInlineSelect("sort", sortInlineOptions, sortMode));
    inlineControls.appendChild(makeInlineSelect("topn", topNInlineOptions, topNMode));
    inlineControls.appendChild(makeInlineSelect("scope", scopeInlineOptions, topNScope));
    const inlineAdv = document.createElement("label");
    inlineAdv.className = "sf-inline-adv";
    const inlineAdvCb = document.createElement("input");
    inlineAdvCb.type = "checkbox";
    inlineAdvCb.dataset.inlineKind = "adv";
    inlineAdvCb.checked = !!runtimeAdvanced;
    const inlineAdvText = document.createElement("span");
    inlineAdvText.textContent = "Adv";
    inlineAdv.appendChild(inlineAdvCb);
    inlineAdv.appendChild(inlineAdvText);
    inlineControls.appendChild(inlineAdv);

    globalHeadTop.appendChild(globalScriptHeadTitle);
    globalHeadTop.appendChild(inlineControls);
    globalHeadMain.appendChild(globalHeadTop);
    globalHeadScript.appendChild(globalHeadMain);
    const scriptColResizer = document.createElement("span");
    scriptColResizer.className = "script-col-resizer";
    scriptColResizer.title = "Resize Scripts column";
    scriptColResizer.setAttribute("aria-label", "Resize Scripts column");
    globalHeadScript.appendChild(scriptColResizer);

    const globalMetricsHeadScroll = document.createElement("div");
    globalMetricsHeadScroll.className = "metrics-scroll metrics-head metrics-follower";
    const globalMetricsHeadTrack = document.createElement("div");
    globalMetricsHeadTrack.className = "metrics-track";
    const globalHeadMetrics = document.createElement("div");
    globalHeadMetrics.className = "metrics-row metrics-head-row";
    globalHeadMetrics.style.gridTemplateColumns = gridTemplate;
    for (let colIdx = 0; colIdx < cols.length; colIdx++) {
      const col = cols[colIdx];
      const cell = document.createElement("div");
      cell.className = "metric-cell metric-head-cell";
      const chip = document.createElement("span");
      chip.className = "head-chip";
      chip.textContent = col.label;
      cell.appendChild(chip);
      if (colIdx < cols.length - 1) {
        const resizer = document.createElement("span");
        resizer.className = "metrics-col-resizer";
        resizer.dataset.colResizeIdx = String(colIdx);
        resizer.dataset.colResizeKey = String(col && col.key || "");
        resizer.title = "Resize column";
        cell.appendChild(resizer);
      }
      globalHeadMetrics.appendChild(cell);
    }
    globalMetricsHeadTrack.appendChild(globalHeadMetrics);
    globalMetricsHeadScroll.appendChild(globalMetricsHeadTrack);

    globalHead.appendChild(globalHeadScript);
    globalHead.appendChild(globalMetricsHeadScroll);
    shell.appendChild(globalHead);

    const metricsMasterRow = document.createElement("div");
    metricsMasterRow.className = "metrics-master-row grp-rowwrap";
    const metricsMasterSpacer = document.createElement("div");
    metricsMasterSpacer.className = "metrics-master-spacer";
    const metricsMasterScroll = document.createElement("div");
    metricsMasterScroll.className = "metrics-scroll metrics-master";
    const metricsMasterTrack = document.createElement("div");
    metricsMasterTrack.className = "metrics-track";
    const metricsMasterGhost = document.createElement("div");
    metricsMasterGhost.className = "metrics-master-ghost";
    metricsMasterTrack.appendChild(metricsMasterGhost);
    metricsMasterScroll.appendChild(metricsMasterTrack);
    metricsMasterRow.appendChild(metricsMasterSpacer);
    metricsMasterRow.appendChild(metricsMasterScroll);
    shell.appendChild(metricsMasterRow);

    const metricsSliderRow = document.createElement("div");
    metricsSliderRow.className = "metrics-slider-row grp-rowwrap";
    const metricsSliderSpacer = document.createElement("div");
    metricsSliderSpacer.className = "metrics-slider-spacer";
    const metricsSliderWrap = document.createElement("div");
    metricsSliderWrap.className = "metrics-slider-wrap";
    const metricsSlider = document.createElement("input");
    metricsSlider.type = "range";
    metricsSlider.className = "metrics-slider";
    metricsSlider.min = "0";
    metricsSlider.max = "0";
    metricsSlider.step = "1";
    metricsSlider.value = "0";
    metricsSliderWrap.appendChild(metricsSlider);
    metricsSliderRow.appendChild(metricsSliderSpacer);
    metricsSliderRow.appendChild(metricsSliderWrap);
    shell.appendChild(metricsSliderRow);

    const groupsContainer = document.createElement("div");
    groupsContainer.className = "groups-container";
    shell.appendChild(groupsContainer);

    const tableMetricScrollFollowers = [];
    const tableScriptScrollFollowers = [];
    const groupMetaNodes = [];
    tableScriptScrollFollowers.push(globalHeadScript);
    tableMetricScrollFollowers.push(globalMetricsHeadScroll);
    for (const group of viewGroups) {
      const grp = document.createElement("section");
      grp.className = "grp";
      grp.dataset.groupKey = group.key;

      const visibleEnabled = group.visibleRows.filter((r) => r.enabled).length;
      const groupTotalsOn = computeRowsTotals(group.fullRows || [], false);
      const groupTotalsAll = computeRowsTotals(group.fullRows || [], true);
      const grpHead = document.createElement("div");
      grpHead.className = "grp-head grp-rowwrap";

      const groupHeadLeft = document.createElement("div");
      groupHeadLeft.className = "group-head-left";

      const fullEnabled = group.fullRows.filter((r) => r.enabled).length;
      const groupAnyOn = fullEnabled > 0;

      const groupToggle = document.createElement("button");
      groupToggle.type = "button";
      groupToggle.className = "group-toggle-dot" + (groupAnyOn ? " on" : "");
      groupToggle.dataset.groupToggleKey = group.key;
      groupToggle.dataset.groupEnabled = groupAnyOn ? "1" : "0";
      groupToggle.title = groupAnyOn ? "Disable group" : "Enable group";
      groupToggle.setAttribute("aria-label", groupToggle.title);

      const gTitle = document.createElement("input");
      gTitle.type = "text";
      gTitle.className = "group-title-input group-title-inline";
      gTitle.value = groupDisplayTitle(group);
      gTitle.dataset.groupTitleEditKey = group.key;
      gTitle.dataset.groupDefaultTitle = sanitizeGroupLabel(group.title, "");
      gTitle.spellcheck = false;
      gTitle.setAttribute("aria-label", "Edit group title");
      const gMeta = document.createElement("span");
      gMeta.className = "group-meta-inline";
      const groupExpected = expectedGroupTotal(group.key, group.fullRows.length);
      gMeta.textContent = visibleEnabled + "/" + group.visibleRows.length + " on · visible " + group.visibleRows.length + "/" + groupExpected;
      groupMetaNodes.push(gMeta);
      groupHeadLeft.appendChild(groupToggle);
      groupHeadLeft.appendChild(gTitle);
      groupHeadLeft.appendChild(gMeta);
      tableScriptScrollFollowers.push(groupHeadLeft);

      const groupHeadMetricsScroll = document.createElement("div");
      groupHeadMetricsScroll.className = "metrics-scroll metrics-group-head metrics-follower";
      const groupHeadMetricsTrack = document.createElement("div");
      groupHeadMetricsTrack.className = "metrics-track";
      const groupHeadMetrics = document.createElement("div");
      groupHeadMetrics.className = "metrics-row metrics-group-head-row";
      groupHeadMetrics.style.gridTemplateColumns = gridTemplate;
      for (const col of cols) {
        groupHeadMetrics.appendChild(makeTotalsMetricCell(col, groupTotalsOn, groupTotalsAll, "full"));
      }
      groupHeadMetricsTrack.appendChild(groupHeadMetrics);
      groupHeadMetricsScroll.appendChild(groupHeadMetricsTrack);
      tableMetricScrollFollowers.push(groupHeadMetricsScroll);

      grpHead.appendChild(groupHeadLeft);
      grpHead.appendChild(groupHeadMetricsScroll);
      grp.appendChild(grpHead);

      const grpRows = document.createElement("div");
      grpRows.className = "grp-rows";
      for (const row of group.visibleRows) {
        const rowWrap = document.createElement("div");
        rowWrap.className = "grp-row grp-rowwrap";

        const scriptCell = document.createElement("div");
        scriptCell.className = "row-script" + (row.enabled ? "" : " off");
        scriptCell.title = row.item.requireUrl;

        const sw = document.createElement("label");
        sw.className = "switch";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = row.enabled;
        cb.dataset.aliasId = row.item.aliasId;
        cb.setAttribute("aria-label", "Toggle " + row.item.name);
        const slider = document.createElement("span");
        slider.className = "slider";
        sw.appendChild(cb);
        sw.appendChild(slider);

        const hideDot = document.createElement("button");
        hideDot.type = "button";
        hideDot.className = "row-hide-dot";
        hideDot.dataset.hideAliasId = row.item.aliasId;
        hideDot.title = "Move to hidden";
        hideDot.setAttribute("aria-label", "Move " + row.item.name + " to hidden");

        const text = document.createElement("div");
        text.className = "row-main";
        const name = document.createElement("div");
        name.className = "name";
        name.textContent = stripUserJsSuffix(row.item.name);
        text.appendChild(name);

        scriptCell.appendChild(sw);
        scriptCell.appendChild(hideDot);
        scriptCell.appendChild(text);
        tableScriptScrollFollowers.push(scriptCell);

        const rowMetricsScroll = document.createElement("div");
        rowMetricsScroll.className = "metrics-scroll row-metrics metrics-follower" + (row.enabled ? "" : " off");
        const rowMetricsTrack = document.createElement("div");
        rowMetricsTrack.className = "metrics-track";
        const metrics = document.createElement("div");
        metrics.className = "metrics-row";
        metrics.style.gridTemplateColumns = gridTemplate;
        for (const col of cols) {
          metrics.appendChild(makeMetricCell(col, row, seenCellRefs));
        }
        rowMetricsTrack.appendChild(metrics);
        rowMetricsScroll.appendChild(rowMetricsTrack);
        tableMetricScrollFollowers.push(rowMetricsScroll);

        rowWrap.appendChild(scriptCell);
        rowWrap.appendChild(rowMetricsScroll);
        grpRows.appendChild(rowWrap);
      }
      grp.appendChild(grpRows);
      groupsContainer.appendChild(grp);
    }

    host.appendChild(shell);
    const applyScriptColumnWidth = () => {
      shell.style.setProperty("--script-col-w", normalizeScriptColWidth(scriptColWidth, 248) + "px");
    };
    const applyFixedScriptAnchors = () => {
      const currentW = normalizeScriptColWidth(scriptColWidth, 248);
      shell.style.setProperty("--script-col-min-w", currentW + "px");
      inlineControls.style.transform = "";

      const scriptRect = globalHeadScript.getBoundingClientRect();
      const controlsRect = inlineControls.getBoundingClientRect();
      const controlsRight = Math.max(0, Math.round((controlsRect.right || 0) - (scriptRect.left || 0)));

      for (const meta of groupMetaNodes) {
        if (!(meta instanceof HTMLElement)) continue;
        const metaRect = meta.getBoundingClientRect();
        const cssW = Number.parseFloat(getComputedStyle(meta).width || "0") || 0;
        const metaW = Math.max(0, Math.round((metaRect && metaRect.width) || cssW));
        const left = Math.max(0, controlsRight - metaW);
        meta.style.left = left + "px";
        meta.style.transform = "translateY(-50%)";
      }
    };
    const applyColumnLayout = () => {
      const template = buildGridTemplate();
      shell.style.setProperty("--metrics-table-min", computeTotalWidth() + "px");
      const rows = shell.querySelectorAll(".metrics-row");
      for (const row of rows) {
        if (!(row instanceof HTMLElement)) continue;
        row.style.gridTemplateColumns = template;
      }
    };
    const persistColumnLayout = () => {
      if (!currentColKeys.length || !currentColWidths.length) return;
      const next = { ...colWidthMap };
      for (let i = 0; i < currentColKeys.length; i++) {
        const key = String(currentColKeys[i] || "");
        if (!key) continue;
        next[key] = normalizeColWidth(currentColWidths[i], currentColWidths[i]);
      }
      colWidthMap = normalizeColWidthMap(next);
      storageSetColWidthMap(colWidthMap).catch(() => {});
    };
    const persistScriptColumnWidth = () => {
      scriptColWidth = normalizeScriptColWidth(scriptColWidth, 248);
      storageSetScriptColWidth(scriptColWidth).catch(() => {});
    };
    const startColumnResize = (ev, idx, handleEl) => {
      if (!(ev instanceof PointerEvent)) return;
      if (!Number.isFinite(idx) || idx < 0 || idx >= currentColWidths.length) return;
      if (colResizeState && typeof colResizeState.cleanup === "function") {
        try { colResizeState.cleanup(); } catch {}
      }
      const pointerId = ev.pointerId;
      const startX = Number(ev.clientX) || 0;
      const startW = normalizeColWidth(currentColWidths[idx], currentColWidths[idx]);
      const move = (mv) => {
        if (!(mv instanceof PointerEvent)) return;
        if (mv.pointerId !== pointerId) return;
        const delta = (Number(mv.clientX) || 0) - startX;
        currentColWidths[idx] = normalizeColWidth(startW + delta, startW);
        applyColumnLayout();
        syncMetricsSlider();
      };
      const finish = (doneEv) => {
        if (doneEv && doneEv.pointerId !== pointerId) return;
        cleanup();
        persistColumnLayout();
      };
      const cleanup = () => {
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerup", finish, true);
        document.removeEventListener("pointercancel", finish, true);
        if (handleEl && typeof handleEl.releasePointerCapture === "function") {
          try { handleEl.releasePointerCapture(pointerId); } catch {}
        }
        if (colResizeState && colResizeState.pointerId === pointerId) colResizeState = null;
      };
      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", finish, true);
      document.addEventListener("pointercancel", finish, true);
      if (handleEl && typeof handleEl.setPointerCapture === "function") {
        try { handleEl.setPointerCapture(pointerId); } catch {}
      }
      colResizeState = { pointerId, cleanup };
    };
    const startScriptResize = (ev, handleEl) => {
      if (!(ev instanceof PointerEvent)) return;
      if (colResizeState && typeof colResizeState.cleanup === "function") {
        try { colResizeState.cleanup(); } catch {}
      }
      const pointerId = ev.pointerId;
      const startX = Number(ev.clientX) || 0;
      const startW = normalizeScriptColWidth(scriptColWidth, 248);
      const move = (mv) => {
        if (!(mv instanceof PointerEvent)) return;
        if (mv.pointerId !== pointerId) return;
        const delta = (Number(mv.clientX) || 0) - startX;
        scriptColWidth = normalizeScriptColWidth(startW + delta, startW);
        applyScriptColumnWidth();
        applyFixedScriptAnchors();
        syncMetricsSlider();
      };
      const finish = (doneEv) => {
        if (doneEv && doneEv.pointerId !== pointerId) return;
        cleanup();
        persistScriptColumnWidth();
      };
      const cleanup = () => {
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerup", finish, true);
        document.removeEventListener("pointercancel", finish, true);
        if (handleEl && typeof handleEl.releasePointerCapture === "function") {
          try { handleEl.releasePointerCapture(pointerId); } catch {}
        }
        if (colResizeState && colResizeState.pointerId === pointerId) colResizeState = null;
      };
      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", finish, true);
      document.addEventListener("pointercancel", finish, true);
      if (handleEl && typeof handleEl.setPointerCapture === "function") {
        try { handleEl.setPointerCapture(pointerId); } catch {}
      }
      colResizeState = { pointerId, cleanup };
    };
    scriptColResizer.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      startScriptResize(ev, scriptColResizer);
    });
    globalHeadMetrics.addEventListener("pointerdown", (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      const handle = target.closest(".metrics-col-resizer");
      if (!handle || !globalHeadMetrics.contains(handle)) return;
      ev.preventDefault();
      const idx = Number(handle.getAttribute("data-col-resize-idx") || "");
      startColumnResize(ev, idx, handle);
    });
    linkScriptScrollTable(tableScriptScrollFollowers);
    for (const node of tableMetricScrollFollowers) {
      if (!node || typeof node.addEventListener !== "function") continue;
      node.addEventListener("wheel", (ev) => {
        const hasHorizontal = Math.abs(Number(ev.deltaX) || 0) > 0;
        const delta = hasHorizontal ? Number(ev.deltaX) : (ev.shiftKey ? Number(ev.deltaY) : 0);
        if (!delta) return;
        ev.preventDefault();
        metricsMasterScroll.scrollLeft += delta;
      }, { passive: false });
    }
    linkMetricsScrollTable(metricsMasterScroll, tableMetricScrollFollowers);
    const syncMetricsSlider = () => {
      const max = Math.max(0, (metricsMasterScroll.scrollWidth || 0) - (metricsMasterScroll.clientWidth || 0));
      metricsSlider.max = String(max);
      const current = Math.max(0, Math.min(max, Math.round(metricsMasterScroll.scrollLeft || 0)));
      metricsSlider.value = String(current);
      metricsSlider.disabled = max <= 0;
      if (max <= 0) metricsSliderWrap.classList.add("disabled");
      else metricsSliderWrap.classList.remove("disabled");
    };
    metricsMasterScroll.addEventListener("scroll", syncMetricsSlider, { passive: true });
    metricsSlider.addEventListener("input", () => {
      const max = Number(metricsSlider.max || "0");
      const next = Math.max(0, Math.min(max, Number(metricsSlider.value || "0")));
      metricsMasterScroll.scrollLeft = next;
      metricsScrollX = next;
    });
    metricsSliderWrap.addEventListener("wheel", (ev) => {
      const delta = Number(ev.deltaX) || Number(ev.deltaY) || 0;
      if (!delta) return;
      ev.preventDefault();
      metricsMasterScroll.scrollLeft += delta;
    }, { passive: false });
    applyScriptColumnWidth();
    applyFixedScriptAnchors();
    applyColumnLayout();
    syncMetricsSlider();
    requestAnimationFrame(syncMetricsSlider);
    if (pendingRevealAliasId) {
      const aliasId = String(pendingRevealAliasId || "");
      pendingRevealAliasId = "";
      const selectorAlias = (typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function")
        ? CSS.escape(aliasId)
        : aliasId.replace(/"/g, '\\"');
      const rowCb = shell.querySelector('input[type="checkbox"][data-alias-id="' + selectorAlias + '"]');
      const rowWrap = rowCb && rowCb.closest ? rowCb.closest(".grp-rowwrap") : null;
      if (rowWrap && typeof rowWrap.scrollIntoView === "function") {
        rowWrap.scrollIntoView({ block: "center", inline: "nearest" });
      }
    }
    refreshSeenLabels();
  }

  async function persistWorkingEnabledMap(nextMap, messages = {}) {
    const persistentSetSlot = currentPersistentSetSlot();
    if (persistentSetSlot) {
      toggleSets[String(persistentSetSlot)] = {
        savedAt: Date.now(),
        map: normalizeSetMap(nextMap),
      };
      await storageSetSets(toggleSets);
      await loadCurrentPageSetLink(currentTabId, currentChatUrl);
      render();
      elHint.textContent = messages.set || ("Updated Set " + persistentSetSlot + ". Reload the page to apply.");
      return;
    }

    toggleMap = normalizeGlobalToggleMap(nextMap);
    await storageSetMap(toggleMap);
    await loadCurrentPageSetLink(currentTabId, currentChatUrl);
    render();
    elHint.textContent = messages.global || "Changes saved. Reload the page to apply.";
  }

  async function setAliasEnabled(aliasId, enabled) {
    const key = String(aliasId || "");
    if (!key) return;
    const nextMap = snapshotCurrentEnabledMap();
    nextMap[key] = !!enabled;
    await persistWorkingEnabledMap(nextMap, {
      set: "Updated Set " + (currentPersistentSetSlot() || resolvedSetSlot || selectedSetSlot || 0) + ". Reload the page to apply.",
      global: "Changes saved. Reload the page to apply.",
    });
  }

  async function setInfoPref(infoKey, enabled) {
    const key = String(infoKey || "");
    if (!COL_DEFS.some((it) => it.key === key && it.toggleable)) return;
    infoPrefs = { ...infoPrefs, [key]: !!enabled };
    await storageSetInfoPrefs(infoPrefs);
    render();
    elHint.textContent = "Row info columns updated.";
  }

  async function setRuntimeAdvanced(enabled) {
    runtimeAdvanced = !!enabled;
    await storageSetRuntimeAdvanced(runtimeAdvanced);
    render();
    elHint.textContent = runtimeAdvanced
      ? "Advanced runtime ON (last + ewma)."
      : "Advanced runtime OFF (last load only).";
  }

  async function setSortMode(mode) {
    sortMode = normalizeSortMode(mode);
    await storageSetSortMode(sortMode);
    render();
  }

  async function setTopNMode(mode) {
    topNMode = normalizeTopNMode(mode);
    await storageSetTopNMode(topNMode);
    render();
    if (topNMode === "all") {
      elHint.textContent = "TopN = All (no cap).";
    } else if (topNMode === "top10") {
      elHint.textContent = "TopN = 10.";
    } else {
      elHint.textContent = "TopN = 20.";
    }
  }

  async function setTopNScope(scope) {
    topNScope = normalizeTopNScope(scope);
    await storageSetTopNScope(topNScope);
    render();
    elHint.textContent = topNScope === "global"
      ? "Scope = Global (single global stream)."
      : "Scope = Group (per-group view).";
  }

  async function setPopupBgMode(modeRaw) {
    const mode = normalizePopupBgMode(modeRaw);
    applyPopupBgMode(mode);
    await storageSetPopupBgMode(mode);
  }

  async function resetTableLayout() {
    colWidthMap = {};
    scriptColWidth = 248;
    scriptFixedAnchorWidth = null;
    currentColKeys = [];
    currentColWidths = [];
    metricsScrollX = 0;
    scriptScrollX = 0;
    await storageRemoveKeys([STORAGE_COL_WIDTHS_KEY, STORAGE_SCRIPT_COL_WIDTH_KEY]);
    render();
    elHint.textContent = "Table layout reset.";
  }

  async function setAll(enabled) {
    if (!scripts.length) return;
    const next = {};
    for (const it of scripts) {
      next[it.aliasId] = !!enabled;
    }
    await persistWorkingEnabledMap(next, {
      set: (enabled ? "Set " + (currentPersistentSetSlot() || resolvedSetSlot || selectedSetSlot || 0) + " enabled." : "Set " + (currentPersistentSetSlot() || resolvedSetSlot || selectedSetSlot || 0) + " disabled.") + " Reload the page to apply.",
      global: enabled ? "All scripts enabled. Reload the page to apply." : "All scripts disabled. Reload the page to apply.",
    });
  }

  async function setGroupEnabled(groupKey, enabled) {
    if (groupKey === "__GLOBAL__") {
      await setAll(enabled);
      return;
    }
    const g = allGroups.find((it) => it.key === groupKey);
    if (!g) return;
    const next = snapshotCurrentEnabledMap();
    for (const it of g.items) {
      next[it.aliasId] = !!enabled;
    }
    await persistWorkingEnabledMap(next, {
      set: (enabled ? "Enabled " : "Disabled ") + groupDisplayTitle(g) + " in Set " + (currentPersistentSetSlot() || resolvedSetSlot || selectedSetSlot || 0) + ". Reload the page to apply.",
      global: (enabled ? "Enabled " : "Disabled ") + groupDisplayTitle(g) + ". Reload the page to apply.",
    });
  }

  async function setGroupLabel(groupKeyRaw, labelRaw, defaultTitleRaw = "") {
    const key = String(groupKeyRaw || "").trim();
    if (!key) return;
    const fallbackTitle = groupTitleFromOrder(key, sanitizeGroupLabel(defaultTitleRaw, ""));
    const nextTitle = sanitizeGroupLabel(labelRaw, fallbackTitle);
    const currentTitle = sanitizeGroupLabel(groupTitleFromOrder(key, fallbackTitle), "");
    if (!nextTitle || nextTitle === currentTitle) return;

    elHint.textContent = "Requesting group title update...";
    const result = await sendDevOrderCommand({ operation: "set-section-title", sectionKey: key, title: nextTitle });
    if (result && result.ok === true) {
      const liveOrderSections = await fetchLiveDevOrderSections();
      if (Array.isArray(liveOrderSections) && liveOrderSections.length) {
        orderSectionsBase = cloneDevOrderSections(liveOrderSections);
      } else {
        setGroupTitleInBase(key, nextTitle);
      }
      applyCurrentOrderOverrides();
      render();
      elHint.textContent = devOrderSuccessText("Group title saved.", result);
      return;
    }

    // Do not leave the label looking saved when Runtime refused it.
    render();
    throw new Error(devOrderCommandFailureText(result));
  }

`;
}
