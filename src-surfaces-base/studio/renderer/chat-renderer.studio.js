// @version 1.0.0
"use strict";

/*
 * Canonical base Studio Chat Renderer.
 *
 * Consumes a surface-neutral logical snapshot, constructs the compatible
 * replay transcript DOM, and returns DOM references to Reader orchestration.
 * Host lifecycle, route state, overlays, and persistence stay outside.
 */
(function installStudioChatRenderer(W){
  const H2O = W.H2O = W.H2O || {};
  const Studio = H2O.Studio = H2O.Studio || {};
  const selectors = Studio.SELECTORS || {};
  const ATTR = selectors.ATTR || {};
  const ROLES = selectors.ROLES || {};
  const TESTIDS = selectors.TESTIDS || {};
  const SEL = selectors.sel || {};
  const BY = selectors.by || {};
  const ROLE_ATTR = ATTR.ROLE || "data-message-author-role";
  const MESSAGE_ID_ATTR = ATTR.MESSAGE_ID || "data-message-id";
  const TURN_ID_ATTR = ATTR.TURN_ID || "data-turn-id";
  const TESTID_ATTR = ATTR.TESTID || "data-testid";
  const TURN_TESTID = TESTIDS.CONVERSATION_TURN || "conversation-turn";
  const TURNS_TESTID = TESTIDS.CONVERSATION_TURNS || "conversation-turns";
  const NORMALIZED_INPUT = Symbol("h2o.studio.chatRenderer.input");

  function esc(s){
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[c]));
  }

  function normalizeText(s){
    return String(s || "").replace(/\s+/g, " ").trim();
  }

function resolveSnapshotTurnCreateTime(snap, turn, idx0){
  const meta = snap?.metadata && typeof snap.metadata === "object"
    ? snap.metadata
    : (snap?.meta && typeof snap.meta === "object" ? snap.meta : {});
  const i1 = idx0 + 1;

  const directCandidates = [
    turn?.createTime,
    turn?.create_time,
    turn?.ts,
    turn?.timestamp,
    turn?.messageCreateTime,
    turn?.message_create_time
  ];

  for (const v of directCandidates){
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const maps = [
    meta.turnTimestamps,
    meta.turnCreateTimes,
    meta.messageTimestamps,
    meta.messageCreateTimes,
    meta.timestamps
  ];

  for (const map of maps){
    if (!map || typeof map !== "object") continue;
    const candidates = [
      map[String(turn?.turnIdx || i1)],
      map[i1],
      map[idx0]
    ];
    for (const v of candidates){
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }

  return 0;
}

function stampReplayTurnMeta(host, frame, createTime, turnNo){
  const ct = Number(createTime || 0);
  const tn = Number(turnNo || 0);

  if (tn > 0){
    try { host?.setAttribute("data-h2o-turn-no", String(tn)); } catch {}
    try { frame?.setAttribute("data-h2o-turn-no", String(tn)); } catch {}
  }

  if (ct > 0){
    try { host?.setAttribute("data-h2o-create-time", String(ct)); } catch {}
    try { frame?.setAttribute("data-h2o-create-time", String(ct)); } catch {}
  }
}

function cleanReaderUserText(raw){
  return String(raw || "")
    .replace(/\u00a0/g, " ")
    .replace(/\u200b/g, "")
    .replace(/\r/g, "")
    .replace(/(?:\s*(?:Show\s+more|Show\s+less)\s*)+$/gi, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:Show\s+more|Show\s+less)\s*$/i, ""))
    .join("\n")
    .trim();
}

function cleanReaderUserTextNodeLeaks(root){
  if (!(root instanceof Element)) return;
  const userRoleSelector = SEL.userTurn || (
    typeof BY.role === "function" ? BY.role(ROLES.USER || "user") : `[${ROLE_ATTR}="user"]`
  );
  const messageSelector = `${userRoleSelector}, .user-message-bubble-color, .cgMsg--user`;
  const turnSelector = '.cgTurn--user, .wbTurn--user, [data-turn="user"]';
  const messageHosts = [];
  if (root.matches?.(messageSelector)) messageHosts.push(root);
  messageHosts.push(...root.querySelectorAll?.(messageSelector) || []);

  const turnHosts = [];
  if (root.matches?.(turnSelector)) turnHosts.push(root);
  turnHosts.push(...root.querySelectorAll?.(turnSelector) || []);

  const hosts = messageHosts.length ? messageHosts : turnHosts;
  for (const host of hosts){
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes){
      const before = String(node.nodeValue || "");
      const after = cleanReaderUserText(before);
      if (after !== before.trim()) node.nodeValue = after ? after : "";
    }
  }
}

function normalizeRole(raw, fallbackRaw){
  const value = String(raw || "").trim().toLowerCase();
  const canonicalRoles = [
    ROLES.USER || "user",
    ROLES.ASSISTANT || "assistant",
    ROLES.SYSTEM || "system",
    ROLES.TOOL || "tool",
  ];
  if (canonicalRoles.includes(value)) return value;
  // Renderer input is presentation-time projection: unknown saved roles must
  // not acquire assistant semantics unless a caller supplies a canonical
  // context-specific fallback explicitly.
  const fallback = String(fallbackRaw || "").trim().toLowerCase();
  return canonicalRoles.includes(fallback) ? fallback : "";
}
function normalizeSafeMarkdownHref(rawHref){
  const href = String(rawHref || "").trim();
  if (!href || /[\u0000-\u001F\u007F\s]/.test(href)) return "";

  try {
    const parsed = new URL(href);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") return href;
  } catch {}

  return "";
}

function normalizeSafeImageSrc(rawSrc, allowCapturedData){
  const src = String(rawSrc || "").trim();
  if (!src || /[\u0000-\u001F\u007F\s]/.test(src)) return "";

  if (allowCapturedData === true && /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(src)){
    return src;
  }

  try {
    const parsed = new URL(src);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === "http:" || protocol === "https:") return src;
  } catch {}

  return "";
}

function normalizeImageAlt(rawAlt){
  return rawAlt == null ? "" : String(rawAlt);
}

function getAccessibleRoleLabel(roleRaw){
  const role = normalizeRole(roleRaw);
  if (role === (ROLES.USER || "user")) return "User message";
  if (role === (ROLES.ASSISTANT || "assistant")) return "Assistant message";
  if (role === (ROLES.SYSTEM || "system")) return "System message";
  if (role === (ROLES.TOOL || "tool")) return "Tool message";
  return "";
}

