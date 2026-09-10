// @version 0.1.0-m03-p2-s1
"use strict";

/*
 * Markdown -> Render IR semantic adapter (M03 P2 S2A T4 S1).
 *
 * markdown-it tokens are a transient engine representation. They are mapped
 * straight into Render IR; no second durable AST is created and no engine token
 * shape leaks into the IR.
 *
 * This module emits no HTML string, touches no DOM, calls no sanitizer, and
 * makes no URL admission decision. A destination reaches the IR exactly as the
 * parser's syntax produced it, as inert data. The S2B sink, through
 * sanitizerPolicy.classifyUrl, decides whether it may ever become live.
 */
(function (global) {
  const H2O = global.H2O = global.H2O || {};
  const Studio = H2O.Studio = H2O.Studio || {};
  const Renderer = Studio.Renderer = Studio.Renderer || {};

  /* Formal task-list marker, only at the first inline position of a list item. */
  const TASK_MARKER = /^\[([ xX])\]\s/;
  /* Exactly the engine-generated closed forms; no CSS parsing. */
  const ALIGN_BY_STYLE = Object.freeze({
    "text-align:left": "left",
    "text-align:center": "center",
    "text-align:right": "right",
  });

  function markKindFor(type) {
    if (type === "strong_open") return "strong";
    if (type === "em_open") return "emphasis";
    if (type === "s_open") return "strikethrough";
    return "";
  }

  function withMarks(node, marks) {
    if (!marks.length) return node;
    return { ...node, marks: marks.map((m) => ({ ...m })) };
  }

  /* Inline tokens -> IR inline children, preserving mark nesting without HTML. */
  function inlineChildren(tokens) {
    const out = [];
    const marks = [];
    const pushText = (text, extra) => {
      if (!text) return;
      const last = out[out.length - 1];
      const nextMarks = extra ? marks.concat(extra) : marks;
      if (!extra && last && last.kind === "text" && JSON.stringify(last.marks || []) === JSON.stringify(nextMarks)) {
        last.text += text;
        return;
      }
      out.push(withMarks({ kind: "text", text }, nextMarks));
    };

    for (const t of tokens || []) {
      switch (t.type) {
        case "text":
          pushText(t.content);
          break;
        case "text_special":
          pushText(t.content);
          break;
        case "softbreak":
          /* A soft break joins inline content; it is never a hardBreak. */
          pushText("\n");
          break;
        case "hardbreak":
          out.push({ kind: "hardBreak" });
          break;
        case "code_inline":
          pushText(t.content, [{ kind: "code" }]);
          break;
        case "strong_open":
        case "em_open":
        case "s_open":
          marks.push({ kind: markKindFor(t.type) });
          break;
        case "strong_close":
        case "em_close":
        case "s_close":
          marks.pop();
          break;
        case "link_open": {
          const href = t.attrGet ? t.attrGet("href") : null;
          const title = t.attrGet ? t.attrGet("title") : null;
          const mark = { kind: "link", href: href == null ? "" : href };
          if (title) mark.title = title;
          marks.push(mark);
          break;
        }
        case "link_close":
          marks.pop();
          break;
        case "image": {
          const src = t.attrGet ? t.attrGet("src") : null;
          const title = t.attrGet ? t.attrGet("title") : null;
          const node = { kind: "image", src: src == null ? "" : src, alt: t.content == null ? "" : t.content };
          if (title) node.title = title;
          out.push(withMarks(node, marks));
          break;
        }
        default:
          /* html_inline cannot occur with html:false; anything unmapped that
           * still carries content is preserved verbatim rather than dropped. */
          if (t.content) pushText(t.content);
          break;
      }
    }
    return out;
  }

  /*
   * Bounded task-list normalization. Applied only to the first inline semantic
   * position of a list item, never to arbitrary paragraphs or every text token.
   * On a match the state is projected onto the listItem and the marker plus its
   * required following whitespace is removed from the visible content.
   */
  function extractTaskState(blocks) {
    const first = blocks[0];
    if (!first || first.kind !== "paragraph" || !Array.isArray(first.children)) return null;
    const firstChild = first.children[0];
    if (!firstChild || firstChild.kind !== "text" || firstChild.marks) return null;
    const m = TASK_MARKER.exec(firstChild.text);
    if (!m) return null;
    firstChild.text = firstChild.text.slice(m[0].length);
    if (!firstChild.text) first.children.shift();
    return m[1] === "x" || m[1] === "X";
  }

  function alignFromToken(token) {
    const style = token && token.attrGet ? token.attrGet("style") : null;
    if (!style) return null;
    const key = String(style).replace(/\s+/g, "").replace(/;$/, "");
    return Object.prototype.hasOwnProperty.call(ALIGN_BY_STYLE, key) ? ALIGN_BY_STYLE[key] : null;
  }

  /* Recursive descent over the flat token stream. */
  function blocksFrom(tokens, start, endType, ctx) {
    const out = [];
    let i = start;
    while (i < tokens.length) {
      const t = tokens[i];
      if (endType && t.type === endType) return { blocks: out, next: i + 1 };

      switch (t.type) {
        case "paragraph_open": {
          const inline = tokens[i + 1];
          const children = inline && inline.type === "inline" ? inlineChildren(inline.children) : [];
          if (t.hidden) ctx.tight = true;
          out.push({ kind: "paragraph", children });
          i += 3;
          break;
        }
        case "heading_open": {
          const inline = tokens[i + 1];
          const level = Number(String(t.tag || "h1").slice(1)) || 1;
          out.push({ kind: "heading", level, children: inline && inline.type === "inline" ? inlineChildren(inline.children) : [] });
          i += 3;
          break;
        }
        case "hr":
          out.push({ kind: "thematicBreak" });
          i += 1;
          break;
        case "fence":
        case "code_block": {
          const info = String(t.info || "").trim();
          const node = { kind: "codeBlock", code: t.content == null ? "" : t.content };
          const language = info.split(/\s+/)[0] || "";
          if (language) node.language = language;
          if (info) node.info = info;
          out.push(node);
          i += 1;
          break;
        }
        case "blockquote_open": {
          const inner = blocksFrom(tokens, i + 1, "blockquote_close", { tight: false });
          out.push({ kind: "blockquote", blocks: inner.blocks });
          i = inner.next;
          break;
        }
        case "bullet_list_open":
        case "ordered_list_open": {
          const ordered = t.type === "ordered_list_open";
          const listCtx = { tight: false };
          const items = [];
          let j = i + 1;
          while (j < tokens.length && tokens[j].type !== (ordered ? "ordered_list_close" : "bullet_list_close")) {
            if (tokens[j].type === "list_item_open") {
              const inner = blocksFrom(tokens, j + 1, "list_item_close", listCtx);
              const item = { kind: "listItem", blocks: inner.blocks };
              const checked = extractTaskState(inner.blocks);
              if (checked !== null) item.checked = checked;
              items.push(item);
              j = inner.next;
              continue;
            }
            j += 1;
          }
          const node = { kind: "list", ordered, tight: listCtx.tight === true, items };
          if (ordered) {
            const start = t.attrGet ? t.attrGet("start") : null;
            if (start != null && Number(start) !== 1) node.start = Number(start);
          }
          out.push(node);
          i = j + 1;
          break;
        }
        case "table_open": {
          const align = [];
          const rows = [];
          let j = i + 1;
          let header = false;
          while (j < tokens.length && tokens[j].type !== "table_close") {
            const tok = tokens[j];
            if (tok.type === "thead_open") { header = true; j += 1; continue; }
            if (tok.type === "thead_close") { header = false; j += 1; continue; }
            if (tok.type === "tr_open") {
              const cells = [];
              let k = j + 1;
              let col = 0;
              while (k < tokens.length && tokens[k].type !== "tr_close") {
                const cell = tokens[k];
                if (cell.type === "th_open" || cell.type === "td_open") {
                  if (header) align[col] = alignFromToken(cell);
                  const inline = tokens[k + 1];
                  const children = inline && inline.type === "inline" ? inlineChildren(inline.children) : [];
                  cells.push({ kind: "tableCell", blocks: children.length ? [{ kind: "paragraph", children }] : [] });
                  col += 1;
                  k += 3;
                  continue;
                }
                k += 1;
              }
              rows.push({ kind: "tableRow", header, cells });
              j = k + 1;
              continue;
            }
            j += 1;
          }
          /* Ragged GFM rows normalize to the header width: short rows pad with
           * empty cells, extra cells beyond the header are discarded. */
          const width = align.length || (rows[0] ? rows[0].cells.length : 0);
          for (const row of rows) {
            if (row.cells.length > width) row.cells.length = width;
            while (row.cells.length < width) row.cells.push({ kind: "tableCell", blocks: [] });
          }
          while (align.length < width) align.push(null);
          out.push({ kind: "table", align, rows });
          i = j + 1;
          break;
        }
        case "inline": {
          out.push({ kind: "paragraph", children: inlineChildren(t.children) });
          i += 1;
          break;
        }
        default:
          i += 1;
          break;
      }
    }
    return { blocks: out, next: i };
  }

  /* Deterministic whole-message verbatim fallback: the author's characters are
   * never lost, and there is never a partial or legacy-parser result. */
  function verbatimBlocks(source) {
    const text = String(source == null ? "" : source).replace(/\r\n?/g, "\n");
    return [{ kind: "paragraph", children: text ? [{ kind: "text", text }] : [] }];
  }

  function markdownToBlocks(md, source) {
    const text = String(source == null ? "" : source);
    try {
      if (!md || typeof md.parse !== "function") throw new Error("engine unavailable");
      const tokens = md.parse(text, {});
      const result = blocksFrom(tokens, 0, null, { tight: false });
      return { blocks: result.blocks, fallback: false };
    } catch (error) {
      return { blocks: verbatimBlocks(text), fallback: true, reason: String((error && error.message) || error) };
    }
  }

  const api = Object.freeze({
    __version: "0.1.0-m03-p2-s1",
    markdownToBlocks,
    verbatimBlocks,
  });

  Renderer.markdownIrAdapter = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
