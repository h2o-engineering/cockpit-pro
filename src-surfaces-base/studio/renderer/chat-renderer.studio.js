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
  const profile = activePresentationProfile();
  const messageSelector = [
    userRoleSelector,
    ...profile.userBubbleClasses().map((cls) => `.${cls}`),
    ...profile.messageClasses("user", "canonical").map((cls) => `.${cls}`),
  ].join(", ");
  const turnSelector = [
    ".cgTurn--user",
    ...profile.hooks.turn.role.user.map((cls) => `.${cls}`),
    '[data-turn="user"]',
  ].join(", ");
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
/*
 * Canonical Markdown body: source -> markdown engine -> Render IR -> typed
 * ContentRenderer -> H2O-owned DOM. No Markdown-generated HTML string, and no
 * innerHTML on this path.
 *
 * The engine is constructed once. markdown-it instances are reusable, and
 * rebuilding one per message would be a needless regression on long
 * transcripts.
 */
let semanticEngineInstance = null;
function semanticMarkdownEngine(){
  if (semanticEngineInstance) return semanticEngineInstance;
  const engineApi = Studio.Renderer && Studio.Renderer.markdownEngine;
  if (!engineApi || typeof engineApi.formalBaseEngine !== "function") return null;
  // Formal-base semantics stay the default; no dated provider profile is
  // forced globally.
  semanticEngineInstance = engineApi.formalBaseEngine();
  return semanticEngineInstance;
}

// Deterministic whole-message verbatim fallback. The author's characters must
// stay visible, and never as a partial semantic tree plus a legacy remainder.
// The bespoke parser is NOT consulted: it no longer exists.
function appendVerbatimBody(bodyEl, text){
  while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
  const p = document.createElement("p");
  p.appendChild(document.createTextNode(String(text ?? "")));
  bodyEl.appendChild(p);
  return false;
}

function renderSemanticBody(bodyEl, source){
  const text = String(source ?? "");
  const R = Studio.Renderer || {};
  try {
    const md = semanticMarkdownEngine();
    const adapter = R.markdownIrAdapter;
    const content = R.contentRenderer;
    const ir = R.renderIR;
    if (!md || !adapter || !content || !ir) throw new Error("markdown semantic runtime unavailable");

    const parsed = adapter.markdownToBlocks(md, text);
    if (!parsed || parsed.fallback === true || !Array.isArray(parsed.blocks)){
      throw new Error("markdown adapter requested fallback");
    }

    // The accepted Render IR contract is the validation authority; T5 adds no
    // second model or validation layer.
    const doc = ir.createConversation({
      id: "h2o.render",
      messages: [{ id: "h2o.message", role: "assistant", blocks: parsed.blocks }],
    });
    const verdict = ir.validate(doc);
    if (!verdict || verdict.ok !== true) throw new Error("render ir rejected the produced blocks");

    // Built detached first, so a throw mid-render cannot leave a partial tree
    // in the message body.
    const fragment = content.renderBlocks(parsed.blocks, { document });
    while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
    bodyEl.appendChild(fragment);
    return true;
  } catch {
    return appendVerbatimBody(bodyEl, text);
  }
}

/*
 * Author text recoverable from accepted Render IR blocks WITHOUT any HTML:
 * text nodes only. Opaque HTML payloads are deliberately never included, so a
 * fallback can never surface raw provider markup.
 */
function safeTextFromBlocks(blocks){
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.kind === "text" && typeof node.text === "string") out.push(node.text);
    for (const key of ["children", "blocks", "items", "rows", "cells"]){
      if (Array.isArray(node[key])) node[key].forEach(walk);
    }
  };
  (Array.isArray(blocks) ? blocks : []).forEach(walk);
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/*
 * Already-semantic blocks (Saved-Chat v3 via semantic ingress). No Markdown
 * reparse: the owner contract does not mark v3 text parts as Markdown. Any
 * renderer failure - including a refused owner-HTML block - falls back to the
 * whole message's safe text, never to raw HTML, shared v1 HTML, provider
 * outerHTML or a legacy parser.
 */
function renderSemanticBlocks(bodyEl, blocks){
  const R = Studio.Renderer || {};
  try {
    const content = R.contentRenderer;
    if (!content || !Array.isArray(blocks)) throw new Error("content renderer unavailable");
    const fragment = content.renderBlocks(blocks, { document });
    while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
    bodyEl.appendChild(fragment);
    return true;
  } catch {
    return appendVerbatimBody(bodyEl, safeTextFromBlocks(blocks) || "Content unavailable");
  }
}