function applyTurnAccessibility(turnEl, roleRaw){
  if (!(turnEl instanceof Element)) return;
  const label = getAccessibleRoleLabel(roleRaw);
  if (!label) return;

  // A transcript turn is a self-contained authored item. Canonical turns use
  // native <article>; rich replay hosts may use other elements, so normalize
  // only that outer host to the equivalent article semantic.
  if (String(turnEl.tagName || "").toUpperCase() === "ARTICLE"){
    try { turnEl.removeAttribute("role"); } catch {}
  } else {
    try { turnEl.setAttribute("role", "article"); } catch {}
  }
  // Captured labels may reference host-page nodes that replay cleanup removed.
  try { turnEl.removeAttribute("aria-labelledby"); } catch {}
  try { turnEl.setAttribute("aria-label", label); } catch {}
}

// Inline markdown → HTML. Handles links, bold, italic, inline code, plain text.
// All plain-text segments are HTML-escaped via esc(). Handles orphaned markers
// gracefully — an unmatched ` or * is consumed as literal text.
function renderInlineMarkdown(text){
  let s = String(text || "");
  let out = "";
  while (s.length > 0){
    // Inline code: `code`
    if (s[0] === "`"){
      const end = s.indexOf("`", 1);
      if (end > 0){
        out += `<code>${esc(s.slice(1, end))}</code>`;
        s = s.slice(end + 1);
        continue;
      }
    }
    // Image: ![alt](https://example.com/x.png). Must be dispatched BEFORE the
    // link branch so the leading "!" doesn't get consumed as plain text.
    // Unsafe / malformed URLs fall back to consuming a literal "!" and
    // re-entering the loop; the link branch then handles the remaining
    // "[alt](url)" (escaping or linking as appropriate). Phase 2A: pre-2026-05
    // the renderer silently skipped past `![` so markdown images were dropped.
    if (s[0] === "!" && s[1] === "["){
      const labelEnd = s.indexOf("]", 2);
      if (labelEnd > 1 && s[labelEnd + 1] === "("){
        const hrefEnd = s.indexOf(")", labelEnd + 2);
        if (hrefEnd > labelEnd + 2){
          const alt = normalizeImageAlt(s.slice(2, labelEnd));
          const rawHref = s.slice(labelEnd + 2, hrefEnd);
          const href = normalizeSafeImageSrc(rawHref, false);
          if (href){
            out += `<img src="${esc(href)}" alt="${esc(alt)}" loading="lazy" decoding="async">`;
            s = s.slice(hrefEnd + 1);
            continue;
          }
        }
      }
      // Malformed or unsafe URL: emit literal "!" and let the link branch
      // (next iteration) handle the remaining "[alt](url)" as a normal link
      // if the URL parses, or escape it as literal text if not.
      out += esc("!");
      s = s.slice(1);
      continue;
    }
    // Link: [label](https://example.com). Unsafe hrefs stay literal text.
    if (s[0] === "["){
      const labelEnd = s.indexOf("]");
      if (labelEnd > 0 && s[labelEnd + 1] === "("){
        const hrefEnd = s.indexOf(")", labelEnd + 2);
        if (hrefEnd > labelEnd + 2){
          const label = s.slice(1, labelEnd);
          const rawHref = s.slice(labelEnd + 2, hrefEnd);
          const href = normalizeSafeMarkdownHref(rawHref);
          if (href && label.trim()){
            out += `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${renderInlineMarkdown(label)}</a>`;
            s = s.slice(hrefEnd + 1);
            continue;
          }
        }
      }
      out += esc("[");
      s = s.slice(1);
      continue;
    }
    // Bold: **text** — check before single * to avoid false matches
    if (s.startsWith("**")){
      const end = s.indexOf("**", 2);
      if (end > 2){
        out += `<strong>${renderInlineMarkdown(s.slice(2, end))}</strong>`;
        s = s.slice(end + 2);
        continue;
      }
    }
    // Italic: *text* (single asterisk, not a double)
    if (s[0] === "*" && s[1] !== "*"){
      const end = s.indexOf("*", 1);
      if (end > 1){
        out += `<em>${renderInlineMarkdown(s.slice(1, end))}</em>`;
        s = s.slice(end + 1);
        continue;
      }
    }
    // Italic: _text_ (underscore style)
    if (s[0] === "_" && s[1] !== "_"){
      const end = s.indexOf("_", 1);
      if (end > 1){
        out += `<em>${renderInlineMarkdown(s.slice(1, end))}</em>`;
        s = s.slice(end + 1);
        continue;
      }
    }
    // Plain text — consume up to the next potential marker character. If the
    // next marker is `[` preceded by `!`, stop one character BEFORE the `!`
    // so the image branch (which dispatches on `s[0] === "!" && s[1] === "["`)
    // gets a chance next iteration. Phase 2A: pre-2026-05 the scanner did the
    // opposite — it advanced PAST `![` to suppress image parsing entirely,
    // which silently dropped every markdown image in canonical saved chats.
    const nextMarker = s.search(/[`*_\[]/);
    if (nextMarker > 0){
      const isImageStart = s[nextMarker] === "[" && s[nextMarker - 1] === "!";
      const end = isImageStart ? nextMarker - 1 : nextMarker;
      out += esc(s.slice(0, end));
      s = s.slice(end);
    } else {
      out += esc(s); // no more markers, consume the rest
      break;
    }
  }
  return out;
}

function countMarkdownIndent(line){
  let count = 0;
  for (const ch of String(line || "")){
    if (ch === " ") count += 1;
    else if (ch === "\t") count += 4;
    else break;
  }
  return count;
}

function parseMarkdownListLine(line){
  const match = String(line || "").match(/^([ \t]*)([-*+]|\d+\.)[ \t]+(.+)$/);
  if (!match) return null;
  return {
    indent: countMarkdownIndent(match[1]),
    type: /^\d+\.$/.test(match[2]) ? "ol" : "ul",
    text: match[3],
  };
}

function renderMarkdownList(lines, start, baseIndent, listType){
  const tag = listType === "ol" ? "ol" : "ul";
  const items = [];
  let i = start;

  while (i < lines.length){
    const row = parseMarkdownListLine(lines[i]);
    if (!row || row.indent !== baseIndent || row.type !== listType) break;

    const parts = [renderInlineMarkdown(row.text)];
    i++;

    while (i < lines.length){
      if (String(lines[i] || "").trim() === "") break;

      const child = parseMarkdownListLine(lines[i]);
      if (!child || child.indent <= baseIndent) break;

      const nested = renderMarkdownList(lines, i, child.indent, child.type);
      parts.push(nested.html);
      i = nested.next;
    }

    items.push(`<li>${parts.join("")}</li>`);
  }

  return { html: `<${tag}>${items.join("")}</${tag}>`, next: i };
}

function splitMarkdownTableRow(line){
  let src = String(line || "").trim();
  if (!src.includes("|")) return [];
  if (src.startsWith("|")) src = src.slice(1);
  if (src.endsWith("|")) src = src.slice(0, -1);

  const cells = [];
  let cell = "";
  for (let i = 0; i < src.length; i += 1){
    const ch = src[i];
    if (ch === "\\" && src[i + 1] === "|"){
      cell += "|";
      i++;
      continue;
    }
    if (ch === "|"){
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function parseMarkdownTableAlign(cell){
  const marker = String(cell || "").replace(/\s+/g, "");
  if (!/^:?-{3,}:?$/.test(marker)) return null;
  if (marker.startsWith(":") && marker.endsWith(":")) return "center";
  if (marker.endsWith(":")) return "right";
  if (marker.startsWith(":")) return "left";
  return "";
}

function parseMarkdownTableStart(lines, start){
  if (start + 1 >= lines.length) return null;
  const header = splitMarkdownTableRow(lines[start]);
  const delimiter = splitMarkdownTableRow(lines[start + 1]);
  if (header.length < 2 || delimiter.length !== header.length) return null;

  const aligns = delimiter.map(parseMarkdownTableAlign);
  if (aligns.some((align) => align === null)) return null;
  return { header, aligns };
}

function renderMarkdownTable(lines, start){
  const parsed = parseMarkdownTableStart(lines, start);
  if (!parsed) return null;

  const { header, aligns } = parsed;
  const columnCount = header.length;
  let i = start + 2;
  const bodyRows = [];

  while (i < lines.length){
    if (String(lines[i] || "").trim() === "") break;
    const cells = splitMarkdownTableRow(lines[i]);
    if (cells.length < 2) break;
    bodyRows.push(cells.slice(0, columnCount));
    i++;
  }

  const alignAttr = (idx) => aligns[idx] ? ` style="text-align:${aligns[idx]}"` : "";
  const renderCell = (tag, value, idx) => (
    `<${tag}${tag === "th" ? ' scope="col"' : ""}${alignAttr(idx)}>${renderInlineMarkdown(value || "")}</${tag}>`
  );
  const head = `<thead><tr>${header.map((cell, idx) => renderCell("th", cell, idx)).join("")}</tr></thead>`;
  const body = `<tbody>${bodyRows.map((row) => {
    const cells = Array.from({ length: columnCount }, (_, idx) => row[idx] || "");
    return `<tr>${cells.map((cell, idx) => renderCell("td", cell, idx)).join("")}</tr>`;
  }).join("")}</tbody>`;

  return { html: `<table>${head}${body}</table>`, next: i };
}

// Full markdown → HTML for archive message text.
// Handles: fenced code blocks, headings (h1–h3), horizontal rules, blockquotes,
// tables, nested unordered/ordered lists, paragraphs, and inline formatting.
// Stays close to the Mobile Studio renderer while adding Browser quote support.
function renderTextAsChatGPTBlocks(text){
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length){
    const line = lines[i];

    // Fenced code block (``` or ~~~)
    const fenceMatch = line.match(/^(`{3,}|~{3,})(.*)/);
    if (fenceMatch){
      const fence = fenceMatch[1];
      const lang = fenceMatch[2].trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)){
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      const langBadge = lang ? `<div class="wbCodeLang">${esc(lang)}</div>` : "";
      out.push(`<div class="wbCodeBlock">${langBadge}<pre><code>${esc(codeLines.join("\n"))}</code></pre></div>`);
      continue;
    }

    // ATX heading (# ## ###)
    const headingMatch = line.match(/^(#{1,3})[ \t]+(.+?)[ \t]*$/);
    if (headingMatch){
      const level = Math.min(headingMatch[1].length, 3);
      out.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule (--- *** ___ as standalone line)
    if (/^[-*_]{3,}\s*$/.test(line.trim())){
      out.push(`<hr>`);
      i++;
      continue;
    }

    const table = renderMarkdownTable(lines, i);
    if (table){
      out.push(table.html);
      i = table.next;
      continue;
    }

    // Blockquote (> quote). Reuse this renderer for quoted markdown content.
    if (/^[ \t]{0,3}>[ \t]?/.test(line)){
      const quoteLines = [];
      while (i < lines.length && /^[ \t]{0,3}>[ \t]?/.test(lines[i])){
        quoteLines.push(lines[i].replace(/^[ \t]{0,3}>[ \t]?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderTextAsChatGPTBlocks(quoteLines.join("\n"))}</blockquote>`);
      continue;
    }

    const listRow = parseMarkdownListLine(line);
    if (listRow){
      const list = renderMarkdownList(lines, i, listRow.indent, listRow.type);
      out.push(list.html);
      i = list.next;
      continue;
    }

    // Blank line
    if (line.trim() === ""){
      i++;
      continue;
    }

    // Paragraph — collect lines until a blank line or a block-level element starts
    const paraLines = [];
    while (i < lines.length){
      const l = lines[i];
      if (l.trim() === "") break;
      if (/^(`{3,}|~{3,})/.test(l)) break;
      if (/^#{1,3}[ \t]/.test(l)) break;
      if (/^[-*_]{3,}\s*$/.test(l.trim())) break;
      if (parseMarkdownTableStart(lines, i)) break;
      if (/^[ \t]{0,3}>[ \t]?/.test(l)) break;
      if (parseMarkdownListLine(l)) break;
      paraLines.push(l);
      i++;
    }
    if (paraLines.length > 0){
      out.push(`<p>${renderInlineMarkdown(paraLines.join(" "))}</p>`);
    }
  }

  return out.join("") || `<p></p>`;
}

function isConversationTurnNode(node){
  if (!(node instanceof Element)) return false;
  const testid = String(node.getAttribute(TESTID_ATTR) || "").trim();
  return testid === TURN_TESTID || testid.startsWith(`${TURN_TESTID}-`);
}

function findConversationTurnElement(root){
  if (!root) return null;
  const direct = [...(root.children || [])].find((node) => isConversationTurnNode(node));
  if (direct) return direct;
  const looseTurnSelector = SEL.conversationTurnLoose ||
    `[${TESTID_ATTR}="${TURN_TESTID}"], [${TESTID_ATTR}^="${TURN_TESTID}-"]`;
  return root.querySelector?.(looseTurnSelector) || null;
}

function findRoleHostInTurn(turnEl, preferredRole = ""){
  if (!(turnEl instanceof Element)) return null;
  const preferred = normalizeRole(preferredRole || "");
  if (preferred){
    const exactSelector = typeof BY.role === "function"
      ? BY.role(preferred)
      : `[${ROLE_ATTR}="${preferred}"]`;
    const exact = turnEl.querySelector?.(exactSelector) || null;
    if (exact) return exact;
  }
  return turnEl.querySelector?.(`[${ROLE_ATTR}]`) || null;
}

const STALE_REPLAY_SUBTREE_SELECTORS = [
  ".h2o-cold-layer",
  '[data-h2o-cold-layer="1"]',
  '[data-cgxui="mnmp-root"][data-cgxui-owner="mnmp"]',
  '[data-cgxui="mnmp-panel"][data-cgxui-owner="mnmp"]',
  '[data-cgxui="mnmp-minimap"][data-cgxui-owner="mnmp"]',
  '[data-cgxui="mnmp-col"][data-cgxui-owner="mnmp"]',
  '[data-cgxui="mm-root"][data-cgxui-owner="mnmp"]',
  '[data-cgxui="mm-minimap"][data-cgxui-owner="mnmp"]',
  ".cgxui-mm-root",
  ".cgxui-mm-minimap",
  ".cgxui-mm-col",
  ".cgxui-mm-wrap",
  ".cgxui-mm-btn",
  ".cgxui-mm-qbtn",
  ".cgxui-mm-dotrow",
  ".cgxui-mm-count",
  ".cgxui-mm-toggle",
  ".cgxui-mm-aux",
  ".cgxui-mm-counter",
  ".cgxui-mnmp-root",
  ".cgxui-mnmp-minimap",
  ".cgxui-mnmp-col",
  ".cgxui-mnmp-wrap",
  ".cgxui-mnmp-btn",
  ".cgxui-mnmp-qbtn",
  ".cgxui-mnmp-dotrow",
  ".cgxui-mnmp-count",
  ".cgxui-mnmp-toggle",
  ".cgxui-mnmp-aux",
  ".cgxui-mnmp-counter",
  '[data-cgxui="atns-answer-title"][data-cgxui-owner="atns"]',
  ".cgxui-atns-answer-title",
  ".cgxui-atns-answer-title-text",
  ".cgxui-atns-answer-title-label",
  ".cgxui-atns-answer-title-badge",
  ".cgxui-atns-answer-title-icon",
  '[data-cgxui-qts-bar][data-cgxui-owner="qts"]',
  '[data-cgxui-qts-inline][data-cgxui-owner="qts"]',
  '[data-cgxui-ats-bar][data-cgxui-owner="ats"]',
  '[data-cgxui-ats-inline][data-cgxui-owner="ats"]',
  '[data-cgxui="qbig-num"][data-cgxui-owner="qbig"]',
  '[data-cgxui="ansn-abig"][data-cgxui-owner="ansn"]',
  '[data-cgxui="mrnc-marks"][data-cgxui-owner="mrnc"]',
  '[data-cgxui="mrnc-gutter"][data-cgxui-owner="mrnc"]',
  '[data-cgxui="mrnc-gutlane"][data-cgxui-owner="mrnc"]',
  ".cgxui-qts-ts",
  ".cgxui-ats-ts",
  ".chatgpt-timestamp",
  ".cgxui-qbig-number",
  ".cgxui-ansn-big-number",
  ".cgxui-qswr-quoteBox",
  ".cgxui-qswr-toggle",
  ".cgxui-qswr-toggle-top",
  ".cgxui-qswr-toggle-row",
  '[aria-label="Response actions"][role="group"]',
  '[aria-label="Your message actions"][role="group"]'
];

const REPLAY_UNWRAP_SELECTORS = [
  ".cgxui-qswr",
  '[data-cgxui="scbn-band"][data-cgxui-owner="scbn"]'
];

function unwrapReplayNode(node){
  if (!(node instanceof Element)) return;
  const parent = node.parentNode;
  if (!parent) return;
  while (node.firstChild){
    parent.insertBefore(node.firstChild, node);
  }
  node.remove();
}

function normalizeReplayImageAccessibility(el){
  if (!(el instanceof Element) || el.tagName !== "IMG") return true;
  const src = String(el.getAttribute("src") || "").trim();
  if (src === "#"){
    try { el.remove(); } catch {}
    return false;
  }
  if (!el.hasAttribute("alt")){
    try { el.setAttribute("alt", ""); } catch {}
  }
  return true;
}

function normalizeReplayLinkAccessibility(el){
  if (!(el instanceof Element) || el.tagName !== "A") return;
  try {
    const href = el.getAttribute("href") || "";
    if (href.trim() === "#"){
      el.removeAttribute("href");
      el.removeAttribute("target");
      el.removeAttribute("rel");
    } else if (/^https?:\/\//i.test(href)){
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noreferrer noopener");
    }
  } catch {}
}

/*
 * Stage 0 — inert compatibility normalization (M03 P1 S1A T1).
 *
 * ZERO security authority. It runs before the Renderer sanitizer purely to
 * remove historical H2O/provider replay residue whose selectors still need to
 * read raw provider attributes that sanitizer v2 legitimately removes. Parsing
 * happens in a <template>, whose content lives in an inert document: no script
 * runs and no resource loads. Every dangerous-content decision — script, style,
 * frames, event handlers, URI schemes, SVG/MathML, identity spoofing — belongs
 * to sanitizer v2 and is deliberately NOT duplicated here.
 */
function stage0CompatCleanup(turnEl){
  if (!(turnEl instanceof Element)) return;
  const userRoleSelector = SEL.userTurn || (
    typeof BY.role === "function" ? BY.role(ROLES.USER || "user") : `[${ROLE_ATTR}="user"]`
  );

  turnEl.querySelectorAll(STALE_REPLAY_SUBTREE_SELECTORS.join(",")).forEach((node) => {
    try { node.remove(); } catch {}
  });
  turnEl.querySelectorAll([
    `${userRoleSelector} input`,
    `${userRoleSelector} textarea`,
    `${userRoleSelector} select`,
    `${userRoleSelector} [aria-hidden="true"]`,
    `${userRoleSelector} [hidden]`
  ].join(",")).forEach((node) => {
    try { node.remove(); } catch {}
  });
  turnEl.querySelectorAll([
    `${userRoleSelector} button`,
    `${userRoleSelector} [role="button"]`
  ].join(",")).forEach((node) => {
    try {
      if (node.querySelector?.("img")) unwrapReplayNode(node);
      else node.remove();
    } catch {}
  });
  turnEl.querySelectorAll(REPLAY_UNWRAP_SELECTORS.join(",")).forEach((node) => {
    try { unwrapReplayNode(node); } catch {}
  });
}

/*
 * Extract the owner-relevant CONTENT of a captured provider turn.
 *
 * The provider turn wrapper and its role host are read here only as
 * compatibility landmarks for locating content; neither survives into the
 * mounted transcript. Structure, role and identity come from the owner record.
 */
function extractRichTurnContentHtml(htmlRaw, ownerRole){
  const html = String(htmlRaw || "").trim();
  if (!html) return "";

  let turnEl = null;
  try {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    turnEl = findConversationTurnElement(tpl.content);
  } catch {
    return "";
  }
  if (!(turnEl instanceof Element)) return "";

  try {
    stage0CompatCleanup(turnEl);
    if (normalizeRole(ownerRole) === (ROLES.USER || "user")) removeNativeUserAttachmentImages(turnEl);
    const roleHost = findRoleHostInTurn(turnEl, ownerRole);
    return String((roleHost instanceof Element ? roleHost : turnEl).innerHTML || "").trim();
  } catch {
    return "";
  }
}

/*
 * Renderer sanitizer v2 — the security boundary for rich replay.
 *
 * The fragment path is used deliberately: the string path would force a second
 * parse to remount, which measured materially more expensive. The returned
 * fragment is built in the engine's inert document, so ownerDocument !== the
 * live document; that is valid and DOM insertion adopts it, so it is never
 * treated as failure. Any failure returns null and the caller falls the whole
 * transcript back to the canonical renderer — never to the v1 sanitizer.
 */
function sanitizeRichContentFragment(contentHtml){
  const html = String(contentHtml || "").trim();
  if (!html) return null;

  const v2 = W.H2O?.Studio?.Renderer?.htmlSanitizer;
  if (!v2 || typeof v2.sanitizeToFragment !== "function") return null;
  try {
    if (v2.isSupported() !== true) return null;
  } catch {
    return null;
  }

  let fragment = null;
  try {
    fragment = v2.sanitizeToFragment(html);
  } catch {
    return null;
  }
  if (!fragment || fragment.nodeType !== 11) return null;
  return fragment;
}

/*
 * Post-sanitizer Renderer projection. Security is settled by v2; what remains
 * is presentation/accessibility that the Renderer owns: drop placeholder images,
 * guarantee alt text, and give external links safe target/rel behaviour.
 */
function projectRichContent(root){
  if (!root || typeof root.querySelectorAll !== "function") return;
  try {
    root.querySelectorAll("img").forEach((el) => { normalizeReplayImageAccessibility(el); });
    root.querySelectorAll("a").forEach((el) => { normalizeReplayLinkAccessibility(el); });
  } catch {}
}

function normalizeAttachmentRecord(raw, idx = 0, roleRaw = "user"){
  const src = raw && typeof raw === "object" ? raw : {};
  const kind = String(src.kind || src.type || "").trim().toLowerCase() || "image";
  if (kind !== "image") return null;
  const thumbnailSrc = normalizeSafeImageSrc(src.thumbnailSrc || src.thumbnail || src.src || "", true);
  const originalSrc = normalizeSafeImageSrc(src.originalSrc || src.original || src.url || src.href || thumbnailSrc || "", true);
  const captureStatus = String(src.captureStatus || src.status || (thumbnailSrc ? "linked" : "failed")).trim() || "failed";
  if (!thumbnailSrc && !originalSrc && captureStatus !== "failed") return null;
  const out = {
    kind: "image",
    role: normalizeRole(src.role || roleRaw, ROLES.USER || "user"),
    thumbnailSrc,
    originalSrc,
    alt: String(src.alt || "").trim(),
    width: Math.max(0, Math.round(Number(src.width || 0) || 0)),
    height: Math.max(0, Math.round(Number(src.height || 0) || 0)),
    naturalWidth: Math.max(0, Math.round(Number(src.naturalWidth || 0) || 0)),
    naturalHeight: Math.max(0, Math.round(Number(src.naturalHeight || 0) || 0)),
    captureStatus,
    source: String(src.source || "dom").trim() || "dom",
    order: Math.max(0, Math.floor(Number(src.order ?? idx) || idx)),
  };
  const error = String(src.error || "").trim();
  if (error) out.error = error.slice(0, 180);
  return out;
}

function normalizeAttachments(raw, roleRaw = "user"){
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  for (let i = 0; i < src.length; i += 1){
    const item = normalizeAttachmentRecord(src[i], i, roleRaw);
    if (item) out.push(item);
  }
  out.sort((a, b) => Number(a.order) - Number(b.order));
  return out;
}

function normalizeRichTurns(raw){
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  for (let i = 0; i < src.length; i += 1){
    const row = src[i] && typeof src[i] === "object" ? src[i] : {};
    const turnIdx = Math.max(1, Math.floor(Number(row.turnIdx ?? row.idx ?? (i + 1)) || (i + 1)));
    const role = normalizeRole(row.role || row.author || row.type || "");
    const outerHTML = String(row.outerHTML || row.html || "").trim();
    if (!outerHTML) continue;

    const item = { turnIdx, role, outerHTML };

    const createTime = Number(row.createTime ?? row.create_time ?? 0);
    const userCreateTime = Number(row.userCreateTime ?? row.user_create_time ?? 0);
    const assistantCreateTime = Number(row.assistantCreateTime ?? row.assistant_create_time ?? 0);
    const userMessageId = String(row.userMessageId || row.user_message_id || "").trim();
    const assistantMessageId = String(row.assistantMessageId || row.assistant_message_id || "").trim();
    const messageId = String(row.messageId || row.message_id || "").trim();
    const turnId = String(row.turnId || row.turn_id || "").trim();

    if (Number.isFinite(createTime) && createTime > 0) item.createTime = createTime;
    if (Number.isFinite(userCreateTime) && userCreateTime > 0) item.userCreateTime = userCreateTime;
    if (Number.isFinite(assistantCreateTime) && assistantCreateTime > 0) item.assistantCreateTime = assistantCreateTime;
    if (userMessageId) item.userMessageId = userMessageId;
    if (assistantMessageId) item.assistantMessageId = assistantMessageId;
    if (messageId) item.messageId = messageId;
    if (turnId) item.turnId = turnId;
    if (row.messageTimes && typeof row.messageTimes === "object") item.messageTimes = { ...row.messageTimes };
    const attachments = normalizeAttachments(row.attachments, role);
    if (attachments.length) item.attachments = attachments;

    out.push(item);
  }
  out.sort((a, b) => Number(a.turnIdx) - Number(b.turnIdx));
  return out;
}
function buildCanonicalMessage(role, text, meta = {}){
  const wrap = document.createElement("div");
  wrap.className = `cgMsg cgMsg--${role}`;
  wrap.setAttribute(ROLE_ATTR, role);
  if (meta.messageId) wrap.setAttribute(MESSAGE_ID_ATTR, String(meta.messageId));
  if (meta.turnId) wrap.setAttribute(TURN_ID_ATTR, String(meta.turnId));
  if (meta.dir) wrap.setAttribute("dir", String(meta.dir));

  const bodyEl = document.createElement("div");
  bodyEl.className = "cgMsgBody";
  bodyEl.innerHTML = renderTextAsChatGPTBlocks(role === "user" ? cleanReaderUserText(text) : text);

  wrap.appendChild(bodyEl);

  if (meta.answerIdx && role === "assistant"){
    wrap.dataset.turnIdx = String(meta.answerIdx);
  }
  return wrap;
}

function buildUserAttachmentGrid(attachmentsRaw){
  const attachments = (Array.isArray(attachmentsRaw) ? attachmentsRaw : [])
    .filter((item) => item?.kind === "image");
  if (!attachments.length) return null;
  const grid = document.createElement("div");
  grid.className = "cgUserAttachmentGrid";
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", "Attached images");
  for (const item of attachments){
    const src = normalizeSafeImageSrc(item.thumbnailSrc || item.originalSrc || "", true);
    if (!src) continue;
    const card = document.createElement("div");
    card.className = "cgUserAttachmentCard";
    card.dataset.captureStatus = String(item.captureStatus || "");

    const img = document.createElement("img");
    img.src = src;
    img.alt = normalizeImageAlt(item.alt);
    img.loading = "lazy";
    img.decoding = "async";
    if (item.naturalWidth > 0) img.dataset.naturalWidth = String(item.naturalWidth);
    if (item.naturalHeight > 0) img.dataset.naturalHeight = String(item.naturalHeight);
    card.appendChild(img);
    grid.appendChild(card);
  }
  return grid.childElementCount ? grid : null;
}

function removeNativeUserAttachmentImages(turnEl){
  if (!(turnEl instanceof Element)) return;
  const assistantRoleSelector = SEL.assistantTurn || (
    typeof BY.role === "function"
      ? BY.role(ROLES.ASSISTANT || "assistant")
      : `[${ROLE_ATTR}="assistant"]`
  );
  turnEl.querySelectorAll('img').forEach((img) => {
    try {
      if (img.closest(".cgUserAttachmentGrid")) return;
      if (img.closest(assistantRoleSelector)) return;
      const holder = img.closest('[data-message-attachment-id], [data-testid="image-asset"], button, [role="button"]');
      if (holder && holder !== turnEl) {
        holder.remove();
        return;
      }
      const grid = img.closest(".grid");
      img.remove();
      if (grid && !grid.querySelector("img") && !normalizeText(grid.textContent || "")) grid.remove();
    } catch {}
  });
}

function attachUserAttachmentsToTurn(turnEl, messageEl, attachmentsRaw){
  if (!(turnEl instanceof Element) || !(messageEl instanceof Element)) return;
  const grid = buildUserAttachmentGrid(attachmentsRaw);
  if (!grid) return;
  removeNativeUserAttachmentImages(turnEl);
  turnEl.classList.add("cgTurn--has-attachments");
  messageEl.insertAdjacentElement("beforebegin", grid);
}

function buildCanonicalTurn(role, text, meta = {}){
  const turn = document.createElement("article");
  turn.className = `cgTurn cgTurn--${role} wbTurn wbTurn--fallback wbTurn--${role}`;
  turn.setAttribute(TESTID_ATTR, meta.turnNo > 0 ? `${TURN_TESTID}-${meta.turnNo}` : TURN_TESTID);
  turn.setAttribute("data-turn", role);
  applyTurnAccessibility(turn, role);

  const messageEl = buildCanonicalMessage(role, text, meta);
  if (role === "assistant" && meta.answerIdx > 0){
    turn.dataset.turnIdx = String(meta.answerIdx);
  }
  stampReplayTurnMeta(turn, messageEl, meta.createTime, meta.turnNo);
  turn.appendChild(messageEl);
  if (role === "user") attachUserAttachmentsToTurn(turn, messageEl, meta.attachments);
  return { turn, messageEl };
}

/*
 * H2O-owned rich turn/message shells (M03 P1 S1A T1).
 *
 * Structure, canonical role and identity are Renderer/owner property. Provider
 * markup never decides whether a node is a turn or a message, what role it
 * carries, or which identity it claims — it is mounted as content inside these
 * hosts. The compatibility attributes stamped here are derived from the owner
 * record and the Renderer projection, never copied from provider HTML, so
 * captured markup cannot spoof them. They are retained because existing
 * downstream consumers and the accepted user-bubble geometry still key on them.
 */
function buildRichTurnShell(role, meta = {}){
  const turn = document.createElement("article");
  turn.className = `cgTurn cgTurn--${role} wbTurn wbTurn--rich wbTurn--${role}`;
  turn.setAttribute(TESTID_ATTR, meta.turnNo > 0 ? `${TURN_TESTID}-${meta.turnNo}` : TURN_TESTID);
  turn.setAttribute("data-turn", role);
  applyTurnAccessibility(turn, role);

  const messageEl = document.createElement("div");
  /* Neutral H2O message host only. The role modifier is deliberately omitted
   * here: cgMsg--user carries the canonical bubble skin (padding, background,
   * radius), which would wrap a second bubble around provider content that
   * already contains .user-message-bubble-color. The owner-derived role
   * attribute below stays — rich-replay CSS keys on it, and it is structural
   * metadata, not presentation. */
  messageEl.className = "cgMsg";
  messageEl.setAttribute(ROLE_ATTR, role);

  if (role === "assistant" && meta.answerIdx > 0){
    turn.dataset.turnIdx = String(meta.answerIdx);
    try { messageEl.dataset.turnIdx = String(meta.answerIdx); } catch {}
  }
  claimReplayIdentity(messageEl, MESSAGE_ID_ATTR, meta.messageId, meta.seenMessageIds);
  claimReplayIdentity(messageEl, TURN_ID_ATTR, meta.turnId, meta.seenTurnIds);
  stampReplayTurnMeta(turn, messageEl, meta.createTime, meta.turnNo);

  turn.appendChild(messageEl);
  return { turn, messageEl };
}
function claimReplayIdentity(el, attrName, preferredRaw, seen){
  if (!(el instanceof Element)) return "";
  const existing = String(el.getAttribute(attrName) || "").trim();
  const preferred = String(preferredRaw || "").trim();
  const value = existing || preferred;
  if (!value){
    try { el.removeAttribute(attrName); } catch {}
    return "";
  }
  if (seen instanceof Set && seen.has(value)){
    // Preserve the first supplied identity and omit later collisions so DOM
    // lookup consumers never resolve two replay messages to the same key.
    try { el.removeAttribute(attrName); } catch {}
    return "";
  }
  if (seen instanceof Set) seen.add(value);
  if (existing !== value){
    try { el.setAttribute(attrName, value); } catch { return ""; }
  }
  return value;
}
function applyEditedMessageBody(messageEl, role, text){
  if (!(messageEl instanceof Element)) return;
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole) return;
  messageEl.innerHTML = "";
  messageEl.setAttribute(ROLE_ATTR, normalizedRole);
  messageEl.classList.add("cgMsg", `cgMsg--${normalizedRole}`, "cgMsg--edited");

  const bodyEl = document.createElement("div");
  bodyEl.className = "cgMsgBody";
  bodyEl.innerHTML = renderTextAsChatGPTBlocks(text);
  messageEl.appendChild(bodyEl);
}
function buildCanonicalConversation(container, snap){
  const messages = Array.isArray(snap?.messages) ? snap.messages : [];
  const assistantTurns = [];
  let answerIdx = 0;
  let turnNo = 0;

  for (const row of messages){
    const role = normalizeRole(row?.role);
    if (!role) continue;
    const text = String(row?.text || "");
    turnNo += 1;

    const rowCreateTime = resolveSnapshotTurnCreateTime(snap, row, turnNo - 1);
    const nextAnswerIdx = role === "assistant" ? (answerIdx + 1) : 0;
    const { turn, messageEl } = buildCanonicalTurn(role, text, {
      turnNo,
      answerIdx: nextAnswerIdx,
      createTime: rowCreateTime,
      messageId: row?.messageId || row?.id || "",
      turnId: row?.turnId || "",
      dir: row?.dir || "",
      attachments: row?.attachments,
    });
    if (role === "assistant"){
      answerIdx = nextAnswerIdx;
      assistantTurns.push(turn);
    }
    container.appendChild(turn);
  }

  return assistantTurns;
}

function mountRichTurns(container, richTurns, snapshotId, snap, options){
  options = options && typeof options === "object" ? options : {};
  const sid = String(snapshotId || "");
  const normalized = Array.isArray(richTurns) ? richTurns : [];
  const assistantHosts = [];
  const pendingHosts = [];
  const seenMessageIds = new Set();
  const seenTurnIds = new Set();
  let assistantIdx = 0;

  const fallbackResult = {
    mountedTurnCount: 0,
    assistantTurnEls: [],
    fallbackRequired: true,
  };
  if (!normalized.length) return fallbackResult;

  try {
    for (let i = 0; i < normalized.length; i += 1){
      const turn = normalized[i];
      const turnNo = Number(turn.turnIdx || (i + 1)) || (i + 1);
      const createTime = resolveSnapshotTurnCreateTime(snap, turn, i);
      const snapMessage = Array.isArray(snap?.messages) ? snap.messages[turnNo - 1] : null;
      const userAttachments = Array.isArray(turn.attachments) && turn.attachments.length
        ? turn.attachments
        : (Array.isArray(snapMessage?.attachments) ? snapMessage.attachments : []);

      /* Canonical role is owner property. An unrepresentable role fails the
       * whole transcript closed rather than guessing from provider markup. */
      const role = normalizeRole(turn.role);
      if (!role) return fallbackResult;

      const contentHtml = extractRichTurnContentHtml(turn.outerHTML, role);
      if (!contentHtml) return fallbackResult;
      const fragment = sanitizeRichContentFragment(contentHtml);
      if (!fragment) return fallbackResult;

      const answerIdx = role === "assistant" ? (assistantIdx + 1) : 0;
      const { turn: host, messageEl } = buildRichTurnShell(role, {
        turnNo,
        answerIdx,
        createTime,
        messageId: turn.messageId || (role === "assistant" ? turn.assistantMessageId : turn.userMessageId),
        turnId: turn.turnId,
        seenMessageIds,
        seenTurnIds,
      });

      /* The fragment carries a foreign inert ownerDocument; appendChild adopts
       * it, so no explicit import/adopt is needed. */
      messageEl.appendChild(fragment);
      projectRichContent(messageEl);
      if (role === "user") cleanReaderUserTextNodeLeaks(host);

      const override = sid && typeof options.getEditOverride === "function"
        ? options.getEditOverride(sid, turn.turnIdx)
        : null;
      if (override !== null && role === "assistant"){
        host.classList.add("wbTurn--edited");
        applyEditedMessageBody(messageEl, role, override);
      }

      if (role === "assistant"){
        assistantIdx = answerIdx;
        assistantHosts.push(host);
      } else if (role === "user"){
        attachUserAttachmentsToTurn(host, messageEl, userAttachments);
      }

      pendingHosts.push(host);
    }
  } catch {
    return fallbackResult;
  }

  let appendedCount = 0;
  try {
    for (const host of pendingHosts){
      container.appendChild(host);
      appendedCount += 1;
    }
  } catch {
    for (let i = 0; i < appendedCount; i += 1){
      try { pendingHosts[i].remove(); } catch {}
    }
    return fallbackResult;
  }

  return {
    mountedTurnCount: pendingHosts.length,
    assistantTurnEls: assistantHosts,
    fallbackRequired: false,
  };
}

function normalizeRendererMessage(raw, idx, snapshot){
  const row = raw && typeof raw === "object" ? raw : {};
  const role = normalizeRole(row.role || row.author || row.type || "");
  if (!role) return null;
  return {
    order: Number.isFinite(Number(row.order)) ? Number(row.order) : idx,
    role,
    text: String(row.text ?? ""),
    createTime: resolveSnapshotTurnCreateTime(snapshot, row, idx),
    messageId: String(row.messageId || row.id || "").trim(),
    turnId: String(row.turnId || "").trim(),
    dir: String(row.dir || "").trim(),
    attachments: normalizeAttachments(row.attachments, role),
  };
}

function normalizeRendererMessages(raw, snapshot){
  const rows = Array.isArray(raw) ? raw : [];
  const messages = [];
  const seenMessageIds = new Set();
  const seenTurnIds = new Set();

  for (let i = 0; i < rows.length; i += 1){
    const message = normalizeRendererMessage(rows[i], i, snapshot);
    if (!message) continue;
    if (message.messageId){
      if (seenMessageIds.has(message.messageId)) message.messageId = "";
      else seenMessageIds.add(message.messageId);
    }
    if (message.turnId){
      if (seenTurnIds.has(message.turnId)) message.turnId = "";
      else seenTurnIds.add(message.turnId);
    }
    messages.push(message);
  }

  return messages;
}

function normalizeInput(snapshot){
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  if (source[NORMALIZED_INPUT]) return source;

  const metadata = source.meta && typeof source.meta === "object"
    ? { ...source.meta }
    : (source.metadata && typeof source.metadata === "object" ? { ...source.metadata } : {});
  const input = {
    snapshotId: String(source.snapshotId || metadata.snapshotId || ""),
    chatId: String(source.chatId || metadata.chatId || ""),
    title: String(metadata.title || source.title || source.chatId || "Saved chat"),
    projectId: String(metadata.projectId || source.projectId || ""),
    metadata,
    messages: [],
    richTurns: normalizeRichTurns(source.richTurns || metadata.richTurns),
  };
  input.messages = normalizeRendererMessages(source.messages, { metadata });
  Object.defineProperty(input, NORMALIZED_INPUT, { value: true });
  return input;
}

function haveEquivalentRendererAttachments(leftRaw, rightRaw){
  const left = Array.isArray(leftRaw) ? leftRaw : [];
  const right = Array.isArray(rightRaw) ? rightRaw : [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1){
    const a = left[i] || {};
    const b = right[i] || {};
    if (
      String(a.kind || "") !== String(b.kind || "")
      || String(a.thumbnailSrc || "") !== String(b.thumbnailSrc || "")
      || String(a.originalSrc || "") !== String(b.originalSrc || "")
      || String(a.alt || "") !== String(b.alt || "")
      || Number(a.naturalWidth || 0) !== Number(b.naturalWidth || 0)
      || Number(a.naturalHeight || 0) !== Number(b.naturalHeight || 0)
      || String(a.captureStatus || "") !== String(b.captureStatus || "")
    ) return false;
  }
  return true;
}

function haveEquivalentRendererMessages(leftRaw, rightRaw){
  const left = Array.isArray(leftRaw) ? leftRaw : [];
  const right = Array.isArray(rightRaw) ? rightRaw : [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1){
    const a = left[i] || {};
    const b = right[i] || {};
    if (
      String(a.role || "") !== String(b.role || "")
      || String(a.text || "") !== String(b.text || "")
      || Number(a.createTime || 0) !== Number(b.createTime || 0)
      || String(a.messageId || "") !== String(b.messageId || "")
      || String(a.turnId || "") !== String(b.turnId || "")
      || String(a.dir || "") !== String(b.dir || "")
      || !haveEquivalentRendererAttachments(a.attachments, b.attachments)
    ) return false;
  }
  return true;
}

function haveEquivalentRendererRichTurns(leftInput, rightInput){
  const left = Array.isArray(leftInput?.richTurns) ? leftInput.richTurns : [];
  const right = Array.isArray(rightInput?.richTurns) ? rightInput.richTurns : [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1){
    const a = left[i] || {};
    const b = right[i] || {};
    if (
      Number(a.turnIdx || 0) !== Number(b.turnIdx || 0)
      || String(a.role || "") !== String(b.role || "")
      || String(a.outerHTML || "") !== String(b.outerHTML || "")
      || resolveSnapshotTurnCreateTime(leftInput, a, i) !== resolveSnapshotTurnCreateTime(rightInput, b, i)
      || String(a.userMessageId || "") !== String(b.userMessageId || "")
      || String(a.assistantMessageId || "") !== String(b.assistantMessageId || "")
      || String(a.messageId || "") !== String(b.messageId || "")
      || String(a.turnId || "") !== String(b.turnId || "")
      || !haveEquivalentRendererAttachments(a.attachments, b.attachments)
    ) return false;
  }
  return true;
}

// Exact presentation-time equivalence for the base transcript. This deliberately
// compares normalized Renderer inputs rather than snapshot identity or storage
// metadata: a same-ID snapshot may change, while folder/category bookkeeping that
// never reaches the base transcript must not force a rebuild.
function isRenderEquivalent(leftRaw, rightRaw){
  const left = normalizeInput(leftRaw);
  const right = normalizeInput(rightRaw);
  return (
    left.snapshotId === right.snapshotId
    && left.chatId === right.chatId
    && left.title === right.title
    && left.projectId === right.projectId
    && haveEquivalentRendererMessages(left.messages, right.messages)
    && haveEquivalentRendererRichTurns(left, right)
  );
}

function hasCompleteRichCoverage(input){
  const richTurns = Array.isArray(input?.richTurns) ? input.richTurns : [];
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  if (!richTurns.length) return false;
  // Rich replay is intentionally a whole-transcript mode. A partial rich set
  // must not hide otherwise usable canonical turns or create a hybrid replay.
  return !messages.length || richTurns.length === messages.length;
}

function render(inputRaw, options){
  options = options && typeof options === "object" ? options : {};
  const input = normalizeInput(inputRaw);
  const root = document.createElement("div");
  root.className = "cgFrame";
  root.dataset.chatTitle = input.title;
  root.dataset.chatId = input.chatId;
  root.dataset.projectId = input.projectId;
  root.innerHTML = `
    <div class="cgBody">
      <div class="cgThread">
        <section class="cgScroll" data-testid="${TURNS_TESTID}" aria-label="Conversation transcript"></section>
      </div>
    </div>
  `;

  const turnsEl = root.querySelector(".cgScroll");
  if (!(turnsEl instanceof Element)){
    throw new Error("Studio Chat Renderer could not create the conversation root");
  }
  turnsEl.classList.add("wbReaderScroll");

  let assistantTurnEls = [];
  let richRenderResult = {
    mountedTurnCount: 0,
    assistantTurnEls: [],
    fallbackRequired: true,
  };

  if (hasCompleteRichCoverage(input)){
    turnsEl.classList.add("wbRichRoot", "is-rich");
    richRenderResult = mountRichTurns(
      turnsEl,
      input.richTurns,
      input.snapshotId,
      input,
      options
    );
    assistantTurnEls = richRenderResult.assistantTurnEls;
  }

  let renderMode = "rich";
  if (richRenderResult.fallbackRequired){
    renderMode = "canonical";
    turnsEl.classList.add("wbRichRoot");
    turnsEl.classList.remove("is-rich");
    assistantTurnEls = buildCanonicalConversation(turnsEl, input);
  }

  return {
    root,
    turnsEl,
    scrollEl: turnsEl,
    assistantTurnEls,
    mountedTurnCount: turnsEl.children.length,
    renderMode,
  };
}

Studio.chatRenderer = Object.freeze({
  normalizeInput,
  normalizeRole,
  isRenderEquivalent,
  render,
  applyEditedMessageBody,
});
})(window);
