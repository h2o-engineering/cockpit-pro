// @version 0.1.0-m03-foundation
"use strict";

/*
 * H2O Studio Renderer — owner-defined semantic ingress v1.
 *
 * Authority boundary:
 *   owner-defined content -> Renderer semantic ingress -> transient Render IR v1
 *
 * This module adapts two owner-defined inputs into the existing Render IR v1
 * contract published by render-ir.v1.js:
 *
 *   A. the current Renderer-normalized Studio snapshot/message shape;
 *   B. Saved-Chat v3 typed message content[] (Storage-owned input semantics).
 *
 * It does NOT parse Markdown, sanitize HTML, touch the DOM, persist anything,
 * write Storage, or mint durable semantic identity. Durable content/block
 * identity (contentBlockId, ItemRef, VersionRef, Anchor) stays with its owning
 * domain and is carried here only as an opaque owner reference. Render keys are
 * derived by Render IR v1 and remain projection-local and transient.
 *
 * Provider replay markup is never a semantic source for this layer: only
 * owner-defined semantic fields are read.
 */
(function installRendererSemanticIngress(global) {
  const H2O = global.H2O = global.H2O || {};
  const Studio = H2O.Studio = H2O.Studio || {};
  const Renderer = Studio.Renderer = Studio.Renderer || {};
  if (Renderer.semanticIngress && Renderer.semanticIngress.__installed) return;

  const renderIR = Renderer.renderIR;
  if (!renderIR || !renderIR.__installed) {
    throw new Error("semantic-ingress: requires H2O.Studio.Renderer.renderIR (render-ir.v1.js) to be installed first");
  }

  const SCHEMA = "h2o.renderer.semantic-ingress";
  const SCHEMA_VERSION = 1;
  const API_VERSION = "0.1.0-m03-foundation";

  /* Owner-defined source kinds this ingress layer accepts. */
  const SOURCE_NORMALIZED_STUDIO = "normalizedStudioSnapshot";
  const SOURCE_SAVED_CHAT_V3 = "savedChatSnapshotV3";

  /* Saved-Chat v3 normative snapshot identity (Storage-owned, read-only here). */
  const V3_SNAPSHOT_SCHEMA = "h2o.savedChatSnapshot";
  const V3_SNAPSHOT_VERSION = 3;

  /* Saved-Chat v3 content[] part types this layer represents semantically. */
  const V3_CONTENT_TEXT = "text";
  const V3_CONTENT_HTML = "html";
  const SUPPORTED_V3_CONTENT_TYPES = Object.freeze([V3_CONTENT_TEXT, V3_CONTENT_HTML]);

  /*
   * Render IR v1 exposes exactly one opaque extension point:
   * `opaqueProviderBlock`. T3 does not decompose HTML into semantic blocks (that
   * is later Mission work), so owner-sanitized HTML is genuinely opaque to the
   * Renderer today. `opaqueKind` keeps the two controlled opaque cases distinct
   * and prevents either from being mistaken for provider DOM, which this layer
   * never ingests.
   */
  const OPAQUE_OWNER_SANITIZED_HTML = "ownerSanitizedHtml";
  const OPAQUE_UNSUPPORTED_OWNER_CONTENT = "unsupportedOwnerContent";
  const OPAQUE_KINDS = Object.freeze({
    OWNER_SANITIZED_HTML: OPAQUE_OWNER_SANITIZED_HTML,
    UNSUPPORTED_OWNER_CONTENT: OPAQUE_UNSUPPORTED_OWNER_CONTENT,
  });

  const HTML_MEDIA_TYPE = "text/html";

  const CANONICAL_ROLES = new Set(renderIR.roles);

  function fail(message) {
    throw new TypeError(`semantic-ingress: ${message}`);
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.prototype.toString.call(value) === "[object Object]";
  }

  function asString(value) {
    return value == null ? "" : String(value);
  }

  function trimmed(value) {
    return asString(value).trim();
  }

  /*
   * Owner payloads are copied into the IR, which accepts JSON-like data only.
   * Non-JSON-like values (functions, symbols, class instances, undefined) are
   * dropped rather than coerced, so no owner value is silently reinterpreted.
   */
  function jsonSafe(value) {
    if (value === null) return null;
    const type = typeof value;
    if (type === "string" || type === "number" || type === "boolean") return value;
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) {
        const safe = jsonSafe(item);
        if (safe !== undefined) out.push(safe);
      }
      return out;
    }
    if (isPlainObject(value)) {
      const out = {};
      for (const [key, child] of Object.entries(value)) {
        const safe = jsonSafe(child);
        if (safe !== undefined) out[key] = safe;
      }
      return out;
    }
    return undefined;
  }

  function requireObject(value, label) {
    if (!isPlainObject(value)) fail(`${label} must be an object`);
    return value;
  }

  /*
   * Fail closed on any role outside the four canonical transcript roles. An
   * unknown role is never coerced to assistant.
   */
  function requireCanonicalRole(value, label) {
    const role = trimmed(value).toLowerCase();
    if (!CANONICAL_ROLES.has(role)) {
      fail(`${label} has an unsupported role: ${trimmed(value) || "<empty>"}`);
    }
    return role;
  }

  /*
   * Owner-issued identity is preserved as a reference only. Nothing here is a
   * Renderer-owned durable ID; Render IR strips durable identity keys from block
   * payloads and derives projection-local render keys separately.
   */
  function ownerReference(type, id, version, anchor) {
    const ref = { type };
    if (trimmed(id)) ref.id = trimmed(id);
    if (trimmed(version)) ref.version = trimmed(version);
    if (trimmed(anchor)) ref.anchor = trimmed(anchor);
    return ref.id || ref.version || ref.anchor ? ref : null;
  }

  /* ---- A. current Renderer-normalized Studio input --------------------- */

  function imageBlockFromNormalizedAttachment(attachment, label) {
    const source = requireObject(attachment, label);
    const block = { kind: "image" };
    const src = trimmed(source.originalSrc) || trimmed(source.thumbnailSrc);
    if (src) block.src = src;
    if (trimmed(source.thumbnailSrc)) block.thumbnailSrc = trimmed(source.thumbnailSrc);
    if (typeof source.alt === "string") block.alt = source.alt;
    if (Number.isFinite(Number(source.width)) && Number(source.width) > 0) block.width = Number(source.width);
    if (Number.isFinite(Number(source.height)) && Number(source.height) > 0) block.height = Number(source.height);
    if (trimmed(source.captureStatus)) block.captureStatus = trimmed(source.captureStatus);
    return block;
  }

  /*
   * The current normalized message carries a single plain-text body. It becomes
   * one paragraph of semantic text; the string is preserved verbatim because
   * structural inference (Markdown/HTML parsing) is out of scope for T3. Empty
   * text contributes no block. Owner attachments follow in their owner order.
   */
  function messageFromNormalizedStudio(row, index) {
    const label = `normalized message[${index}]`;
    const source = requireObject(row, label);
    const role = requireCanonicalRole(source.role, label);

    const blocks = [];
    const text = asString(source.text);
    if (text) blocks.push({ kind: "paragraph", children: [{ kind: "text", text }] });

    const attachments = Array.isArray(source.attachments) ? source.attachments : [];
    for (let i = 0; i < attachments.length; i += 1) {
      blocks.push(imageBlockFromNormalizedAttachment(attachments[i], `${label}.attachments[${i}]`));
    }

    return {
      role,
      dir: source.dir,
      ownerRef: ownerReference("h2o.studio.message", source.messageId, "", source.turnId),
      blocks,
    };
  }

  function fromNormalizedStudioSnapshot(snapshot) {
    const source = requireObject(snapshot, "normalized snapshot");
    const rows = Array.isArray(source.messages) ? source.messages : [];
    return renderIR.createConversation({
      ownerRef: ownerReference("h2o.studio.chatSnapshot", source.chatId, source.snapshotId, ""),
      messages: rows.map(messageFromNormalizedStudio),
    });
  }

  /* ---- B. Saved-Chat v3 typed content[] -------------------------------- */

  /*
   * One owner content part maps to exactly one IR block, so multipart order and
   * part count are preserved verbatim.
   */
  function blockFromV3ContentPart(part, index, label) {
    const partLabel = `${label}.content[${index}]`;
    const source = requireObject(part, partLabel);
    const type = trimmed(source.type);

    if (type === V3_CONTENT_TEXT) {
      if (typeof source.text !== "string") fail(`${partLabel} text part must carry a string text`);
      return { kind: "paragraph", children: [{ kind: "text", text: source.text }] };
    }

    if (type === V3_CONTENT_HTML) {
      if (typeof source.html !== "string") fail(`${partLabel} html part must carry a string html`);
      /*
       * The owning Storage contract refuses an HTML part not marked sanitized.
       * This layer refuses it too rather than promoting untrusted markup to
       * trusted semantic content. The shared sanitizer is not invoked, replaced
       * or weakened here; sanitizer-v2 remains separate Mission work.
       */
      if (source.sanitized !== true) {
        fail(`${partLabel} html part is not marked sanitized by its owner`);
      }
      return {
        kind: "opaqueProviderBlock",
        opaqueKind: OPAQUE_OWNER_SANITIZED_HTML,
        mediaType: HTML_MEDIA_TYPE,
        ownerSanitized: true,
        html: source.html,
      };
    }

    /*
     * Controlled unsupported-content policy: preserve the owner part as opaque
     * data, name the owner type, and claim no semantic support for it. Nothing
     * is discarded and nothing bypasses Render IR validation.
     */
    return {
      kind: "opaqueProviderBlock",
      opaqueKind: OPAQUE_UNSUPPORTED_OWNER_CONTENT,
      ownerContentType: type || "<empty>",
      ownerContent: jsonSafe(source) || {},
    };
  }

  function messageFromSavedChatV3(message, index) {
    const label = `v3 message[${index}]`;
    const source = requireObject(message, label);
    const role = requireCanonicalRole(source.role, label);

    if (!Array.isArray(source.content)) fail(`${label} must carry a typed content[] array`);
    /* v3 removed the duplicated scalar bodies; their presence means this is not
     * a conforming v3 message and must not be read through a legacy path. */
    if (source.contentText !== undefined || source.contentHtml !== undefined) {
      fail(`${label} carries legacy scalar content forbidden by Saved-Chat v3`);
    }

    return {
      role,
      dir: source.dir,
      ownerRef: ownerReference("h2o.savedChat.message", source.id, "", source.parentId),
      blocks: source.content.map((part, partIndex) => blockFromV3ContentPart(part, partIndex, label)),
    };
  }

  function fromSavedChatV3Snapshot(snapshot) {
    const source = requireObject(snapshot, "Saved-Chat v3 snapshot");
    if (trimmed(source.schema) !== V3_SNAPSHOT_SCHEMA) {
      fail(`Saved-Chat v3 snapshot schema must be ${V3_SNAPSHOT_SCHEMA}`);
    }
    if (source.schemaVersion !== V3_SNAPSHOT_VERSION) {
      fail(`Saved-Chat v3 snapshot schemaVersion must be ${V3_SNAPSHOT_VERSION}`);
    }
    const rows = Array.isArray(source.messages) ? source.messages : [];
    return renderIR.createConversation({
      ownerRef: ownerReference("h2o.savedChat.snapshot", source.chatId, source.snapshotId, ""),
      messages: rows.map(messageFromSavedChatV3),
    });
  }

  /* ---- dispatch --------------------------------------------------------- */

  function detectSourceKind(input) {
    if (!isPlainObject(input)) return "";
    if (trimmed(input.schema) === V3_SNAPSHOT_SCHEMA) return SOURCE_SAVED_CHAT_V3;
    if (Array.isArray(input.messages)) return SOURCE_NORMALIZED_STUDIO;
    return "";
  }

  function fromSource(input, sourceKind) {
    const kind = trimmed(sourceKind) || detectSourceKind(input);
    if (kind === SOURCE_NORMALIZED_STUDIO) return fromNormalizedStudioSnapshot(input);
    if (kind === SOURCE_SAVED_CHAT_V3) return fromSavedChatV3Snapshot(input);
    fail(`unrecognized owner source kind: ${trimmed(sourceKind) || "<undetected>"}`);
  }

  Renderer.semanticIngress = Object.freeze({
    __installed: true,
    __version: API_VERSION,
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    sourceKinds: Object.freeze({
      NORMALIZED_STUDIO: SOURCE_NORMALIZED_STUDIO,
      SAVED_CHAT_V3: SOURCE_SAVED_CHAT_V3,
    }),
    supportedV3ContentTypes: SUPPORTED_V3_CONTENT_TYPES,
    opaqueKinds: OPAQUE_KINDS,
    detectSourceKind,
    fromSource,
    fromNormalizedStudioSnapshot,
    fromSavedChatV3Snapshot,
  });
})(typeof window !== "undefined" ? window : globalThis);