/*
 * Conforming Saved-Chat v3 -> Render IR through the accepted semantic ingress,
 * BEFORE compatibility normalization could flatten typed content[] away. Any
 * non-conforming v3 input (including an HTML part its owner did not mark
 * sanitized) makes ingress throw, and this returns null: nothing new is
 * trusted and the input takes the pre-existing path unchanged.
 */
function semanticV3Conversation(inputRaw){
  const R = Studio.Renderer || {};
  const ingress = R.semanticIngress;
  const ir = R.renderIR;
  if (!ingress || !ir || typeof ingress.fromSavedChatV3Snapshot !== "function") return null;
  try {
    if (ingress.detectSourceKind(inputRaw) !== ingress.sourceKinds.SAVED_CHAT_V3) return null;
    const conversation = ingress.fromSavedChatV3Snapshot(inputRaw);
    const verdict = ir.validate(conversation);
    if (!verdict || verdict.ok !== true) return null;
    return conversation;
  } catch {
    return null;
  }
}

function buildSemanticConversation(container, conversation, snapRaw){
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const rawRows = Array.isArray(snapRaw?.messages) ? snapRaw.messages : [];
  const assistantTurns = [];
  let answerIdx = 0;
  let turnNo = 0;

  for (let i = 0; i < messages.length; i += 1){
    const message = messages[i];
    const role = normalizeRole(message?.role);
    if (!role) continue;
    const raw = rawRows[i] && typeof rawRows[i] === "object" ? rawRows[i] : {};
    turnNo += 1;

    const rowCreateTime = resolveSnapshotTurnCreateTime(snapRaw, raw, turnNo - 1);
    const nextAnswerIdx = role === "assistant" ? (answerIdx + 1) : 0;
    const { turn } = buildCanonicalTurn(role, "", {
      turnNo,
      answerIdx: nextAnswerIdx,
      createTime: rowCreateTime,
      messageId: raw.messageId || raw.id || "",
      turnId: raw.turnId || "",
      dir: message.dir || raw.dir || "",
      attachments: raw.attachments,
      semanticBlocks: message.blocks,
    });
    if (role === "assistant"){
      answerIdx = nextAnswerIdx;
      assistantTurns.push(turn);
    }
    container.appendChild(turn);
  }

  return assistantTurns;
}

