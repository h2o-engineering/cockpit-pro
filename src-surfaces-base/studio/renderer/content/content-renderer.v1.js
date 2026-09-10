// @version 1.0.0
"use strict";

/*
 * Typed ContentRenderer registry (M03 P2 S2B T5).
 *
 * Renders accepted Render IR blocks into H2O-owned DOM nodes. Semantic content
 * NEVER becomes an HTML string here: every node is built with createElement /
 * createTextNode, and author text always enters the DOM as text data.
 *
 * This module is the S2B sink, so it is where the previously frozen URL
 * boundary becomes active: `sanitizerPolicy.classifyUrl` is the sole admission
 * authority for link and image destinations. There is no second allowlist and
 * no independent URL() parsing, and a missing policy denies rather than admits.
 */
(function installStudioContentRenderer(W) {
  const API_VERSION = "1.0.0";
  const H2O = W.H2O = W.H2O || {};
  const Studio = H2O.Studio = H2O.Studio || {};
  const Renderer = Studio.Renderer = Studio.Renderer || {};

  /* Kinds this slice actually renders. */
  const CORE_KINDS = Object.freeze([
    "paragraph", "heading", "text", "list", "listItem", "blockquote",
    "codeBlock", "table", "tableRow", "tableCell", "image", "file",
    "thematicBreak", "hardBreak",
  ]);

  /*
   * Reserved for later slices. They are deliberately NOT registered: silently
   * mapping them to paragraph/text would fake support, so an unregistered kind
   * throws and the caller falls back to the whole-message verbatim path.
   */
  const RESERVED_EXTENSION_KINDS = Object.freeze([
    "math", "citation", "toolCall", "toolResult", "artifact", "opaqueProviderBlock",
  ]);

  const MARK_TAGS = Object.freeze({ strong: "strong", emphasis: "em", code: "code", strikethrough: "s" });
  const ALIGNMENTS = Object.freeze(["left", "center", "right"]);

  const registry = new Map();

  function asText(value) { return value === null || value === undefined ? "" : String(value); }

  function resolveDocument(context) {
    const doc = (context && context.document) || (typeof document !== "undefined" ? document : null);
    if (!doc || typeof doc.createElement !== "function") {
      throw new TypeError("contentRenderer requires a document in the render context");
    }
    return doc;
  }

  /*
   * Fail closed: when no policy is reachable the destination is denied, never
   * admitted. Renderer.sanitizerPolicy is the only authority consulted.
   */
  function classify(context, value, urlContext) {
    const policy = (context && context.urlPolicy) || Renderer.sanitizerPolicy;
    if (!policy || typeof policy.classifyUrl !== "function") {
      return { ok: false, reason: "url-policy-unavailable" };
    }
    const decision = policy.classifyUrl(value, urlContext);
    return decision && typeof decision === "object" ? decision : { ok: false, reason: "policy-returned-nothing" };
  }

  function el(context, tag) { return resolveDocument(context).createElement(tag); }
  function textNode(context, value) { return resolveDocument(context).createTextNode(asText(value)); }

  /* ---------------------------------------------------------------- marks */

  /*
   * Marks nest deterministically: marks[0] ends up OUTERMOST, so the array is
   * applied from last to first around the already-built node.
   */
  function applyMarks(node, marks, context) {
    if (!Array.isArray(marks) || marks.length === 0) return node;
    let current = node;
    for (let i = marks.length - 1; i >= 0; i -= 1) current = wrapMark(current, marks[i], context);
    return current;
  }

  function wrapMark(node, mark, context) {
    const kind = mark && mark.kind;
    if (Object.prototype.hasOwnProperty.call(MARK_TAGS, kind)) {
      const wrapper = el(context, MARK_TAGS[kind]);
      wrapper.appendChild(node);
      return wrapper;
    }
    if (kind === "link") {
      const decision = classify(context, mark.href, "link");
      if (decision.ok === true) {
        const anchor = el(context, "a");
        anchor.setAttribute("href", asText(mark.href));
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer");
        if (mark.title) anchor.setAttribute("title", asText(mark.title));
        anchor.appendChild(node);
        return anchor;
      }
      /* Denied: keep the author's characters, create no live destination and
       * no anchor element that could read as clickable. */
      const denied = el(context, "span");
      denied.setAttribute("data-h2o-link-denied", asText(decision.reason || "denied"));
      denied.appendChild(node);
      return denied;
    }
    throw new TypeError(`contentRenderer: unsupported mark kind: ${kind || "<empty>"}`);
  }

  /* --------------------------------------------------------------- helpers */

  function appendInline(parent, children, context) {
    if (!Array.isArray(children)) return parent;
    for (const child of children) parent.appendChild(renderBlock(child, context));
    return parent;
  }

  function appendBlocks(parent, blocks, context) {
    if (!Array.isArray(blocks)) return parent;
    for (const block of blocks) parent.appendChild(renderBlock(block, context));
    return parent;
  }

  function alignmentOf(align, index) {
    if (!Array.isArray(align)) return null;
    const value = align[index];
    return ALIGNMENTS.indexOf(value) === -1 ? null : value;
  }

  /* --------------------------------------------------------------- registry */

  function register(kind, renderer) {
    if (typeof kind !== "string" || !kind) throw new TypeError("contentRenderer.register requires a kind");
    if (typeof renderer !== "function") throw new TypeError(`contentRenderer.register requires a function for ${kind}`);
    if (registry.has(kind)) throw new TypeError(`contentRenderer already has a renderer for kind: ${kind}`);
    registry.set(kind, renderer);
    return kind;
  }

  function has(kind) { return registry.has(kind); }
  function registeredKinds() { return Object.freeze(Array.from(registry.keys()).sort()); }

  function renderBlock(block, context) {
    if (!block || typeof block !== "object") throw new TypeError("contentRenderer.renderBlock requires a block object");
    const renderer = registry.get(block.kind);
    if (!renderer) throw new TypeError(`contentRenderer: no renderer registered for kind: ${block.kind || "<empty>"}`);
    return renderer(block, context || {});
  }

  function renderBlocks(blocks, context) {
    const doc = resolveDocument(context);
    const fragment = doc.createDocumentFragment();
    if (!Array.isArray(blocks)) throw new TypeError("contentRenderer.renderBlocks requires an array of blocks");
    for (const block of blocks) fragment.appendChild(renderBlock(block, context || {}));
    return fragment;
  }

  /* ---------------------------------------------------------- core renderers */

  register("text", (block, context) => applyMarks(textNode(context, block.text), block.marks, context));

  register("hardBreak", (block, context) => el(context, "br"));
  register("thematicBreak", (block, context) => el(context, "hr"));

  register("paragraph", (block, context) => appendInline(el(context, "p"), block.children, context));

  register("heading", (block, context) => {
    const level = Number.isInteger(block.level) && block.level >= 1 && block.level <= 6 ? block.level : 1;
    return appendInline(el(context, `h${level}`), block.children, context);
  });

  register("blockquote", (block, context) => appendBlocks(el(context, "blockquote"), block.blocks, context));

  register("list", (block, context) => {
    const ordered = block.ordered === true;
    const list = el(context, ordered ? "ol" : "ul");
    /* Only surface an explicit start; the native default stays otherwise. */
    if (ordered && Number.isInteger(block.start) && block.start !== 1) list.setAttribute("start", String(block.start));
    const items = Array.isArray(block.items) ? block.items : [];
    for (const item of items) list.appendChild(renderBlock(item, context));
    return list;
  });

  register("listItem", (block, context) => {
    const item = el(context, "li");
    /* Task state is descriptive, not an actionable control: a real text marker
     * keeps it accessible without creating a checkbox. */
    if (typeof block.checked === "boolean") {
      item.setAttribute("data-h2o-task", block.checked ? "checked" : "unchecked");
      const marker = el(context, "span");
      marker.setAttribute("data-h2o-task-marker", "");
      marker.appendChild(textNode(context, block.checked ? "☑ " : "☐ "));
      item.appendChild(marker);
    }
    return appendBlocks(item, block.blocks, context);
  });

  register("codeBlock", (block, context) => {
    /* Preserves the established wbCodeBlock / wbCodeLang visual convention. */
    const wrap = el(context, "div");
    wrap.className = "wbCodeBlock";
    const language = asText(block.language).trim();
    if (language) {
      const badge = el(context, "div");
      badge.className = "wbCodeLang";
      badge.appendChild(textNode(context, language));
      wrap.appendChild(badge);
    }
    const pre = el(context, "pre");
    const code = el(context, "code");
    code.appendChild(textNode(context, block.code));
    pre.appendChild(code);
    wrap.appendChild(pre);
    return wrap;
  });

  register("tableCell", (block, context) => {
    const cell = el(context, block.header === true ? "th" : "td");
    if (block.header === true) cell.setAttribute("scope", "col");
    const align = ALIGNMENTS.indexOf(block.align) === -1 ? null : block.align;
    if (align) cell.style.textAlign = align;
    return appendBlocks(cell, block.blocks, context);
  });

  register("tableRow", (block, context) => {
    const row = el(context, "tr");
    const cells = Array.isArray(block.cells) ? block.cells : [];
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i];
      row.appendChild(renderBlock({
        ...cell,
        header: cell.header === true || block.header === true,
        align: cell.align || alignmentOf(block.align, i),
      }, context));
    }
    return row;
  });

  register("table", (block, context) => {
    const table = el(context, "table");
    const rows = Array.isArray(block.rows) ? block.rows : [];
    let head = null;
    let body = null;
    for (const row of rows) {
      const rendered = renderBlock({ ...row, align: row.align || block.align }, context);
      if (row.header === true) {
        if (!head) { head = el(context, "thead"); table.appendChild(head); }
        head.appendChild(rendered);
      } else {
        if (!body) { body = el(context, "tbody"); table.appendChild(body); }
        body.appendChild(rendered);
      }
    }
    return table;
  });

  register("image", (block, context) => {
    const decision = classify(context, block.src, "image");
    if (decision.ok === true) {
      const img = el(context, "img");
      img.setAttribute("src", asText(block.src));
      img.setAttribute("alt", asText(block.alt));
      if (block.title) img.setAttribute("title", asText(block.title));
      if (Number.isInteger(block.width) && block.width > 0) img.setAttribute("width", String(block.width));
      if (Number.isInteger(block.height) && block.height > 0) img.setAttribute("height", String(block.height));
      return img;
    }
    /* Denied: never start a resource load. Degrade to the truthful alt text. */
    const denied = el(context, "span");
    denied.setAttribute("data-h2o-image-denied", asText(decision.reason || "denied"));
    denied.appendChild(textNode(context, asText(block.alt || block.title || block.src)));
    return denied;
  });

  register("file", (block, context) => {
    /* Smallest representation the current IR payload supports: an admitted
     * destination becomes a link, anything else stays as its label text. */
    const label = asText(block.name || block.alt || block.text || block.href || block.src);
    const href = block.href || block.src;
    if (href) {
      const decision = classify(context, href, "link");
      if (decision.ok === true) {
        const anchor = el(context, "a");
        anchor.setAttribute("href", asText(href));
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer");
        anchor.appendChild(textNode(context, label));
        return anchor;
      }
      const denied = el(context, "span");
      denied.setAttribute("data-h2o-link-denied", asText(decision.reason || "denied"));
      denied.appendChild(textNode(context, label));
      return denied;
    }
    const span = el(context, "span");
    span.appendChild(textNode(context, label));
    return span;
  });

  Renderer.contentRenderer = Object.freeze({
    __installed: true,
    __version: API_VERSION,
    coreKinds: CORE_KINDS,
    extensionKinds: RESERVED_EXTENSION_KINDS,
    register,
    has,
    registeredKinds,
    renderBlock,
    renderBlocks,
  });
})(typeof window !== "undefined" ? window : globalThis);
