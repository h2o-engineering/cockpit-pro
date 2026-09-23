// @version 1.0.0
export function makeChromeLivePopupDataSource() {
  return `  function readTag(metaText, tag) {
    const rx = new RegExp("^\\\\s*//\\\\s*@" + tag + "\\\\s+(.+?)\\\\s*$", "mi");
    const m = String(metaText || "").match(rx);
    return m ? String(m[1]).trim() : "";
  }

  function normalizeRunAt(runAtRaw) {
    const v = String(runAtRaw || "").trim().toLowerCase().replace(/_/g, "-");
    if (v === "document-start") return "document-start";
    if (v === "document-end") return "document-end";
    return "document-idle";
  }

  function stripEmojiAndInvisibles(textRaw) {
    return String(textRaw || "")
      .replace(/[\\u{1F3FB}-\\u{1F3FF}]/gu, "")
      .replace(/[\\p{Extended_Pictographic}]/gu, "")
      .replace(/[\\uFE0E\\uFE0F\\u200D\\u200B-\\u200F\\uFEFF\\u2060\\u00AD]/g, "")
      .replace(/[\\u202A-\\u202E\\u2066-\\u2069]/g, "");
  }

  function toAliasName(filenameRaw) {
    const base = String(filenameRaw || "").replace(/(\\.user)?\\.js$/i, "");
    const firstDot = base.indexOf(".");
    if (firstDot <= 0) return "";
    const id = base.slice(0, firstDot).trim();
    let title = base.slice(firstDot + 1);
    title = stripEmojiAndInvisibles(title)
      .trim()
      .replace(/\\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!id || !title) return "";
    return id + "._" + title + "_.js";
  }

  function normalizeAliasId(aliasRaw) {
    const alias = toAliasName(aliasRaw);
    if (alias) return alias;
    const raw = String(aliasRaw || "").trim();
    return raw ? raw.replace(/\\.user\\.js$/i, ".js") : "";
  }

  function aliasIdFromRequireUrl(urlStr) {
    const raw = String(urlStr || "").trim();
    if (!raw) return "";
    try {
      const u = new URL(raw);
      const parts = String(u.pathname || "").split("/").filter(Boolean);
      const idx = parts.lastIndexOf("alias");
      const tail = idx >= 0 ? parts.slice(idx + 1).join("/") : (parts[parts.length - 1] || "");
      return normalizeAliasId(decodeURIComponent(tail || ""));
    } catch {}
    const m = raw.match(new RegExp("/alias/([^?#]+)", "i"));
    if (m) {
      try { return normalizeAliasId(decodeURIComponent(m[1])); } catch { return normalizeAliasId(m[1]); }
    }
    return normalizeAliasId(raw);
  }

  function normalizeInt(raw, fallback = 0) {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
  }

  function normalizeBool(raw, fallback = false) {
    if (typeof raw === "boolean") return raw;
    return !!fallback;
  }

  function normalizeColWidth(raw, fallback = 80) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return Math.max(42, Math.round(Number(fallback) || 80));
    return Math.max(42, Math.min(640, Math.round(n)));
  }

  function normalizeScriptColWidth(raw, fallback = 248) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return Math.max(248, Math.round(Number(fallback) || 248));
    return Math.max(248, Math.min(620, Math.round(n)));
  }

  function normalizeColWidthMap(rawMap) {
    const out = {};
    if (!rawMap || typeof rawMap !== "object") return out;
    for (const col of COL_DEFS) {
      const key = String(col.key || "");
      if (!Object.prototype.hasOwnProperty.call(rawMap, key)) continue;
      out[key] = normalizeColWidth(rawMap[key], col.width || 80);
    }
    return out;
  }

  function stripDevCacheNoise(url) {
    const raw = String(url || "");
    if (!raw) return raw;
    try {
      const u = new URL(raw, location.href);
      u.searchParams.delete("extcb");
      u.searchParams.delete("cb");
      u.searchParams.delete("cacheBust");
      return u.toString();
    } catch {}
    return raw
      .replace(/([?&])extcb=[^&#]*(&)?/gi, (m, lead, tail) => tail ? lead : "")
      .replace(/([?&])cb=[^&#]*(&)?/gi, (m, lead, tail) => tail ? lead : "")
      .replace(/([?&])cacheBust=[^&#]*(&)?/gi, (m, lead, tail) => tail ? lead : "")
      .replace(/[?&]$/, "")
      .replace("?&", "?");
  }

  function parseProxyPack(packText) {
    const headers = String(packText || "").match(HDR_RE) || [];
    const out = [];
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      const name = readTag(h, "name") || "(unnamed)";
      const runAt = normalizeRunAt(readTag(h, "run-at") || "document-idle");
      const rawRequireUrl = readTag(h, "require");
      if (!rawRequireUrl) continue;
      const aliasId = aliasIdFromRequireUrl(rawRequireUrl) || name;
      const requireUrl = stripDevCacheNoise(rawRequireUrl);
      const metrics = {
        lines: normalizeInt(readTag(h, "h2o-lines")),
        bytes: normalizeInt(readTag(h, "h2o-bytes")),
        score: normalizeInt(readTag(h, "h2o-score")),
        weight: String(readTag(h, "h2o-weight") || "").toLowerCase(),
        watchers: normalizeInt(readTag(h, "h2o-watchers")),
        listeners: normalizeInt(readTag(h, "h2o-listeners")),
      };
      out.push({ name, runAt, requireUrl, aliasId, metrics, packIndex: i });
    }
    return out;
  }

  function groupInfoForAlias(aliasId) {
    const id = String(aliasId || "").split(".")[0].toUpperCase();
    if (/^0A/.test(id)) return { key: "CORE", title: "🧠 CORE", order: 10 };
    if (/^0B/.test(id) || /^0W/.test(id)) return { key: "UNMOUNT_PAGINATION", title: "🪟 CHAT FLOW", order: 20 };
    if (/^0C/.test(id)) return { key: "PERFORMANCE", title: "⚡ PERFORMANCE", order: 30 };
    if (/^0D/.test(id)) return { key: "DATA", title: "🗄️ DATA", order: 40 };
    if (/^0X/.test(id)) return { key: "COMMAND_BAR_SIDE_ACTIONS", title: "🎛️ SYSTEM SURFACES", order: 50 };
    if (/^0Z/.test(id)) return { key: "CONTROL_HUB", title: "🕹️ CONTROL HUB", order: 60 };
    if (/^1A1/.test(id)) return { key: "MINIMAP_BASE", title: "🗺️ MINIMAP BASE", order: 70 };
    if (/^1A/.test(id)) return { key: "MINIMAP_PLUGINS", title: "🧩 MM ADD-ONS + PLUGINS", order: 80 };
    if (/^1B/.test(id)) return { key: "MM_FEATURE_UI", title: "🖱️ MM FEATURE UI", order: 90 };
    if (/^1/.test(id)) return { key: "ANSWERS_UI", title: "🧱 ANSWER UI", order: 100 };
    if (/^2/.test(id)) return { key: "QUESTIONS_UI", title: "❓ QUESTION UI", order: 110 };
    if (/^3Z/.test(id) || /^4/.test(id)) return { key: "WORKSPACE", title: "🧱 WORKSPACE", order: 130 };
    if (/^3/.test(id)) return { key: "DOCK_ENGINES_TABS", title: "🧱 DOCK", order: 120 };
    if (/^5/.test(id)) return { key: "EXPORT", title: "📤 EXPORT", order: 140 };
    if (/^6/.test(id)) return { key: "UTILITIES", title: "🧰 UTILITIES + PORTALS + SECTIONS", order: 150 };
    if (/^7/.test(id)) return { key: "PROMPTS", title: "📝 PROMPTS", order: 160 };
    if (/^8/.test(id)) return { key: "THEMES_SKINS", title: "🎨 THEMES + SKINS + INPUT", order: 170 };
    if (/^9/.test(id)) return { key: "INTERFACE", title: "🖥️ INTERFACE", order: 180 };
    if (/^X/.test(id)) return { key: "EXPERIMENTAL", title: "🧪 EXPERIMENTAL", order: 190 };
    return { key: "OTHER", title: "📦 OTHER", order: 999 };
  }

  function currentOrderSections() {
    return Array.isArray(orderSections) && orderSections.length ? orderSections : orderSectionsBase;
  }

  function groupKeyForAlias(aliasIdRaw) {
    const info = groupInfoForAlias(aliasIdRaw);
    return String(info && info.key || "").trim();
  }

  function findOrderSectionsByGroupKey(groupKeyRaw, sectionsRaw = null) {
    const groupKey = String(groupKeyRaw || "").trim();
    const sections = Array.isArray(sectionsRaw) ? sectionsRaw : currentOrderSections();
    if (!groupKey || !Array.isArray(sections)) return [];
    const out = [];
    for (const sec of sections) {
      const items = Array.isArray(sec && sec.items) ? sec.items : [];
      let matched = false;
      for (const row of items) {
        const aliasId = String(row && row.file || "").trim();
        if (!aliasId) continue;
        if (groupKeyForAlias(aliasId) !== groupKey) continue;
        matched = true;
        break;
      }
      if (matched) out.push(sec);
    }
    return out;
  }

  function groupTitleFromOrder(groupKeyRaw, fallback = "") {
    const sections = findOrderSectionsByGroupKey(groupKeyRaw);
    const title = String(sections[0] && sections[0].title || "").trim();
    return title || String(fallback || "").trim();
  }

  function groupScripts(list) {
    const displayIndexMap = buildDisplayIndexMap(currentOrderSections());
    const sorted = Array.isArray(list)
      ? list.slice().sort((a, b) => compareScriptsByDisplayOrder(a, b, displayIndexMap))
      : [];
    const byKey = new Map();
    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i];
      const aliasId = normalizeAliasId(item && item.aliasId || "");
      if (aliasId) {
        item.displayIndex = displayIndexMap.has(aliasId) ? Number(displayIndexMap.get(aliasId)) : i;
      }
      const info = groupInfoForAlias(item.aliasId);
      let group = byKey.get(info.key);
      if (!group) {
        group = {
          ...info,
          title: groupTitleFromOrder(info.key, info.title),
          firstIndex: i,
          items: [],
        };
        byKey.set(info.key, group);
      }
      group.items.push(item);
    }
    return Array.from(byKey.values()).sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.firstIndex - b.firstIndex;
    });
  }

  function buildDisplayIndexMap(rawSections) {
    const out = new Map();
    const sections = Array.isArray(rawSections) ? rawSections : [];
    let idx = 0;
    for (const sec of sections) {
      const items = Array.isArray(sec && sec.items) ? sec.items : [];
      for (const row of items) {
        const aliasId = normalizeAliasId(row && row.file || "");
        if (!aliasId || out.has(aliasId)) continue;
        out.set(aliasId, idx);
        idx += 1;
      }
    }
    return out;
  }

  function compareScriptsByDisplayOrder(a, b, displayIndexMap) {
    const aAlias = normalizeAliasId(a && a.aliasId || "");
    const bAlias = normalizeAliasId(b && b.aliasId || "");
    const aIdx = displayIndexMap.has(aAlias) ? Number(displayIndexMap.get(aAlias)) : Number.MAX_SAFE_INTEGER;
    const bIdx = displayIndexMap.has(bAlias) ? Number(displayIndexMap.get(bAlias)) : Number.MAX_SAFE_INTEGER;
    if (aIdx !== bIdx) return aIdx - bIdx;
    const aPack = normalizeInt(a && a.packIndex, Number.MAX_SAFE_INTEGER);
    const bPack = normalizeInt(b && b.packIndex, Number.MAX_SAFE_INTEGER);
    if (aPack !== bPack) return aPack - bPack;
    return String(aAlias || "").localeCompare(String(bAlias || ""), undefined, { numeric: true });
  }

  function devConfigUrl(fileName) {
    const fallback = "http://127.0.0.1:5500/config/" + String(fileName || "");
    try {
      const u = new URL(PROXY_PACK_URL);
      return u.origin + "/config/" + String(fileName || "");
    } catch {}
    return fallback;
  }

  // Same origin as the config reads, for the Developer Controls command
  // endpoint. dev-order.txt/.json are generated projections owned by the
  // Runtime command, so the popup no longer addresses them at all.
  function devServerUrl(pathName) {
    const suffix = String(pathName || "");
    const fallback = "http://127.0.0.1:5500" + suffix;
    try {
      return new URL(PROXY_PACK_URL).origin + suffix;
    } catch {}
    return fallback;
  }

  const DEV_ORDER_TSV_URL = devConfigUrl("dev-order.tsv");

  function parseDevOrderEnabledToken(tokenRaw) {
    const raw = String(tokenRaw || "").trim();
    if (!raw) return null;
    if (["✅", "🟢", "🟩"].includes(raw)) return true;
    if (["❌", "🔴", "🟥"].includes(raw)) return false;
    const v = raw.toLowerCase();
    if (["on", "1", "true", "yes"].includes(v)) return true;
    if (["off", "0", "false", "no"].includes(v)) return false;
    return null;
  }

  function sanitizeOrderSectionKey(titleRaw, idx) {
    const base = String(titleRaw || "")
      .replace(/\\s+/g, "_")
      .replace(/[^A-Za-z0-9_]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
    return base || ("SECTION_" + String((Number(idx) || 0) + 1));
  }

  function normalizeDevOrderSections(rawSections) {
    const out = [];
    if (!Array.isArray(rawSections)) return out;
    for (let i = 0; i < rawSections.length; i++) {
      const src = rawSections[i];
      if (!src || typeof src !== "object") continue;
      const title = String(src.title || "").trim();
      const key = String(src.key || "").trim() || ("SECTION_" + (i + 1));
      const itemsRaw = Array.isArray(src.items) ? src.items : [];
      const items = [];
      for (const row of itemsRaw) {
        if (!row || typeof row !== "object") continue;
        const file = toAliasName(String(row.file || "").trim());
        if (!file) continue;
        items.push({
          file,
          enabled: row.enabled === true,
        });
      }
      if (!items.length) continue;
      out.push({
        key,
        title: title || key,
        items,
      });
    }
    return out;
  }

  function normalizeAliasFilenameMap(rawMap) {
    const out = {};
    if (!rawMap || typeof rawMap !== "object") return out;
    for (const [k, v] of Object.entries(rawMap)) {
      const aliasId = normalizeAliasId(k);
      const file = String(v || "").trim();
      if (!aliasId || !file) continue;
      out[aliasId] = file;
    }
    return out;
  }

  function stripUserJsSuffix(raw) {
    return String(raw || "").replace(/(\\.user)?\\.js$/i, "").trim();
  }

  function displayFilenameForAlias(aliasIdRaw) {
    const aliasId = String(aliasIdRaw || "").trim();
    if (!aliasId) return "";
    return stripUserJsSuffix(String(aliasFilenameMap[aliasId] || aliasId));
  }

  function findScriptByAlias(aliasIdRaw) {
    const aliasId = String(aliasIdRaw || "").trim();
    if (!aliasId) return null;
    for (const item of scripts) {
      if (String(item && item.aliasId || "").trim() === aliasId) return item;
    }
    return null;
  }

  function aliasRequireUrl(aliasIdRaw) {
    const aliasId = normalizeAliasId(aliasIdRaw);
    if (!aliasId) return "";
    const enc = encodeURIComponent(aliasId);
    try {
      const u = new URL(PROXY_PACK_URL);
      return u.origin + "/alias/" + enc;
    } catch {}
    return "http://127.0.0.1:5500/alias/" + enc;
  }

  function ensureVisibleScriptRow(aliasIdRaw) {
    const aliasId = String(aliasIdRaw || "").trim();
    if (!aliasId) return false;
    if (findScriptByAlias(aliasId)) return false;

    let maxPackIndex = -1;
    for (const it of scripts) {
      const p = Number(it && it.packIndex);
      if (Number.isFinite(p) && p > maxPackIndex) maxPackIndex = p;
    }

    scripts.push({
      name: displayFilenameForAlias(aliasId),
      runAt: "document-idle",
      requireUrl: aliasRequireUrl(aliasId),
      aliasId,
      metrics: {
        lines: 0,
        bytes: 0,
        score: 0,
        weight: "",
        watchers: 0,
        listeners: 0,
      },
      packIndex: maxPackIndex + 1,
    });
    return true;
  }

  function removeVisibleScriptRow(aliasIdRaw) {
    const aliasId = String(aliasIdRaw || "").trim();
    if (!aliasId) return false;
    const before = scripts.length;
    scripts = scripts.filter((it) => String(it && it.aliasId || "").trim() !== aliasId);
    return scripts.length !== before;
  }

  function cloneDevOrderSections(rawSections) {
    return normalizeDevOrderSections(rawSections);
  }

  function normalizeOrderOverrideMap(rawMap) {
    const out = {};
    if (!rawMap || typeof rawMap !== "object") return out;
    for (const [k, v] of Object.entries(rawMap)) {
      const aliasId = normalizeAliasId(k);
      if (!aliasId) continue;
      out[aliasId] = v === true;
    }
    return out;
  }

  function applyOrderOverrides(baseSections, overridesRaw) {
    const overrides = normalizeOrderOverrideMap(overridesRaw);
    const next = cloneDevOrderSections(baseSections);
    for (const sec of next) {
      for (const row of sec.items) {
        const aliasId = String(row && row.file || "").trim();
        if (!aliasId) continue;
        if (!Object.prototype.hasOwnProperty.call(overrides, aliasId)) continue;
        row.enabled = overrides[aliasId] === true;
      }
    }
    return next;
  }

  function applyCurrentOrderOverrides() {
    orderSections = applyOrderOverrides(orderSectionsBase, orderOverrideMap);
  }

  function setOrderEnabledInBase(aliasIdRaw, enabledRaw) {
    const aliasId = String(aliasIdRaw || "").trim();
    if (!aliasId) return false;
    let changed = false;
    const nextEnabled = enabledRaw === true;
    for (const sec of orderSectionsBase) {
      for (const row of sec.items) {
        const file = String(row && row.file || "").trim();
        if (file !== aliasId) continue;
        if (row.enabled !== nextEnabled) {
          row.enabled = nextEnabled;
          changed = true;
        }
      }
    }
    return changed;
  }

  function setGroupTitleInBase(groupKeyRaw, titleRaw) {
    const groupKey = String(groupKeyRaw || "").trim();
    const nextTitle = String(titleRaw || "").trim();
    if (!groupKey || !nextTitle) return false;
    let changed = false;
    for (const sections of [orderSectionsBase, orderSections]) {
      for (const sec of findOrderSectionsByGroupKey(groupKey, sections)) {
        if (String(sec && sec.title || "").trim() === nextTitle) continue;
        sec.title = nextTitle;
        changed = true;
      }
    }
    return changed;
  }

  function collectOrderEnabledMap() {
    const out = {};
    for (const sec of orderSections) {
      const items = Array.isArray(sec && sec.items) ? sec.items : [];
      for (const row of items) {
        const aliasId = String(row && row.file || "").trim();
        if (!aliasId) continue;
        out[aliasId] = row.enabled === true;
      }
    }
    return out;
  }

  function syncVisibleScriptsWithOrder() {
    const orderEnabledMap = collectOrderEnabledMap();
    if (!Object.keys(orderEnabledMap).length) return false;

    let changed = false;
    for (const [aliasId, enabled] of Object.entries(orderEnabledMap)) {
      if (enabled) {
        if (ensureVisibleScriptRow(aliasId)) changed = true;
        continue;
      }
      if (forcedVisibleAliasIds.has(aliasId)) continue;
      if (removeVisibleScriptRow(aliasId)) changed = true;
    }

    return changed;
  }

  function parseDevOrderSectionsFromTsv(text) {
    const sections = [];
    let current = null;
    let sectionIdx = 0;

    const ensureSection = (titleRaw) => {
      const title = String(titleRaw || "").trim();
      if (!title) return null;
      const sec = {
        key: sanitizeOrderSectionKey(title, sectionIdx),
        title,
        items: [],
      };
      sectionIdx += 1;
      sections.push(sec);
      return sec;
    };

    for (const rawLine of String(text || "").split(/\\r?\\n/)) {
      const line = String(rawLine || "").trim();
      if (!line) continue;

      if (line.startsWith("#")) {
        const title = line.replace(/^#\\s*/, "").trim();
        if (!title) continue;
        if (/^=+$/.test(title)) continue;
        if (/^h2o dev order/i.test(title)) continue;
        if (/^master:/i.test(title)) continue;
        current = ensureSection(title);
        continue;
      }

      const parts = line.split("\\t");
      if (parts.length < 2) continue;
      const enabled = parseDevOrderEnabledToken(parts[0]) === true;
      const file = toAliasName(String(parts.slice(1).join("\\t") || "").trim());
      if (!file) continue;
      if (!current) current = ensureSection("Other");
      current.items.push({ file, enabled });
    }

    return normalizeDevOrderSections(sections);
  }

  function recomputeOrderDerivedState() {
    const visibleAliasSet = new Set();
    for (const item of scripts) {
      const aliasId = String(item && item.aliasId || "").trim();
      if (aliasId) visibleAliasSet.add(aliasId);
    }

    const nextGroupTotals = {};
    const nextHiddenSections = [];
    let nextHiddenNonVisible = 0;
    let nextHiddenOff = 0;

    for (const sec of orderSections) {
      const hiddenItems = [];
      for (const row of sec.items) {
        const aliasId = String(row && row.file || "").trim();
        if (!aliasId) continue;

        const info = groupInfoForAlias(aliasId);
        const gKey = String(info && info.key || "OTHER");
        nextGroupTotals[gKey] = (Number(nextGroupTotals[gKey]) || 0) + 1;

        const isVisible = visibleAliasSet.has(aliasId);
        if (!isVisible) {
          const enabled = row.enabled === true;
          hiddenItems.push({ aliasId, enabled });
          nextHiddenNonVisible += 1;
          if (!enabled) nextHiddenOff += 1;
        }
      }

      if (hiddenItems.length) {
        nextHiddenSections.push({
          key: sec.key,
          title: sec.title,
          items: hiddenItems,
        });
      }
    }

    groupExpectedTotals = nextGroupTotals;
    hiddenNonVisibleSections = nextHiddenSections;
    hiddenNonVisibleTotal = nextHiddenNonVisible;
    hiddenOffTotal = nextHiddenOff;
  }
`;
}