function buildCanonicalMessage(role, text, meta = {}){
  const wrap = buildMessageHost(role, "canonical", meta);

  const bodyEl = document.createElement("div");
  bodyEl.className = "cgMsgBody";
  if (Array.isArray(meta.semanticBlocks)){
    renderSemanticBlocks(bodyEl, meta.semanticBlocks);
  } else {
    renderSemanticBody(bodyEl, role === "user" ? cleanReaderUserText(text) : text);
  }

  wrap.appendChild(bodyEl);
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

/*
 * H2O structural shell authority (M03 P3 S3A T6, slice A).
 *
 * The Renderer is the single construction authority for the shared structural
 * DOM: the conversation shell, the turn shell and the message host. Canonical,
 * Saved-Chat v3 semantic and rich replay all reach these seams; they differ only
 * by a narrow `mode` ("canonical" | "rich") that selects mode-specific
 * presentation classes and identity rules, never by owning structure. Provider
 * content is only ever a descendant of the H2O message host and cannot create a
 * conversation root, a turn, a message host, a role or an identity.
 *
 * Structural ownership, not identity expansion: no new ids or projection
 * identity scheme are introduced here (P4 owns that), and every effective DOM
 * contract below is unchanged from the pre-consolidation builders.
 */
/*
 * PresentationProfile consumption (M03 P3 S3B T6, slice A).
 *
 * Structure is Renderer property and profile-independent (cgFrame, cgBody,
 * cgThread, cgScroll, cgTurn, cgMsg, cgMsgBody, cgBubble, cgBubbleRail, role,
 * identity, accessibility). How that structure looks - the presentation and
 * provider-compatibility class hooks layered on it - is the active
 * PresentationProfile's decision, resolved here from the Renderer profile
 * module. There is deliberately no embedded class map to fall back to: a
 * missing profile fails clearly rather than becoming a second presentation
 * authority.
 */
const PRESENTATION_PROFILE_ATTR = "data-h2o-presentation-profile";

/* S4A: the Semantic Index module is a passive Renderer dependency admitted by
 * the Studio script chain; like the PresentationProfile it has no embedded
 * fallback, so a missing module fails clearly instead of rendering an
 * index-less result. */
function activeSemanticIndexModule(){
  const api = Studio.Renderer && Studio.Renderer.semanticIndex;
  if (!api || api.__installed !== true || typeof api.createShellIndex !== "function"){
    throw new Error("Studio Chat Renderer requires H2O.Studio.Renderer.semanticIndex (renderer/semantic/semantic-index.v1.js); no embedded index fallback exists");
  }
  return api;
}

/* Projection metadata the Renderer knows while it builds each turn shell (role,
 * turn number, source ids as supplied by the normalized input). Kept beside the
 * element, never on it: no DOM attribute is emitted for it, and the entries die
 * with their shells. The Semantic Index reads it as source metadata only. */
const TURN_PROJECTION_META = new WeakMap();

function activePresentationProfile(){
  const api = Studio.Renderer && Studio.Renderer.presentationProfile;
  if (!api || api.__installed !== true || typeof api.reference !== "function"){
    throw new Error("Studio Chat Renderer requires H2O.Studio.Renderer.presentationProfile (renderer/presentation/presentation-profile.v1.js); no embedded presentation fallback exists");
  }
  const profile = api.reference();
  if (!profile || typeof profile.id !== "string" || !profile.id){
    throw new Error("Studio Chat Renderer: the reference PresentationProfile is unavailable");
  }
  return profile;
}

function buildConversationShell(input){
  const root = document.createElement("div");
  root.className = "cgFrame";
  root.dataset.chatTitle = input.title;
  root.dataset.chatId = input.chatId;
  root.dataset.projectId = input.projectId;
  /* Observable presentation-selection marker only: not identity, not Storage
   * or Knowledge metadata, and no CSS keys on it yet. */
  root.setAttribute(PRESENTATION_PROFILE_ATTR, activePresentationProfile().id);

  const body = document.createElement("div");
  body.className = "cgBody";
  const thread = document.createElement("div");
  thread.className = "cgThread";
  const turnsEl = document.createElement("section");
  turnsEl.className = "cgScroll";
  /* Literal attribute name, exactly as the transcript root has always been
   * stamped; the turn shells key on the selector contract's TESTID_ATTR. */
  turnsEl.setAttribute("data-testid", TURNS_TESTID);
  turnsEl.setAttribute("aria-label", "Conversation transcript");

  thread.appendChild(turnsEl);
  body.appendChild(thread);
  root.appendChild(body);
  return { root, turnsEl };
}

function buildTurnShell(role, mode, meta = {}){
  const turn = document.createElement("article");
  turn.className = ["cgTurn", `cgTurn--${role}`, ...activePresentationProfile().turnClasses(role, mode)].join(" ");
  turn.setAttribute(TESTID_ATTR, meta.turnNo > 0 ? `${TURN_TESTID}-${meta.turnNo}` : TURN_TESTID);
  turn.setAttribute("data-turn", role);
  applyTurnAccessibility(turn, role);
  if (role === "assistant" && meta.answerIdx > 0){
    turn.dataset.turnIdx = String(meta.answerIdx);
  }
  TURN_PROJECTION_META.set(turn, Object.freeze({
    role,
    mode,
    turnNo: Number(meta.turnNo) > 0 ? Number(meta.turnNo) : 0,
    messageId: String(meta.messageId || "").trim(),
    turnId: String(meta.turnId || "").trim(),
  }));
  return turn;
}

function buildMessageHost(role, mode, meta = {}){
  const messageEl = document.createElement("div");
  /* The presentation modifier is the profile's decision: canonical hosts carry
   * the bubble skin themselves, while a rich host stays a neutral cgMsg because
   * the rich user bubble is a separate H2O element beneath it
   * (adoptRichUserBubble) that carries the skin through the profile's
   * compatibility class - a modifier here would wrap a second bubble around
   * it. The owner-derived role attribute below stays - rich-replay CSS keys on
   * it, and it is structural metadata, not presentation. */
  messageEl.className = ["cgMsg", ...activePresentationProfile().messageClasses(role, mode)].join(" ");
  messageEl.setAttribute(ROLE_ATTR, role);

  if (mode === "rich"){
    if (role === "assistant" && meta.answerIdx > 0){
      try { messageEl.dataset.turnIdx = String(meta.answerIdx); } catch {}
    }
    /* Owner-derived identity with collision dedupe: provider markup never
     * decides which identity a replayed message claims. */
    claimReplayIdentity(messageEl, MESSAGE_ID_ATTR, meta.messageId, meta.seenMessageIds);
    claimReplayIdentity(messageEl, TURN_ID_ATTR, meta.turnId, meta.seenTurnIds);
  } else {
    if (meta.messageId) messageEl.setAttribute(MESSAGE_ID_ATTR, String(meta.messageId));
    if (meta.turnId) messageEl.setAttribute(TURN_ID_ATTR, String(meta.turnId));
    if (meta.dir) messageEl.setAttribute("dir", String(meta.dir));
    if (meta.answerIdx && role === "assistant"){
      messageEl.dataset.turnIdx = String(meta.answerIdx);
    }
  }
  return messageEl;
}

function buildCanonicalTurn(role, text, meta = {}){
  const turn = buildTurnShell(role, "canonical", meta);
  const messageEl = buildCanonicalMessage(role, text, meta);
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
  const turn = buildTurnShell(role, "rich", meta);
  const messageEl = buildMessageHost(role, "rich", meta);
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
/*
 * H2O rich user-bubble authority (M03 P3 S3A T6, slice B).
 *
 * The Renderer decides that a rich user message has exactly one bubble and
 * creates that element itself. Provider markup may still supply the CONTENT
 * inside the bubble, and its `user-message-bubble-color` marker is read only to
 * locate where that bubble sits in the sanitized content; the provider element
 * never survives as the bubble boundary, and several or nested markers cannot
 * create more than one bubble.
 *
 * Presentation stays on the accepted compatibility path: the compatibility
 * class the H2O bubble carries, and the provider marker class that locates a
 * captured bubble, both come from the active PresentationProfile (for the
 * ChatGPT reference profile they are the same token), and nothing else is
 * taken from the provider element except a sanitized `dir` (bidi rendering).
 * Identity is never copied: the message host owns role and identity, and the
 * bubble is presentation-container structure beneath it.
 *
 * The bubble-boundary class vocabulary belongs to the Renderer as well: the
 * provider marker and the H2O bubble classes are demoted wherever sanitized
 * provider content carries them, so no content element can pose as the bubble
 * or the rail.
 *
 * Only sanitized DOM reaches this seam (sanitizer v2 has already run), and it
 * runs before post-sanitizer content projection.
 */
const USER_BUBBLE_H2O_CLASSES = ["cgBubble", "cgBubble--user", "cgBubbleRail"];

function buildRichUserBubbleShell(){
  const bubble = document.createElement("div");
  bubble.className = ["cgBubble", "cgBubble--user", ...activePresentationProfile().userBubbleClasses()].join(" ");
  return bubble;
}

function adoptRichUserBubble(messageEl){
  if (!(messageEl instanceof Element)) return false;
  const markerClass = activePresentationProfile().userBubbleMarkerClass();
  messageEl.querySelectorAll(USER_BUBBLE_H2O_CLASSES.map((cls) => `.${cls}`).join(", ")).forEach((el) => {
    el.classList.remove(...USER_BUBBLE_H2O_CLASSES);
  });
  const markers = Array.from(messageEl.querySelectorAll(`.${markerClass}`));
  const outermost = markers.filter((el) => !markers.some((other) => other !== el && other.contains(el)));
  const bubble = buildRichUserBubbleShell();

  if (outermost.length === 1){
    /* Provider bubble present: the H2O bubble takes its logical position, so
     * the accepted bubble geometry (which keys on that position) is unchanged.
     * Nested markers become plain content. */
    const provider = outermost[0];
    if (!provider.parentNode) return false;
    const dir = String(provider.getAttribute("dir") || "").trim();
    if (dir) bubble.setAttribute("dir", dir);
    for (const el of markers){
      if (el !== provider) el.classList.remove(markerClass);
    }
    while (provider.firstChild) bubble.appendChild(provider.firstChild);
    provider.replaceWith(bubble);
    return true;
  }

  /* No provider bubble, or several unrelated markers: one H2O bubble over the
   * whole sanitized content in source order. The rail is the full-width
   * scaffolding layer the accepted bubble CSS expects between the role host
   * and the bubble; the provider wrapper supplies it when a bubble exists. */
  for (const el of markers) el.classList.remove(markerClass);
  const rail = document.createElement("div");
  rail.className = "cgBubbleRail";
  while (messageEl.firstChild) bubble.appendChild(messageEl.firstChild);
  rail.appendChild(bubble);
  messageEl.appendChild(rail);
  return true;
}
function applyEditedMessageBody(messageEl, role, text){
  if (!(messageEl instanceof Element)) return;
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole) return;
  while (messageEl.firstChild) messageEl.removeChild(messageEl.firstChild);
  messageEl.setAttribute(ROLE_ATTR, normalizedRole);
  const profile = activePresentationProfile();
  messageEl.classList.add("cgMsg", ...profile.messageClasses(normalizedRole, "canonical"), ...profile.editedMessageClasses());

  const bodyEl = document.createElement("div");
  bodyEl.className = "cgMsgBody";
  renderSemanticBody(bodyEl, text);
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
      /* The Renderer decides that a rich user message has exactly one bubble;
       * a user fragment that cannot be adopted fails the transcript closed. */
      if (role === "user" && !adoptRichUserBubble(messageEl)) return fallbackResult;
      projectRichContent(messageEl);
      if (role === "user") cleanReaderUserTextNodeLeaks(host);

      const override = sid && typeof options.getEditOverride === "function"
        ? options.getEditOverride(sid, turn.turnIdx)
        : null;
      if (override !== null && role === "assistant"){
        host.classList.add(...activePresentationProfile().editedTurnClasses());
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

/* "" when the row carries no typed content[]; null when it cannot be
 * fingerprinted, which conservatively defeats reuse rather than risking a stale
 * render. */
function typedContentKey(content){
  if (!Array.isArray(content)) return "";
  try { return JSON.stringify(content); } catch { return null; }
}

function normalizeRendererMessage(raw, idx, snapshot){
  const row = raw && typeof raw === "object" ? raw : {};
  const role = normalizeRole(row.role || row.author || row.type || "");
  if (!role) return null;
  return {
    order: Number.isFinite(Number(row.order)) ? Number(row.order) : idx,
    role,
    text: String(row.text ?? ""),
    /* Saved-Chat v3 carries typed content[] instead of text. Exact-equivalence
     * reuse must see that content, or two snapshots with the same identities
     * but different typed parts would be treated as identical. This is a
     * fingerprint only; rendering goes through semantic ingress. */
    contentKey: typedContentKey(row.content),
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
      || a.contentKey === null || b.contentKey === null || a.contentKey !== b.contentKey
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
  /* Resolved before normalizeInput so typed v3 content[] is never flattened. */
  const semanticConversation = semanticV3Conversation(inputRaw);
  const input = normalizeInput(inputRaw);
  const { root, turnsEl } = buildConversationShell(input);
  if (!(turnsEl instanceof Element)){
    throw new Error("Studio Chat Renderer could not create the conversation root");
  }
  turnsEl.classList.add("wbReaderScroll");
  const profile = activePresentationProfile();
  const richRootClasses = profile.transcriptClasses("rich");

  let assistantTurnEls = [];
  let richRenderResult = {
    mountedTurnCount: 0,
    assistantTurnEls: [],
    fallbackRequired: true,
  };

  if (hasCompleteRichCoverage(input)){
    turnsEl.classList.add(...richRootClasses);
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
    const canonicalRootClasses = profile.transcriptClasses("canonical");
    turnsEl.classList.remove(...richRootClasses.filter((cls) => !canonicalRootClasses.includes(cls)));
    turnsEl.classList.add(...canonicalRootClasses);
    /* Rich replay keeps its precedence untouched. In the canonical branch a
     * conforming v3 snapshot renders its typed content semantically through the
     * same H2O shells; everything else keeps the existing canonical path. */
    assistantTurnEls = semanticConversation
      ? buildSemanticConversation(turnsEl, semanticConversation, inputRaw)
      : buildCanonicalConversation(turnsEl, input);
  }

  /* S4A: one read-only Semantic Index per render result, built over the final
   * H2O shells (cgFrame / cgTurn / cgMsg). The semantic-v3 path hands its
   * accepted Render IR conversation over so the index reuses its renderKeys and
   * ownerRefs; every other path keys on source ids or projection order. The
   * index is owned by this result and never stored on the Renderer. */
  const semanticIndex = activeSemanticIndexModule().createShellIndex({
    root,
    turnsEl,
    renderMode,
    source: { chatId: input.chatId, snapshotId: input.snapshotId },
    semanticConversation: renderMode === "canonical" ? semanticConversation : null,
    describeTurn: (turnEl) => TURN_PROJECTION_META.get(turnEl) || null,
  });

  return {
    root,
    turnsEl,
    scrollEl: turnsEl,
    assistantTurnEls,
    mountedTurnCount: turnsEl.children.length,
    renderMode,
    semanticSource: semanticConversation ? "savedChatSnapshotV3" : "",
    semanticIndex,
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
