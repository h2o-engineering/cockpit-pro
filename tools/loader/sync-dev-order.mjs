// tools/loader/sync-dev-order.mjs
// @version 1.2.0  (Phase 0D migration: SRC_ROOT and ORDER_FILE sourced from tools/paths.mjs)
//
// Purpose:
// - Scan SRC for source script files (*.user.js or *.js)
// - Maintain a sectioned, human-readable dev-order file using real source filenames
// - Keep alias filenames as a derived compatibility layer for downstream tooling
//
// Master format: TSV (editable)
//   STATUS<TAB>SOURCE_FILENAME
//   STATUS = 🟢 / 🔴
//   (Reader accepts: 🟢/🔴, ✅/❌, 🟩/🟥, ON/OFF, true/false, 1/0, yes/no)
//
// This script also emits beside it:
// - dev-order.txt (human list; OFF uses "- ")
// - dev-order.json (view; enabled boolean)
// - scripts-list.tsv (raw filenames; one per line)
// - userscript-headers.tsv (filename + full UserScript header block as readable multi-line rows)
// - userscript-headers.html (colorized accessible view)
//
// Critical behavior:
// - PRESERVES your previous choices from the existing TSV
// - Adds new files with defaults (INTERFACE/EXPERIMENTAL default 🔴, others 🟢)
// - Removes deleted files automatically (because we re-scan SRC each time)
//
// Phase 0D note: SRC_ROOT and ORDER_FILE defaults now come from tools/paths.mjs.
// Env-var overrides (H2O_SRC_DIR, H2O_ORDER_FILE) are honored identically through
// paths.mjs. Derived output paths (OUT_TXT, OUT_JSON, scripts-list.tsv, etc.)
// continue to be computed locally from ORDER_FILE's directory + STEM so that any
// custom ORDER_FILE location still anchors the sibling outputs correctly.
// LOCAL toAliasName intentionally retains the legacy ".user.js" alias suffix
// (different from make-aliases.mjs's ".js" suffix); this is required for
// backward-compatible matching of older TSV entries and must NOT be replaced
// with tools/script-registry.mjs's helper, which produces ".js" aliases.

import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT, DEV_ORDER_TSV, RUNTIME_BASE_REL } from "../paths.mjs";

/* -----------------------------
   ENV / PATHS
------------------------------ */

// Local aliases preserve pre-Phase-0D variable names. Each resolves to the
// same value as before under the same env-var overrides:
//   SRC_ROOT   === REPO_ROOT     (process.env.H2O_SRC_DIR    || <repo>)
//   ORDER_FILE === DEV_ORDER_TSV (process.env.H2O_ORDER_FILE || <CONFIG_DIR>/dev-order.tsv)
const SRC_ROOT = REPO_ROOT;
const ORDER_FILE = DEV_ORDER_TSV;

const DIR = path.dirname(ORDER_FILE);
fs.mkdirSync(DIR, { recursive: true });

const BASE = path.basename(ORDER_FILE);
const STEM = BASE.replace(/\.(json|tsv|txt)$/i, "");

const OUT_TSV = path.join(DIR, `${STEM}.tsv`);
const OUT_TXT = path.join(DIR, `${STEM}.txt`);
const OUT_JSON = path.join(DIR, `${STEM}.json`);
const OUT_SCRIPTS_LIST_TSV = path.join(DIR, "scripts-list.tsv");
const OUT_USERSCRIPT_HEADERS_TSV = path.join(DIR, "userscript-headers.tsv");
const OUT_USERSCRIPT_HEADERS_HTML = path.join(DIR, "userscript-headers.html");
const USERSCRIPT_HEADER_RE = /\/\/\s*==H2O Module==[\s\S]*?\/\/\s*==\/H2O Module==/;
const DEBUG_SYNC_DEV_ORDER = process.env.H2O_DEBUG_SYNC_DEV_ORDER === "1";
const RUN_STARTED_AT = Date.now();

function logDebug(message) {
  if (!DEBUG_SYNC_DEV_ORDER) return;
  const elapsedMs = String(Date.now() - RUN_STARTED_AT).padStart(5, " ");
  console.error(`[H2O][sync-dev-order][+${elapsedMs}ms] ${message}`);
}

