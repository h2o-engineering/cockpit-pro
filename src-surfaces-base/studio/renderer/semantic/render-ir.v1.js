// @version 0.1.0-m03-foundation
"use strict";

/*
 * H2O Studio Renderer — transient Render IR v1 foundation.
 *
 * Authority boundary:
 *   owner-defined semantic content -> transient Renderer IR -> visual projection
 *
 * This module does NOT parse Markdown, sanitize HTML, own durable semantic IDs,
 * persist data, control Reader navigation, or define provider presentation.
 * Durable content/block identity remains with the owning semantic domain. The
 * Renderer only derives deterministic projection-local render keys.
 */
(function installRendererRenderIR(global) {
  const H2O = global.H2O = global.H2O || {};
  const Studio = H2O.Studio = H2O.Studio || {};
  const Renderer = Studio.Renderer = Studio.Renderer || {};
  if (Renderer.renderIR && Renderer.renderIR.__installed) return;

  const SCHEMA = "h2o.renderer.render-ir";
  const SCHEMA_VERSION = 1;
  const API_VERSION = "0.1.0-m03-foundation";

  const ROLES = Object.freeze(["user", "assistant", "system", "tool"]);
  const ROLE_SET = new Set(ROLES);

  const CORE_BLOCK_KINDS = Object.freeze([
    "paragraph",
    "heading",
    "text",
    "list",
    "listItem",
    "blockquote",
    "codeBlock",
    "table",
    "tableRow",
    "tableCell",
    "image",
    "file",
    "math",
    "citation",
    "toolCall",
    "toolResult",
    "artifact",
    "opaqueProviderBlock",
  ]);
  const BLOCK_KIND_SET = new Set(CORE_BLOCK_KINDS);

  const CORE_MARK_KINDS = Object.freeze([
    "strong",
    "emphasis",
    "code",
    "strikethrough",
    "link",
  ]);
  const MARK_KIND_SET = new Set(CORE_MARK_KINDS);

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.prototype.toString.call(value) === "[object Object]";
  }

  function asString(value) {
    return value == null ? "" : String(value);
  }

  function normalizeRole(value) {
    const role = asString(value).trim().toLowerCase();
    return ROLE_SET.has(role) ? role : "";
  }

  function normalizeDirection(value) {
    const dir = asString(value).trim().toLowerCase();
    return dir === "ltr" || dir === "rtl" ? dir : "auto";
  }

  function stableHash(value) {
    const text = asString(value);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function makeRenderKey(namespace, ownerRef, ordinal) {
    const ns = asString(namespace).trim() || "node";
    const owner = asString(ownerRef).trim();
    if (owner) return `${ns}:owner:${stableHash(owner)}`;
    const n = Number.isInteger(ordinal) && ordinal >= 0 ? ordinal : 0;
    return `${ns}:ordinal:${n}`;
  }

  function normalizeOwnerRef(input) {
    if (input == null || input === "") return null;
    if (typeof input === "string" || typeof input === "number") return asString(input);
    if (!isPlainObject(input)) return null;

    const out = {};
    for (const key of ["type", "id", "version", "anchor", "provider", "namespace"]) {
      if (input[key] != null && input[key] !== "") out[key] = input[key];
    }
    return Object.keys(out).length ? out : null;
  }

  function extractOwnerRef(input) {
    if (!isPlainObject(input)) return null;
    return normalizeOwnerRef(
      input.ownerRef
      ?? input.semanticRef
      ?? input.contentBlockRef
      ?? input.contentBlockId
      ?? input.messageRef
      ?? input.messageId
      ?? input.id
      ?? null
    );
  }

  function clonePayload(input, excluded) {
    if (!isPlainObject(input)) return {};
    const out = {};
    const skip = new Set(excluded || []);
    for (const [key, value] of Object.entries(input)) {
      if (skip.has(key)) continue;
      out[key] = value;
    }
    return out;
  }

  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
  }

  function createMark(input) {
    const source = isPlainObject(input) ? input : { kind: input };
    const kind = asString(source.kind).trim();
    if (!MARK_KIND_SET.has(kind)) throw new TypeError(`Unsupported Render IR mark kind: ${kind || "<empty>"}`);

    const out = {
      kind,
      ...clonePayload(source, ["kind"]),
    };
    return deepFreeze(out);
  }

  function createBlock(input, context = {}) {
    if (!isPlainObject(input)) throw new TypeError("Render IR block must be an object");
    const kind = asString(input.kind || input.type).trim();
    if (!BLOCK_KIND_SET.has(kind)) throw new TypeError(`Unsupported Render IR block kind: ${kind || "<empty>"}`);

    const ordinal = Number.isInteger(context.ordinal) ? context.ordinal : 0;
    const messageKey = asString(context.messageKey).trim() || "message:unknown";
    const ownerRef = extractOwnerRef(input);
    const renderKey = asString(input.renderKey).trim()
      || makeRenderKey(`${messageKey}:block`, ownerRef ? JSON.stringify(ownerRef) : "", ordinal);

    const out = {
      kind,
      renderKey,
      ownerRef,
      ...clonePayload(input, [
        "kind", "type", "renderKey", "ownerRef", "semanticRef",
        "contentBlockRef", "contentBlockId", "messageRef", "messageId", "id",
      ]),
    };

    if (Array.isArray(out.marks)) out.marks = out.marks.map(createMark);
    if (Array.isArray(out.children)) {
      out.children = out.children.map((child, index) => createBlock(child, {
        messageKey,
        ordinal: (ordinal * 1000) + index + 1,
      }));
    }
    if (Array.isArray(out.blocks)) {
      out.blocks = out.blocks.map((child, index) => createBlock(child, {
        messageKey,
        ordinal: (ordinal * 1000) + index + 1,
      }));
    }
    if (Array.isArray(out.items)) {
      out.items = out.items.map((child, index) => createBlock(
        isPlainObject(child) && child.kind ? child : { kind: "listItem", blocks: Array.isArray(child) ? child : [] },
        { messageKey, ordinal: (ordinal * 1000) + index + 1 }
      ));
    }
    if (Array.isArray(out.rows)) {
      out.rows = out.rows.map((child, index) => createBlock(
        isPlainObject(child) && child.kind ? child : { kind: "tableRow", cells: Array.isArray(child) ? child : [] },
        { messageKey, ordinal: (ordinal * 1000) + index + 1 }
      ));
    }
    if (Array.isArray(out.cells)) {
      out.cells = out.cells.map((child, index) => createBlock(
        isPlainObject(child) && child.kind ? child : { kind: "tableCell", blocks: Array.isArray(child) ? child : [] },
        { messageKey, ordinal: (ordinal * 1000) + index + 1 }
      ));
    }

    return deepFreeze(out);
  }

  function createMessage(input, index = 0) {
    if (!isPlainObject(input)) throw new TypeError("Render IR message must be an object");
    const role = normalizeRole(input.role);
    if (!role) throw new TypeError(`Unsupported Render IR role: ${asString(input.role) || "<empty>"}`);

    const ownerRef = extractOwnerRef(input);
    const renderKey = asString(input.renderKey).trim()
      || makeRenderKey("message", ownerRef ? JSON.stringify(ownerRef) : "", index);
    const blocks = Array.isArray(input.blocks)
      ? input.blocks.map((block, blockIndex) => createBlock(block, { messageKey: renderKey, ordinal: blockIndex }))
      : [];

    return deepFreeze({
      renderKey,
      ownerRef,
      role,
      dir: normalizeDirection(input.dir),
      blocks,
    });
  }

  function createConversation(input = {}) {
    if (!isPlainObject(input)) throw new TypeError("Render IR conversation input must be an object");
    const ownerRef = extractOwnerRef(input);
    const messages = Array.isArray(input.messages)
      ? input.messages.map((message, index) => createMessage(message, index))
      : [];

    return deepFreeze({
      schema: SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      transient: true,
      ownerRef,
      renderKey: asString(input.renderKey).trim()
        || makeRenderKey("conversation", ownerRef ? JSON.stringify(ownerRef) : "", 0),
      messages,
    });
  }

  function validate(ir) {
    const errors = [];
    if (!isPlainObject(ir)) return { ok: false, errors: ["Render IR must be an object"] };
    if (ir.schema !== SCHEMA) errors.push(`schema must be ${SCHEMA}`);
    if (ir.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
    if (ir.transient !== true) errors.push("Render IR must be explicitly transient");
    if (!Array.isArray(ir.messages)) errors.push("messages must be an array");

    const seen = new Set();
    function noteKey(key, label) {
      const value = asString(key).trim();
      if (!value) errors.push(`${label} renderKey is required`);
      else if (seen.has(value)) errors.push(`duplicate renderKey: ${value}`);
      else seen.add(value);
    }

    function visitBlock(block, path) {
      if (!isPlainObject(block)) {
        errors.push(`${path} must be an object`);
        return;
      }
      if (!BLOCK_KIND_SET.has(block.kind)) errors.push(`${path}.kind is unsupported: ${asString(block.kind)}`);
      noteKey(block.renderKey, path);
      if (Object.prototype.hasOwnProperty.call(block, "contentBlockId")) {
        errors.push(`${path} must not expose Renderer-owned contentBlockId`);
      }
      if (block.kind === "text" && typeof block.text !== "string") errors.push(`${path}.text must be a string`);
      if (block.kind === "heading" && (!Number.isInteger(block.level) || block.level < 1 || block.level > 6)) {
        errors.push(`${path}.level must be an integer from 1 to 6`);
      }
      if (Array.isArray(block.marks)) {
        for (let i = 0; i < block.marks.length; i += 1) {
          if (!MARK_KIND_SET.has(block.marks[i]?.kind)) errors.push(`${path}.marks[${i}].kind is unsupported`);
        }
      }
      for (const collection of ["children", "blocks", "items", "rows", "cells"]) {
        if (!Array.isArray(block[collection])) continue;
        for (let i = 0; i < block[collection].length; i += 1) {
          visitBlock(block[collection][i], `${path}.${collection}[${i}]`);
        }
      }
    }

    if (Array.isArray(ir.messages)) {
      for (let i = 0; i < ir.messages.length; i += 1) {
        const message = ir.messages[i];
        const path = `messages[${i}]`;
        if (!isPlainObject(message)) {
          errors.push(`${path} must be an object`);
          continue;
        }
        noteKey(message.renderKey, path);
        if (!ROLE_SET.has(message.role)) errors.push(`${path}.role is unsupported: ${asString(message.role)}`);
        if (!Array.isArray(message.blocks)) errors.push(`${path}.blocks must be an array`);
        else for (let j = 0; j < message.blocks.length; j += 1) visitBlock(message.blocks[j], `${path}.blocks[${j}]`);
      }
    }

    return { ok: errors.length === 0, errors };
  }

  Renderer.renderIR = Object.freeze({
    __installed: true,
    __version: API_VERSION,
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    roles: ROLES,
    blockKinds: CORE_BLOCK_KINDS,
    markKinds: CORE_MARK_KINDS,
    makeRenderKey,
    createMark,
    createBlock,
    createMessage,
    createConversation,
    validate,
  });
})(typeof window !== "undefined" ? window : globalThis);