function writeTextFileAtomic(fp, text) {
  const target = path.resolve(fp);
  const dir = path.dirname(target);
  const base = path.basename(target);
  const temp = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}`);
  logDebug(`write start: ${target}`);
  fs.writeFileSync(temp, text, "utf8");
  fs.renameSync(temp, target);
  logDebug(`write done: ${target}`);
}

function pickUserScriptDir(srcRoot) {
  // Phase 8K-4: RUNTIME_BASE_REL replaces the hardcoded "scripts" literal.
  const scriptsDir = path.join(srcRoot, RUNTIME_BASE_REL);
  try {
    if (!fs.existsSync(scriptsDir) || !fs.statSync(scriptsDir).isDirectory()) return srcRoot;
    const entries = fs.readdirSync(scriptsDir, { withFileTypes: true });
    return entries.some((e) => e.isFile() && isSourceScriptName(e.name)) ? scriptsDir : srcRoot;
  } catch {
    return srcRoot;
  }
}

const SCRIPT_SRC_DIR = pickUserScriptDir(SRC_ROOT);

/* -----------------------------
   Alias rules (must match make-aliases.mjs)
------------------------------ */

function stripEmojiAndInvisibles(s) {
  return String(s || "")
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "")
    .replace(/[\p{Extended_Pictographic}]/gu, "")
    .replace(/[\uFE0E\uFE0F\u200D\u200B-\u200F\uFEFF\u2060\u00AD]/g, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
}

function toAliasName(filename) {
  const base = String(filename || "").replace(/(\.user)?\.js$/i, "");
  const firstDot = base.indexOf(".");
  if (firstDot <= 0) return null;

  const id = base.slice(0, firstDot).trim();
  let title = base.slice(firstDot + 1);

  title = stripEmojiAndInvisibles(title)
    .trim()
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!id || !title) return null;
  return `${id}._${title}_.user.js`;
}

function isSourceScriptName(filename) {
  const name = String(filename || "");
  if (!/(\.user)?\.js$/i.test(name)) return false;
  return toAliasName(name) !== null;
}

function normalizeOrderEntryToSourceName(file, sourceNames, aliasToSource) {
  const raw = String(file || "").trim();
  if (!raw) return "";
  if (sourceNames.has(raw)) return raw;
  const alias = toAliasName(raw);
  if (!alias) return "";
  return aliasToSource.get(alias) || "";
}

/* -----------------------------
   Status parsing / rendering
------------------------------ */

// Internal status is normalized to "ON" | "OFF" for safety.
// TSV output is always 🟢 / 🔴.

function parseStatusToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;

  // Emoji toggles
  // ON:  ✅ 🟢 🟩
  // OFF: ❌ 🔴 🟥
  if (raw === "✅" || raw === "🟢" || raw === "🟩") return "ON";
  if (raw === "❌" || raw === "🔴" || raw === "🟥") return "OFF";

  // Plain words / booleans / numbers
  const v = raw.toLowerCase();
  if (v === "on" || v === "1" || v === "true" || v === "yes") return "ON";
  if (v === "off" || v === "0" || v === "false" || v === "no") return "OFF";

  return null;
}

function statusToEmoji(st) {
  return st === "OFF" ? "🔴" : "🟢";
}

function emojiToStatus(emojiOrToken) {
  return parseStatusToken(emojiOrToken) || null;
}

/* -----------------------------
   Read existing TSV (preserve your choices)
------------------------------ */

function readExistingTSV(fp, sourceNames, aliasToSource) {
  const statusMap = new Map(); // source filename -> "ON" | "OFF"
  const sectionOrderMap = new Map();
  const sectionTitleMap = new Map();
  for (const sec of SECTIONS) sectionOrderMap.set(sec.key, []);
  if (!fs.existsSync(fp)) return { statusMap, sectionOrderMap, sectionTitleMap };

  const txt = fs.readFileSync(fp, "utf8");
  let currentSectionKey = "";
  let currentSectionTitle = "";
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const title = line.replace(/^#\s*/, "").trim();
      if (!title) continue;
      if (
        /^=+$/.test(title) ||
        /^h2o dev order/i.test(title) ||
        /^master:/i.test(title) ||
        /^status<tab>filename/i.test(title)
      ) {
        continue;
      }
      currentSectionTitle = title;
      const section = SECTIONS.find((sec) => title === sec.title);
      currentSectionKey = section ? section.key : "";
      if (currentSectionKey && !sectionTitleMap.has(currentSectionKey)) {
        sectionTitleMap.set(currentSectionKey, title);
      }
      continue;
    }

    // allow inline comments (keeps your headers clean)
    const noInline = line.replace(/\s+#.*$/, "").trim();
    if (!noInline) continue;

    const parts = noInline.split("\t");
    if (parts.length < 2) continue;

    const status = emojiToStatus(parts[0]);
    const rawFile = parts.slice(1).join("\t").trim();
    if (!rawFile || !/(\.user)?\.js$/i.test(rawFile)) continue;
    const file = normalizeOrderEntryToSourceName(rawFile, sourceNames, aliasToSource);
    if (!file) continue;

    if (status) statusMap.set(file, status);
    const sectionKey = currentSectionKey || groupOf(file);
    if (currentSectionTitle && !sectionTitleMap.has(sectionKey)) {
      sectionTitleMap.set(sectionKey, currentSectionTitle);
    }
    const sectionList = sectionOrderMap.get(sectionKey) || [];
    if (!sectionList.includes(file)) sectionList.push(file);
    if (!sectionOrderMap.has(sectionKey)) sectionOrderMap.set(sectionKey, sectionList);
  }

  return { statusMap, sectionOrderMap, sectionTitleMap };
}

/* -----------------------------
   Sectioning / sorting
------------------------------ */

function sortKey(filename) {
  const id = String(filename || "").split(".")[0] || filename;
  const m = id.match(/^(\d+)(.*)$/);
  const num = m ? Number(m[1]) : 9999;
  const tail = m ? m[2] : id;
  return `${String(num).padStart(4, "0")}:${tail}:${filename}`;
}

function groupOf(filename) {
  const id = String(filename || "").split(".")[0] || "";

  if (/^0A/i.test(id)) return "CORE";
  if (/^0B/i.test(id) || /^0W/i.test(id)) return "UNMOUNT_PAGINATION";
  if (/^0C/i.test(id)) return "PERFORMANCE";
  // Loader V2.3: five non-foundation DATA scripts move to a parallel
  // LATE_DATA section so the serial drain finishes earlier. These are UI/
  // integration layers verified to be late-tolerant by code evidence:
  // 0D3c/d/e use waitForEngine + queue-and-flush handshake with 0D3a;
  // 0D4b/0D5b are modals only reached via lazy click handlers in 0Z1e.
  // The remaining 0D scripts (Data Core, Data Sync, Archive Engine + Bridge,
  // Identity Core, Billing Core) stay in serial DATA.
  if (/^0D3[cde]$|^0D4b$|^0D5b$/i.test(id)) return "LATE_DATA";
  if (/^0D/i.test(id)) return "DATA";
  if (/^0X/i.test(id)) return "COMMAND_BAR_SIDE_ACTIONS";
  // Loader V2.2: Library Core / Workspace / Index live in their own section
  // between SYSTEM SURFACES and CONTROL HUB so they land in early parallel
  // batches (positions 2–4 of the parallel lane) instead of the OTHER tail.
  // Other 0F scripts (Insights, Store, Maintenance, Projects, Folders,
  // Categories, Tags, Labels) still fall through to OTHER.
  if (/^0F1[abc]/i.test(id)) return "LIBRARY_CORE";
  // Loader V2.4: eager Control Hub plugin tabs + Tab Tree move out of the
  // serial CONTROL HUB lane into a parallel CHUB_PLUGINS section. Each plugin
  // implements register-at-init + addEventListener (and several add interval
  // polling) — verified safe to run after Control Hub via getApi() lookup.
  // Only the Hub base (0Z1a) and the existing L5 on-demand tabs (0Z1c/d/i/j/
  // l/m/n/o/p) remain in CONTROL_HUB. The L5 entries stay there because the
  // V2 on-demand machinery filters them out of eager loading at runtime.
  if (/^0Z1[befghk]$|^0Z2a$/i.test(id)) return "CHUB_PLUGINS";
  if (/^0Z/i.test(id)) return "CONTROL_HUB";

  // Loader V2.5: 1A1f MiniMap Views moves to its own parallel MINIMAP_VIEWS
  // section. Views is a self-installing registry attacher (185 lines, no DOM
  // observers, no consumer in eager chain — only L5 0Z1c MiniMap Tab reads
  // its API). Skin/Core/Shell/Engine remain in MINIMAP_BASE serial.
  if (/^1A1f$/i.test(id)) return "MINIMAP_VIEWS";
  if (/^1A1/i.test(id)) return "MINIMAP_BASE";
  if (/^1A/i.test(id)) return "MINIMAP_PLUGINS";
  if (/^1B/i.test(id)) return "MM_FEATURE_UI";

  if (/^1/i.test(id)) return "ANSWERS_UI";
  if (/^2/i.test(id)) return "QUESTIONS_UI";
  if (/^3Z/i.test(id) || /^4/i.test(id)) return "WORKSPACE";
  if (/^3/i.test(id)) return "DOCK_ENGINES_TABS";
  if (/^5/i.test(id)) return "EXPORT";
  if (/^6/i.test(id)) return "UTILITIES";
  if (/^7/i.test(id)) return "PROMPTS";
  if (/^8/i.test(id)) return "THEMES_SKINS";
  if (/^9/i.test(id)) return "INTERFACE";
  if (/^X/i.test(id)) return "EXPERIMENTAL";

  return "OTHER";
}

const SECTIONS = [
  {
    key: "CORE",
    title: "🧠 CORE",
    header: ["# =========================", "# 🧠 CORE", "# ========================="],
  },
  {
    key: "UNMOUNT_PAGINATION",
    title: "🪟 CHAT FLOW",
    header: [
      "# =========================",
      "# 🪟 CHAT FLOW",
      "# =========================",
    ],
  },
  {
    key: "PERFORMANCE",
    title: "⚡ PERFORMANCE",
    header: ["# =========================", "# ⚡ PERFORMANCE", "# ========================="],
  },
  {
    key: "DATA",
    title: "🗄️ DATA",
    header: ["# =========================", "# 🗄️ DATA", "# ========================="],
  },
  {
    key: "COMMAND_BAR_SIDE_ACTIONS",
    title: "🎛️ SYSTEM SURFACES",
    header: [
      "# =========================",
      "# 🎛️ SYSTEM SURFACES",
      "# =========================",
    ],
  },
  {
    key: "LIBRARY_CORE",
    title: "🗂️ LIBRARY CORE",
    header: [
      "# =========================",
      "# 🗂️ LIBRARY CORE",
      "# =========================",
    ],
  },
  {
    key: "LATE_DATA",
    title: "🧯 LATE DATA",
    header: [
      "# =========================",
      "# 🧯 LATE DATA",
      "# =========================",
    ],
  },
  {
    key: "CONTROL_HUB",
    title: "🕹️ CONTROL HUB",
    header: ["# =========================", "# 🕹️ CONTROL HUB", "# ========================="],
  },
  {
    key: "CHUB_PLUGINS",
    title: "🔌 CONTROL HUB PLUGINS",
    header: [
      "# =========================",
      "# 🔌 CONTROL HUB PLUGINS",
      "# =========================",
    ],
  },
  {
    key: "MINIMAP_BASE",
    title: "🗺️ MINIMAP BASE",
    header: ["# =========================", "# 🗺️ MINIMAP BASE", "# ========================="],
  },
  {
    key: "MINIMAP_VIEWS",
    title: "🗺️ MINIMAP VIEWS",
    header: [
      "# =========================",
      "# 🗺️ MINIMAP VIEWS",
      "# =========================",
    ],
  },
  {
    key: "MINIMAP_PLUGINS",
    title: "🧩 MM ADD-ONS + PLUGINS",
    header: [
      "# =========================",
      "# 🧩 MM ADD-ONS + PLUGINS",
      "# =========================",
    ],
  },
  {
    key: "MM_FEATURE_UI",
    title: "🖱️ MM FEATURE UI",
    header: ["# =========================", "# 🖱️ MM FEATURE UI", "# ========================="],
  },
  {
    key: "ANSWERS_UI",
    title: "🧱 ANSWER UI",
    header: ["# =========================", "# 🧱 ANSWER UI", "# ========================="],
  },
  {
    key: "QUESTIONS_UI",
    title: "❓ QUESTION UI",
    header: ["# =========================", "# ❓ QUESTION UI", "# ========================="],
  },
  {
    key: "DOCK_ENGINES_TABS",
    title: "🧱 DOCK",
    header: [
      "# =========================",
      "# 🧱 DOCK",
      "# =========================",
    ],
  },
  {
    key: "WORKSPACE",
    title: "🧱 WORKSPACE",
    header: ["# =========================", "# 🧱 WORKSPACE", "# ========================="],
  },
  {
    key: "EXPORT",
    title: "📤 EXPORT",
    header: ["# =========================", "# 📤 EXPORT", "# ========================="],
  },
  {
    key: "UTILITIES",
    title: "🧰 UTILITIES + PORTALS + SECTIONS",
    header: [
      "# =========================",
      "# 🧰 UTILITIES + PORTALS + SECTIONS",
      "# =========================",
    ],
  },
  {
    key: "PROMPTS",
    title: "📝 PROMPTS",
    header: ["# =========================", "# 📝 PROMPTS", "# ========================="],
  },
  {
    key: "THEMES_SKINS",
    title: "🎨 THEMES + SKINS + INPUT",
    header: ["# =========================", "# 🎨 THEMES + SKINS + INPUT", "# ========================="],
  },
  {
    key: "INTERFACE",
    title: "🖥️ INTERFACE",
    header: ["# =========================", "# 🖥️ INTERFACE", "# ========================="],
  },
  {
    key: "EXPERIMENTAL",
    title: "🧪 EXPERIMENTAL",
    header: [
      "# =========================",
      "# 🧪 EXPERIMENTAL",
      "# =========================",
    ],
  },
  {
    key: "OTHER",
    title: "📦 OTHER",
    header: ["# =========================", "# 📦 OTHER", "# ========================="],
  },
];

function defaultStatusForGroup(groupKey) {
  return (groupKey === "INTERFACE" || groupKey === "EXPERIMENTAL") ? "OFF" : "ON";
}

function buildSectionHeader(titleRaw) {
  const title = String(titleRaw || "").trim();
  return ["# =========================", `# ${title}`, "# ========================="];
}

function resolveSections(sectionTitleMap) {
  return SECTIONS.map((sec) => ({
    key: sec.key,
    title: String(sectionTitleMap?.get(sec.key) || sec.title || "").trim() || sec.title,
  }));
}

/* -----------------------------
   Writers
------------------------------ */

function writeTSV({ fp, sections, sectioned, statusMap }) {
  const out = [];

  out.push(`# H2O dev order (source filenames) — TSV (sectioned)`);
  out.push(`# MASTER: ${path.basename(fp)}`);
  out.push(
    `# STATUS<TAB>FILENAME   (STATUS = 🟢/🔴; accepts ON/OFF, ✅/❌, 🟩/🟥 when reading)`
  );
  out.push("");

  for (const sec of sections) {
    const list = sectioned.get(sec.key) || [];
    if (!list.length) continue;

    out.push(...buildSectionHeader(sec.title));

    for (const file of list) {
      const st = statusMap.get(file) || "ON"; // internal ON/OFF
      out.push(`${statusToEmoji(st)}\t${file}`);
    }

    out.push("");
  }

  writeTextFileAtomic(fp, out.join("\n") + "\n");
}

function writeTXT({ fp, sections, sectioned, statusMap }) {
  const out = [];
  out.push(`# H2O dev order (source filenames) — TXT (sectioned) — GENERATED`);
  out.push(`# Master is ${path.basename(OUT_TSV)}`);
  out.push(`# ON  = normal line`);
  out.push(`# OFF = starts with "- " (dash + space)`);
  out.push("");

  for (const sec of sections) {
    const list = sectioned.get(sec.key) || [];
    if (!list.length) continue;

    out.push(...buildSectionHeader(sec.title));

    for (const file of list) {
      const st = statusMap.get(file) || "ON";
      const pref = st === "OFF" ? "- " : "";
      out.push(`${pref}${file}`);
    }

    out.push("");
  }

  writeTextFileAtomic(fp, out.join("\n") + "\n");
}

function writeJSON({ fp, sections, sectioned, statusMap }) {
  const obj = {
    version: 1,
    format: "h2o-dev-order",
    master: path.basename(OUT_TSV),
    notes: [
      "TSV is the master editable file.",
      "enabled=true means ON; enabled=false means OFF.",
      "file is the real source filename from src-runtime-base/, not the derived alias filename.",
      "TSV status is written as 🟢/🔴 but parsed into ON/OFF internally.",
    ],
    sections: [],
  };

  for (const sec of sections) {
    const list = sectioned.get(sec.key) || [];
    if (!list.length) continue;

    obj.sections.push({
      key: sec.key,
      title: sec.title,
      items: list.map((file) => ({
        file,
        enabled: (statusMap.get(file) || "ON") === "ON",
      })),
    });
  }

  writeTextFileAtomic(fp, JSON.stringify(obj, null, 2) + "\n");
}

function writeScriptsListTSV({ fp, names }) {
  const out = [];
  out.push("# H2O scripts list (raw filenames) — TSV — GENERATED");
  out.push(`# Source dir: ${path.relative(SRC_ROOT, SCRIPT_SRC_DIR) || "."}`);
  out.push("# Column: filename");
  out.push("");

  for (const name of names) out.push(name);

  writeTextFileAtomic(fp, out.join("\n") + "\n");
}

function normalizeNewlines(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sanitizeTSVValueLine(text) {
  return String(text || "").replace(/\t/g, "    ");
}

function readUserscriptHeaderBlock(fp) {
  const txt = fs.readFileSync(fp, "utf8");
  const match = txt.match(USERSCRIPT_HEADER_RE);
  return match ? normalizeNewlines(match[0]) : "";
}

function writeUserscriptHeadersTSV({ fp, names }) {
  const out = [];
  let missingCount = 0;

  out.push("# H2O userscript headers — TSV — GENERATED");
  out.push(`# Source dir: ${path.relative(SRC_ROOT, SCRIPT_SRC_DIR) || "."}`);
  out.push("# Layout per block:");
  out.push("#   <filename>");
  out.push("#");
  out.push("#   \t// ==H2O Module==");
  out.push("#   \t// ...");
  out.push("#   \t// ==/H2O Module==");
  out.push("");

  for (const name of names) {
    logDebug(`headers TSV: read ${name}`);
    const absPath = path.join(SCRIPT_SRC_DIR, name);
    const headerBlock = readUserscriptHeaderBlock(absPath);
    const headerLines = headerBlock ? headerBlock.split("\n") : [];

    if (!headerLines.length) {
      missingCount += 1;
      out.push(name);
      out.push("");
      out.push("\t<missing userscript header>");
      out.push("");
      continue;
    }

    out.push(name);
    out.push("");
    for (let i = 0; i < headerLines.length; i += 1) {
      out.push(`\t${sanitizeTSVValueLine(headerLines[i])}`);
    }
    out.push("");
  }

  writeTextFileAtomic(fp, out.join("\n") + "\n");
  return { missingCount };
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function lineClassForHeader(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return "line-blank";
  if (/^\/\/\s*==/.test(trimmed)) return "line-marker";
  const m = trimmed.match(/^\/\/\s+@([^\s]+)/);
  if (!m) return "line-other";
  const key = String(m[1] || "").toLowerCase();
  if (key === "h2o-id") return "line-id";
  if (key === "name") return "line-name";
  if (key === "namespace") return "line-namespace";
  if (key === "author") return "line-author";
  if (key === "version") return "line-version";
  if (key === "revision") return "line-revision";
  if (key === "build") return "line-build";
  if (key === "description") return "line-description";
  return "line-other";
}

function writeUserscriptHeadersHTML({ fp, names }) {
  const blocks = [];
  let missingCount = 0;

  for (const name of names) {
    logDebug(`headers HTML: read ${name}`);
    const absPath = path.join(SCRIPT_SRC_DIR, name);
    const headerBlock = readUserscriptHeaderBlock(absPath);
    const headerLines = headerBlock ? headerBlock.split("\n") : [];
    if (!headerLines.length) {
      missingCount += 1;
      blocks.push(`
        <section class="script-block">
          <h2>${escapeHtml(name)}</h2>
          <pre class="header-lines"><div class="line line-missing">&lt;missing userscript header&gt;</div></pre>
        </section>
      `);
      continue;
    }

    const rendered = headerLines
      .map((line) => `<div class="line ${lineClassForHeader(line)}">${escapeHtml(line)}</div>`)
      .join("\n");

    blocks.push(`
      <section class="script-block">
        <h2>${escapeHtml(name)}</h2>
        <pre class="header-lines">${rendered}</pre>
      </section>
    `);
  }

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>H2O Userscript Headers</title>
  <style>
    :root {
      --bg: #f7f7f2;
      --panel: #fffdf7;
      --text: #1f2937;
      --muted: #4b5563;
      --marker: #0f766e;
      --id: #1d4ed8;
      --name: #047857;
      --namespace: #b45309;
      --author: #be123c;
      --version: #0369a1;
      --revision: #7c2d12;
      --build: #334155;
      --description: #14532d;
      --other: #374151;
      --missing: #b91c1c;
      --border: #d6d3d1;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font-family: "Atkinson Hyperlegible", "Lexend", "Segoe UI", "Verdana", sans-serif;
      line-height: 1.65;
      letter-spacing: 0.01em;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 1.45rem;
    }
    .note {
      margin: 0 0 20px;
      color: var(--muted);
      font-size: 0.95rem;
    }
    .script-block {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 16px;
      margin: 0 0 14px;
    }
    .script-block h2 {
      margin: 0 0 8px;
      font-size: 1rem;
      font-weight: 700;
    }
    pre.header-lines {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.92rem;
      font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", "Consolas", monospace;
      background: transparent;
    }
    .line { color: var(--other); }
    .line-blank { color: transparent; }
    .line-marker { color: var(--marker); font-weight: 700; }
    .line-id { color: var(--id); }
    .line-name { color: var(--name); font-weight: 700; }
    .line-namespace { color: var(--namespace); }
    .line-author { color: var(--author); }
    .line-version { color: var(--version); }
    .line-revision { color: var(--revision); font-weight: 700; }
    .line-build { color: var(--build); }
    .line-description { color: var(--description); }
    .line-missing { color: var(--missing); font-weight: 700; }
  </style>
</head>
<body>
  <h1>H2O Userscript Headers</h1>
  <p class="note">Generated by sync-dev-order. Source: ${escapeHtml(path.relative(SRC_ROOT, SCRIPT_SRC_DIR) || ".")}</p>
  ${blocks.join("\n")}
</body>
</html>
`;

  writeTextFileAtomic(fp, html);
  return { missingCount };
}

function sortScriptName(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/* -----------------------------
   Main
------------------------------ */

logDebug(`start SRC_ROOT=${SRC_ROOT}`);
logDebug(`start ORDER_FILE=${ORDER_FILE}`);
logDebug(`start SCRIPT_SRC_DIR=${SCRIPT_SRC_DIR}`);

// 1) Scan source folder for real scripts
const foundSourceNames = new Set();
const rawScriptNames = new Set();
const aliasToSource = new Map();
for (const entry of fs.readdirSync(SCRIPT_SRC_DIR, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (entry.name === ".DS_Store") continue;
  if (!isSourceScriptName(entry.name)) continue;

  foundSourceNames.add(entry.name);
  rawScriptNames.add(entry.name);

  const alias = toAliasName(entry.name);
  if (alias && !aliasToSource.has(alias)) aliasToSource.set(alias, entry.name);
}
logDebug(`scan done: sourceFiles=${foundSourceNames.size} aliases=${aliasToSource.size}`);

/* -----------------------------
   BOUNDED DEV-ORDER COMMAND (owner: L-RUNTIME-KERNEL-SCOPE-EXT)
------------------------------
   Two semantic operations only. A command carries INTENT, never a filesystem
   path and never file contents: the canonical master is always this module's
   own ORDER_FILE. With no command the module behaves exactly as before.

   Flow: validate the whole command -> mutate only the intended TSV row or
   section header -> fall through to the established full synchronization
   below -> read the canonical TSV back and prove the change -> emit one
   bounded JSON result line. Any contradiction fails closed before mutation.
------------------------------ */
const DEV_ORDER_COMMAND_MARKER = "[H2O][dev-order-command]";
const DEV_ORDER_COMMAND_MAX_BYTES = 8192;
const DEV_ORDER_SECTION_TITLE_MAX = 64;
const DEV_ORDER_PROJECTIONS = [
  "dev-order.txt", "dev-order.json", "scripts-list.tsv",
  "userscript-headers.tsv", "userscript-headers.html",
];

function devOrderEmit(payload) {
  process.stdout.write(DEV_ORDER_COMMAND_MARKER + " " + JSON.stringify(payload) + "\n");
}

function devOrderFail(operation, code, message) {
  devOrderEmit({ ok: false, operation: operation || "unknown", changed: false, code, error: String(message || code) });
  process.exit(2);
}

function readDevOrderCommand() {
  if (!process.argv.includes("--command-stdin")) return null;
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    devOrderFail("unknown", "command/unreadable", "command envelope could not be read from stdin");
  }
  if (Buffer.byteLength(raw, "utf8") > DEV_ORDER_COMMAND_MAX_BYTES) {
    devOrderFail("unknown", "command/too-large", "command envelope exceeds " + DEV_ORDER_COMMAND_MAX_BYTES + " bytes");
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    devOrderFail("unknown", "command/malformed", "command envelope is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    devOrderFail("unknown", "command/malformed", "command envelope must be a JSON object");
  }
  const operation = typeof parsed.operation === "string" ? parsed.operation.trim() : "";
  if (operation !== "set-enabled" && operation !== "set-section-title") {
    devOrderFail(operation || "unknown", "command/unsupported-operation", "unsupported operation");
  }
  return { operation, command: parsed };
}

function devOrderTsvRowFile(line) {
  const parts = String(line).split("\t");
  if (parts.length < 2) return "";
  return parts.slice(1).join("\t").replace(/\s+#.*$/, "").trim();
}

function devOrderIsReservedTitle(title) {
  const t = String(title || "").trim();
  return /^=+$/.test(t) || /^h2o dev order/i.test(t) || /^master:/i.test(t) || /^status<tab>filename/i.test(t);
}

// A dev-order identity is a bare source filename as it already appears in the
// master. Anything path-like is refused outright rather than normalized.
function devOrderRequireBareFilename(operation, value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) devOrderFail(operation, "command/invalid-source", "sourceFile is required");
  if (name !== path.basename(name) || /[\\/]/.test(name) || name.includes("..") || /[\u0000-\u001f]/.test(name)) {
    devOrderFail(operation, "command/path-like-identifier", "sourceFile must be a bare dev-order filename");
  }
  return name;
}

function devOrderApplySetEnabled(command) {
  const operation = "set-enabled";
  const sourceFile = devOrderRequireBareFilename(operation, command.sourceFile);
  if (typeof command.enabled !== "boolean") {
    devOrderFail(operation, "command/invalid-enabled", "enabled must be a JSON boolean");
  }
  if (!fs.existsSync(OUT_TSV)) devOrderFail(operation, "command/master-missing", "canonical dev-order master is missing");

  // Identity resolution stays Runtime-side. The caller may name the row by its
  // exact source filename or by the alias this module itself derives; alias
  // matching is only consulted when no exact filename matched, and either way
  // the identifier must land on exactly one row.
  const lines = fs.readFileSync(OUT_TSV, "utf8").split(/\r?\n/);
  const exact = [];
  const byAlias = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = String(lines[i]).trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const rowFile = devOrderTsvRowFile(lines[i]);
    if (!rowFile) continue;
    if (rowFile === sourceFile) exact.push(i);
    else if (toAliasName(rowFile) === sourceFile) byAlias.push(i);
  }
  const matches = exact.length ? exact : byAlias;
  if (matches.length === 0) devOrderFail(operation, "command/row-not-found", "no dev-order row matches that source file");
  if (matches.length > 1) devOrderFail(operation, "command/row-ambiguous", "source file matches " + matches.length + " dev-order rows");

  const index = matches[0];
  const resolvedFile = devOrderTsvRowFile(lines[index]);
  const parts = String(lines[index]).split("\t");
  const wanted = command.enabled ? "ON" : "OFF";
  const nextLine = statusToEmoji(wanted) + "\t" + parts.slice(1).join("\t");
  const changed = lines[index] !== nextLine;
  if (changed) {
    lines[index] = nextLine;
    writeTextFileAtomic(OUT_TSV, lines.join("\n"));
  }
  return { operation, changed, canonicalId: resolvedFile, wanted };
}

function devOrderApplySetSectionTitle(command) {
  const operation = "set-section-title";
  const sectionKey = typeof command.sectionKey === "string" ? command.sectionKey.trim() : "";
  if (!sectionKey || !/^[A-Za-z0-9_]{1,48}$/.test(sectionKey)) {
    devOrderFail(operation, "command/invalid-section", "sectionKey must be an existing dev-order section identifier");
  }
  const rawTitle = typeof command.title === "string" ? command.title : "";
  // Control characters are refused outright rather than stripped: silently
  // storing a different title than the caller asked for is not a safe success.
  if (/[\u0000-\u001f\u007f]/.test(rawTitle)) {
    devOrderFail(operation, "command/invalid-title", "title must not contain control characters");
  }
  const title = rawTitle.replace(/\s+/g, " ").trim();
  if (!title) devOrderFail(operation, "command/invalid-title", "title is required");
  if (title.length > DEV_ORDER_SECTION_TITLE_MAX) {
    devOrderFail(operation, "command/invalid-title", "title exceeds " + DEV_ORDER_SECTION_TITLE_MAX + " characters");
  }
  if (title.startsWith("#") || title.includes("\t") || devOrderIsReservedTitle(title)) {
    devOrderFail(operation, "command/invalid-title", "title is not a usable dev-order section title");
  }
  if (!fs.existsSync(OUT_TSV)) devOrderFail(operation, "command/master-missing", "canonical dev-order master is missing");

  const lines = fs.readFileSync(OUT_TSV, "utf8").split(/\r?\n/);
  let titleLineIndex = -1;
  let sawFirstRow = false;
  let targetTitleLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = String(lines[i]).trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) {
      const headerTitle = trimmed.replace(/^#\s*/, "").trim();
      if (!headerTitle || devOrderIsReservedTitle(headerTitle)) continue;
      titleLineIndex = i;
      sawFirstRow = false;
      continue;
    }
    if (sawFirstRow) continue;
    sawFirstRow = true;
    const file = devOrderTsvRowFile(lines[i]);
    if (!file || groupOf(file) !== sectionKey) continue;
    targetTitleLine = titleLineIndex;
    break;
  }
  if (targetTitleLine < 0) devOrderFail(operation, "command/section-not-found", "no existing dev-order section matches that identifier");

  const nextLine = "# " + title;
  const changed = lines[targetTitleLine] !== nextLine;
  if (changed) {
    lines[targetTitleLine] = nextLine;
    writeTextFileAtomic(OUT_TSV, lines.join("\n"));
  }
  return { operation, changed, canonicalId: sectionKey, wanted: title };
}

const DEV_ORDER_COMMAND = readDevOrderCommand();
let DEV_ORDER_COMMAND_APPLIED = null;
if (DEV_ORDER_COMMAND) {
  DEV_ORDER_COMMAND_APPLIED = DEV_ORDER_COMMAND.operation === "set-enabled"
    ? devOrderApplySetEnabled(DEV_ORDER_COMMAND.command)
    : devOrderApplySetSectionTitle(DEV_ORDER_COMMAND.command);
}

// 2) Read prior statuses + section order from existing TSV (master)
const priorState = readExistingTSV(OUT_TSV, foundSourceNames, aliasToSource);
const priorStatus = priorState.statusMap;
const priorSectionOrder = priorState.sectionOrderMap;
const sectionDefs = resolveSections(priorState.sectionTitleMap);
logDebug(`readExistingTSV done: statuses=${priorStatus.size}`);

// 3) Build statusMap for current source filenames, preserving previous where possible
const statusMap = new Map();
for (const file of foundSourceNames) {
  const groupKey = groupOf(file);
  const prev = priorStatus.get(file);
  statusMap.set(file, prev || defaultStatusForGroup(groupKey));
}

// 4) Section + order
const sectioned = new Map();
for (const sec of sectionDefs) sectioned.set(sec.key, []);

const sorted = Array.from(foundSourceNames).sort((a, b) =>
  sortKey(a).localeCompare(sortKey(b))
);

const sortedRawNames = Array.from(rawScriptNames).sort(sortScriptName);
logDebug(`sort done: sortedAliases=${sorted.length} sortedRaw=${sortedRawNames.length}`);

for (const sec of sectionDefs) {
  const secKey = sec.key;
  const priorList = (priorSectionOrder.get(secKey) || []).filter(
    (file) => foundSourceNames.has(file) && groupOf(file) === secKey
  );
  const seen = new Set(priorList);
  const appendedNew = sorted.filter(
    (file) => groupOf(file) === secKey && !seen.has(file)
  );
  sectioned.set(secKey, [...priorList, ...appendedNew]);
}

for (const file of sorted) {
  const g = groupOf(file);
  if (!sectioned.has(g)) sectioned.set(g, []);
  const list = sectioned.get(g);
  if (!list.includes(file)) list.push(file);
}

// 5) Write master TSV + generated views
logDebug("write phase: dev-order.tsv");
writeTSV({ fp: OUT_TSV, sections: sectionDefs, sectioned, statusMap });
logDebug("write phase: dev-order.txt");
writeTXT({ fp: OUT_TXT, sections: sectionDefs, sectioned, statusMap });
logDebug("write phase: dev-order.json");
writeJSON({ fp: OUT_JSON, sections: sectionDefs, sectioned, statusMap });
logDebug("write phase: scripts-list.tsv");
writeScriptsListTSV({ fp: OUT_SCRIPTS_LIST_TSV, names: sortedRawNames });
logDebug("write phase: userscript-headers.tsv");
const headerTSV = writeUserscriptHeadersTSV({
  fp: OUT_USERSCRIPT_HEADERS_TSV,
  names: sortedRawNames,
});
logDebug("write phase: userscript-headers.html");
const headerHTML = writeUserscriptHeadersHTML({
  fp: OUT_USERSCRIPT_HEADERS_HTML,
  names: sortedRawNames,
});
logDebug("all writes done");

console.log("[H2O] sync-dev-order done");
console.log("[H2O] SRC:", SRC_ROOT);
console.log("[H2O] scripts dir:", SCRIPT_SRC_DIR);
console.log("[H2O] wrote TSV:", OUT_TSV);
console.log("[H2O] wrote TXT:", OUT_TXT);
console.log("[H2O] wrote JSON:", OUT_JSON);
console.log("[H2O] wrote scripts list TSV:", OUT_SCRIPTS_LIST_TSV);
console.log("[H2O] wrote userscript headers TSV:", OUT_USERSCRIPT_HEADERS_TSV);
console.log("[H2O] wrote userscript headers HTML:", OUT_USERSCRIPT_HEADERS_HTML);
if (headerTSV.missingCount > 0) {
  console.warn(`[H2O] WARNING: missing UserScript header in ${headerTSV.missingCount} file(s).`);
}
if (headerHTML.missingCount > 0) {
  console.warn(`[H2O] WARNING: missing UserScript header in ${headerHTML.missingCount} file(s).`);
}
console.log("[H2O] entries:", sorted.length);
logDebug("complete");

// Canonical readback: success is only reported once the regenerated master
// actually proves the requested change. A contradiction here fails closed.
if (DEV_ORDER_COMMAND_APPLIED) {
  const applied = DEV_ORDER_COMMAND_APPLIED;
  const finalLines = fs.readFileSync(OUT_TSV, "utf8").split(/\r?\n/);
  let proven = false;
  if (applied.operation === "set-enabled") {
    for (const line of finalLines) {
      const trimmed = String(line).trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (devOrderTsvRowFile(line) !== applied.canonicalId) continue;
      proven = parseStatusToken(String(line).split("\t")[0]) === applied.wanted;
      break;
    }
  } else {
    let headerTitle = "";
    let sawFirstRow = false;
    for (const line of finalLines) {
      const trimmed = String(line).trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("#")) {
        const candidate = trimmed.replace(/^#\s*/, "").trim();
        if (!candidate || devOrderIsReservedTitle(candidate)) continue;
        headerTitle = candidate;
        sawFirstRow = false;
        continue;
      }
      if (sawFirstRow) continue;
      sawFirstRow = true;
      const file = devOrderTsvRowFile(line);
      if (!file || groupOf(file) !== applied.canonicalId) continue;
      proven = headerTitle === applied.wanted;
      break;
    }
  }
  if (!proven) {
    devOrderEmit({
      ok: false, operation: applied.operation, changed: applied.changed,
      code: "command/readback-contradiction",
      error: "canonical dev-order readback did not prove the requested change",
    });
    process.exit(3);
  }
  devOrderEmit({
    ok: true,
    operation: applied.operation,
    changed: applied.changed,
    canonicalId: applied.canonicalId,
    regenerated: DEV_ORDER_PROJECTIONS,
    needsRebuild: applied.operation === "set-enabled",
  });
}
