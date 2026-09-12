// @version 0.2.0-m03-s4a
"use strict";

/*
 * H2O Studio Renderer — Semantic Index v1 (S4A: shell + content projection index).
 *
 * Authority boundary:
 *   owner semantic input / source snapshot -> Renderer H2O shells -> read-only projection index
 *   Render IR node -> ContentRenderer-created DOM target -> content projection record
 *
 * One index describes exactly ONE render result: the H2O-owned conversation
 * root (cgFrame), its turn shells (cgTurn), message hosts (cgMsg), and - for
 * bodies the ContentRenderer built from accepted Render IR - the block and
 * text projections of that content. The Renderer builds it after the final
 * structure of a render is known and hands it back with the render result;
 * the result owns the index lifetime, a rerender yields a different instance,
 * and nothing here is a singleton, registry, observer or daemon.
 *
 * Content coverage is truthful: raw rich provider replay content never passes
 * through the ContentRenderer, so it has no block / text projections (its
 * message shell is still indexed, with contentIndexed:false). Nothing is ever
 * inferred from provider DOM, selectors or text walks.
 *
 * Identity model (projection-local only):
 *   ownerRef      an already-issued owner/semantic reference projected through
 *                 Render IR (semantic-v3 path). Never minted here.
 *   sourceRef     existing source identifiers (chatId, snapshotId, turnId,
 *                 messageId) carried as METADATA only.
 *   projectionKey Renderer-owned, deterministic, unique within one index,
 *                 namespaced by projection kind, independent of the
 *                 PresentationProfile, never a durable Knowledge / Storage id.
 *
 * Key precedence:
 *   semantic  the accepted Render IR renderKey is reused verbatim for the
 *             conversation and message projections (it is already namespaced
 *             by kind); the turn projection wraps its message key:
 *               turn:semantic:<encoded message renderKey>
 *   source    an accepted source id, explicitly marked as such:
 *               conversation:source:<encoded snapshotId>
 *               conversation:source-chat:<encoded chatId>
 *               turn:source:<encoded turnId>
 *               turn:source-message:<encoded messageId>
 *               message:source:<encoded messageId>
 *   path      deterministic projection order:
 *               conversation:path:0   turn:path:<ordinal>   message:path:<ordinal>
 *   render-ir content projections keep the Render IR renderKey as their
 *             identity basis, scoped by the parent message projection:
 *               block:render:<encoded messageKey>:<encoded renderKey>
 *               text:render:<encoded messageKey>:<encoded renderKey>
 *             (a Render IR `text` node is a text projection; every other
 *             accepted node kind is a block projection; marks are never
 *             separate projections).
 *   A duplicated key never overwrites an earlier record: later duplicates
 *   receive a deterministic ordinal suffix (<key>:ordinal:<n>).
 *
 * This module does NOT touch the DOM, emit attributes, persist, navigate,
 * scroll, decorate, or expose mutation. Geometry is read live from the indexed
 * target at request time (Element: bounding rect; Text node: a temporary Range).
 */
(function installRendererSemanticIndex(global) {
  const H2O = global.H2O = global.H2O || {};
  const Studio = H2O.Studio = H2O.Studio || {};
  const Renderer = Studio.Renderer = Studio.Renderer || {};
  if (Renderer.semanticIndex && Renderer.semanticIndex.__installed) return;

  const SCHEMA = "h2o.renderer.semantic-index";
  const SCHEMA_VERSION = 1;
  const API_VERSION = "0.2.0-m03-s4a";

  const KINDS = Object.freeze(["conversation", "turn", "message", "block", "text"]);
  const ROLES = Object.freeze(["user", "assistant", "system", "tool"]);
  const BASES = Object.freeze({ SEMANTIC: "semantic", SOURCE: "source", PATH: "path", RENDER_IR: "render-ir" });
  const TEXT_NODE = 3;
  const COORDINATE_SPACE = "viewport";

  const TURN_CLASS = "cgTurn";
  const MESSAGE_CLASS = "cgMsg";
  const ROLE_ATTR = "data-message-author-role";
  const MESSAGE_ID_ATTR = "data-message-id";
  const TURN_ID_ATTR = "data-turn-id";
  const TURN_NO_ATTR = "data-h2o-turn-no";

  function asString(value) { return value == null ? "" : String(value); }
  function trimmed(value) { return asString(value).trim(); }
  function isElement(value) {
    return !!value && typeof value === "object" && value.nodeType === 1 && typeof value.getAttribute === "function";
  }
  function isTextNode(value) {
    return !!value && typeof value === "object" && value.nodeType === TEXT_NODE;
  }
  function isPlainObject(value) {
    /* Realm-agnostic: a plain object's prototype is null or an Object.prototype
     * whose own prototype is null (validators build inputs in other realms). */
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === null || Object.getPrototypeOf(proto) === null;
  }
  function encode(value) { return encodeURIComponent(asString(value)); }
  function freezeRef(fields) {
    const out = {};
    for (const [key, value] of Object.entries(fields)) {
      const text = trimmed(value);
      if (text) out[key] = text;
    }
    return Object.keys(out).length ? Object.freeze(out) : null;
  }
  function roleFromClasses(el) {
    const classes = asString(el.className).split(/\s+/);
    for (const cls of classes) {
      const match = /^cgTurn--(user|assistant|system|tool)$/.exec(cls);
      if (match) return match[1];
    }
    return "";
  }
  function normalizeRole(value) {
    const role = trimmed(value).toLowerCase();
    return ROLES.includes(role) ? role : "";
  }
  function cloneOwnerRef(ref) {
    /* Owner references are projected through Render IR as frozen plain data
     * (string or a small object). They pass through untouched; nothing is
     * derived or minted here. */
    if (ref == null || ref === "") return null;
    if (typeof ref === "string" || typeof ref === "number") return asString(ref);
    if (!isPlainObject(ref)) return null;
    return Object.isFrozen(ref) ? ref : Object.freeze({ ...ref });
  }

  /* -------------------------------------------------------------- keys -- */

  function semanticTurnKey(messageRenderKey) { return `turn:${BASES.SEMANTIC}:${encode(messageRenderKey)}`; }
  function sourceKey(kind, basisLabel, id) { return `${kind}:${basisLabel}:${encode(id)}`; }
  function pathKey(kind, ordinal) { return `${kind}:${BASES.PATH}:${ordinal}`; }
  function contentKey(kind, messageKey, renderKey) { return `${kind}:render:${encode(messageKey)}:${encode(renderKey)}`; }

  /* Collision-safe allocation: the first record keeps the base key, later
   * duplicates get a deterministic ordinal suffix and keep their sourceRef. */
  function allocate(taken, base, ordinal) {
    let key = base;
    if (taken.has(key)) key = `${base}:ordinal:${ordinal}`;
    let bump = 0;
    while (taken.has(key)) { bump += 1; key = `${base}:ordinal:${ordinal}:${bump}`; }
    taken.add(key);
    return key;
  }

  /* --------------------------------------------------------- geometry -- */

  function readGeometry(target) {
    if (!isElement(target) && !isTextNode(target)) return null;
    if (target.isConnected !== true) return null;
    const doc = target.ownerDocument;
    if (!doc || !doc.defaultView) return null;
    let rect = null;
    if (isTextNode(target)) {
      /* A Text node has no box of its own: measure it through a temporary
       * Range over its contents. The Range is not retained. */
      if (typeof doc.createRange !== "function") return null;
      const range = doc.createRange();
      try {
        range.selectNodeContents(target);
        rect = range.getBoundingClientRect();
      } finally {
        if (typeof range.detach === "function") range.detach();
      }
    } else {
      if (typeof target.getBoundingClientRect !== "function") return null;
      rect = target.getBoundingClientRect();
    }
    if (!rect) return null;
    return Object.freeze({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      coordinateSpace: COORDINATE_SPACE,
    });
  }

  /* ----------------------------------------------------------- build -- */

  function collectShells(turnsEl) {
    const turns = [];
    const children = turnsEl && turnsEl.children ? Array.from(turnsEl.children) : [];
    for (const turnEl of children) {
      if (!isElement(turnEl) || !turnEl.classList || !turnEl.classList.contains(TURN_CLASS)) continue;
      const hostEl = Array.from(turnEl.children || []).find((child) => isElement(child) && child.classList && child.classList.contains(MESSAGE_CLASS)) || null;
      turns.push({ turnEl, hostEl });
    }
    return turns;
  }

  function describeShell(shell, ordinal, describeTurn) {
    const meta = typeof describeTurn === "function" ? (describeTurn(shell.turnEl) || null) : null;
    const host = shell.hostEl;
    const role = normalizeRole(meta && meta.role)
      || normalizeRole(host && host.getAttribute(ROLE_ATTR))
      || roleFromClasses(shell.turnEl)
      || normalizeRole(shell.turnEl.getAttribute("data-turn"));
    const turnNoRaw = Number(meta && meta.turnNo) || Number(shell.turnEl.getAttribute(TURN_NO_ATTR)) || 0;
    const turnNo = turnNoRaw > 0 ? turnNoRaw : ordinal + 1;
    const messageId = trimmed(meta && meta.messageId) || trimmed(host && host.getAttribute(MESSAGE_ID_ATTR));
    const turnId = trimmed(meta && meta.turnId) || trimmed(host && host.getAttribute(TURN_ID_ATTR));
    return { role, turnNo, messageId, turnId };
  }

  function semanticCorrespondence(conversation, shells) {
    if (!conversation || !Array.isArray(conversation.messages)) return null;
    const messages = conversation.messages;
    if (messages.length !== shells.length) return null;
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i];
      if (!message || !trimmed(message.renderKey)) return null;
      const shellRole = shells[i].role;
      if (shellRole && normalizeRole(message.role) !== shellRole) return null;
    }
    return messages;
  }

  function createShellIndex(input) {
    if (!isPlainObject(input)) throw new TypeError("Semantic Index input must be an object");
    const root = input.root;
    const turnsEl = input.turnsEl;
    if (!isElement(root)) throw new TypeError("Semantic Index requires the H2O conversation root element");
    if (!isElement(turnsEl)) throw new TypeError("Semantic Index requires the H2O transcript element");
    const renderMode = trimmed(input.renderMode) || "";
    const source = isPlainObject(input.source) ? input.source : {};
    const conversationInput = input.semanticConversation && typeof input.semanticConversation === "object"
      ? input.semanticConversation
      : null;

    const shells = collectShells(turnsEl).map((shell, ordinal) => ({ ...shell, ordinal, ...describeShell(shell, ordinal, input.describeTurn) }));
    const semanticMessages = semanticCorrespondence(conversationInput, shells);
    const semanticRequested = conversationInput !== null;
    const basis = semanticMessages ? BASES.SEMANTIC : BASES.SOURCE;

    const taken = new Set();
    const turnsByKey = new Map();
    const messagesByKey = new Map();
    const turnRecords = [];
    const messageRecords = [];

    /* Conversation key first so the turn/message keys can never collide with it. */
    let conversationKey;
    let conversationOwnerRef = null;
    let conversationBasis;
    if (semanticMessages) {
      conversationKey = allocate(taken, trimmed(conversationInput.renderKey) || pathKey("conversation", 0), 0);
      conversationOwnerRef = cloneOwnerRef(conversationInput.ownerRef);
      conversationBasis = BASES.SEMANTIC;
    } else if (trimmed(source.snapshotId)) {
      conversationKey = allocate(taken, sourceKey("conversation", BASES.SOURCE, trimmed(source.snapshotId)), 0);
      conversationBasis = BASES.SOURCE;
    } else if (trimmed(source.chatId)) {
      conversationKey = allocate(taken, sourceKey("conversation", "source-chat", trimmed(source.chatId)), 0);
      conversationBasis = BASES.SOURCE;
    } else {
      conversationKey = allocate(taken, pathKey("conversation", 0), 0);
      conversationBasis = BASES.PATH;
    }

    for (const shell of shells) {
      const ordinal = shell.ordinal;
      const semanticMessage = semanticMessages ? semanticMessages[ordinal] : null;

      let messageBase;
      let messageBasis;
      let ownerRef = null;
      let renderKey = "";
      if (semanticMessage) {
        renderKey = trimmed(semanticMessage.renderKey);
        messageBase = renderKey;
        messageBasis = BASES.SEMANTIC;
        ownerRef = cloneOwnerRef(semanticMessage.ownerRef);
      } else if (shell.messageId) {
        messageBase = sourceKey("message", BASES.SOURCE, shell.messageId);
        messageBasis = BASES.SOURCE;
      } else {
        messageBase = pathKey("message", ordinal);
        messageBasis = BASES.PATH;
      }
      const messageKey = allocate(taken, messageBase, ordinal);

      let turnBase;
      let turnBasis;
      if (semanticMessage) {
        turnBase = semanticTurnKey(renderKey);
        turnBasis = BASES.SEMANTIC;
      } else if (shell.turnId) {
        turnBase = sourceKey("turn", BASES.SOURCE, shell.turnId);
        turnBasis = BASES.SOURCE;
      } else if (shell.messageId) {
        turnBase = sourceKey("turn", "source-message", shell.messageId);
        turnBasis = BASES.SOURCE;
      } else {
        turnBase = pathKey("turn", ordinal);
        turnBasis = BASES.PATH;
      }
      const turnKey = allocate(taken, turnBase, ordinal);

      const sourceRef = freezeRef({ turnId: shell.turnId, messageId: shell.messageId });

      const turn = Object.freeze({
        projectionKey: turnKey,
        kind: "turn",
        basis: turnBasis,
        role: shell.role,
        ordinal,
        turnNo: shell.turnNo,
        ownerRef: null,
        sourceRef,
        messageKey,
        target: shell.turnEl,
      });
      const message = Object.freeze({
        projectionKey: messageKey,
        kind: "message",
        basis: messageBasis,
        role: shell.role,
        ordinal,
        turnNo: shell.turnNo,
        ownerRef,
        renderKey: renderKey || null,
        sourceRef,
        turnKey,
        target: shell.hostEl,
      });
      turnRecords.push(turn);
      messageRecords.push(message);
      turnsByKey.set(turnKey, turn);
      messagesByKey.set(messageKey, message);
    }

    /* ---- content projections (S4A slice B) ----------------------------
     * Reports come from the ContentRenderer seam: { report: { projection,
     * block, target }, bodyEl }. Each report is attached to the message whose
     * H2O host structurally contains its body element; the report order is the
     * ContentRenderer's deterministic pre-order walk. */
    const hostToOrdinal = new Map();
    shells.forEach((shell, ordinal) => { if (shell.hostEl) hostToOrdinal.set(shell.hostEl, ordinal); });
    const contentBodies = input.contentBodies instanceof Set ? input.contentBodies : new Set();
    const hostOf = (bodyEl) => {
      let node = bodyEl;
      let hops = 0;
      while (node && hops < 8) {
        if (hostToOrdinal.has(node)) return node;
        node = node.parentNode || null;
        hops += 1;
      }
      return null;
    };
    const perMessageBlocks = messageRecords.map(() => []);
    const perMessageTexts = messageRecords.map(() => []);
    const perMessageIndexed = messageRecords.map(() => false);
    for (const bodyEl of contentBodies) {
      const host = hostOf(bodyEl);
      if (host) perMessageIndexed[hostToOrdinal.get(host)] = true;
    }
    const contentByKey = new Map();
    const blockRecords = [];
    const textRecords = [];
    const reports = Array.isArray(input.contentProjections) ? input.contentProjections : [];
    const perMessageCounter = messageRecords.map(() => 0);
    for (const entry of reports) {
      const report = entry && entry.report;
      if (!report || typeof report !== "object") continue;
      const block = report.block;
      const target = report.target;
      const projection = report.projection === "text" ? "text" : "block";
      if (!block || typeof block !== "object" || !trimmed(block.renderKey)) continue;
      if (projection === "text" ? !isTextNode(target) : !isElement(target)) continue;
      const host = hostOf(entry.bodyEl);
      if (!host) continue;
      const messageOrdinal = hostToOrdinal.get(host);
      const messageKey = messageRecords[messageOrdinal].projectionKey;
      const renderKey = trimmed(block.renderKey);
      const projectionKey = allocate(taken, contentKey(projection, messageKey, renderKey), perMessageCounter[messageOrdinal]);
      const record = Object.freeze({
        projectionKey,
        kind: projection,
        basis: BASES.RENDER_IR,
        irKind: trimmed(block.kind),
        ordinal: perMessageCounter[messageOrdinal],
        messageOrdinal,
        messageKey,
        renderKey,
        ownerRef: cloneOwnerRef(block.ownerRef),
        target,
      });
      perMessageCounter[messageOrdinal] += 1;
      perMessageIndexed[messageOrdinal] = true;
      contentByKey.set(projectionKey, record);
      if (projection === "text") { textRecords.push(record); perMessageTexts[messageOrdinal].push(projectionKey); }
      else { blockRecords.push(record); perMessageBlocks[messageOrdinal].push(projectionKey); }
    }
    /* Message records gain their content linkage additively. */
    for (let i = 0; i < messageRecords.length; i += 1) {
      const message = Object.freeze({
        ...messageRecords[i],
        blockKeys: Object.freeze(perMessageBlocks[i].slice()),
        textKeys: Object.freeze(perMessageTexts[i].slice()),
        contentIndexed: perMessageIndexed[i] === true,
      });
      messageRecords[i] = message;
      messagesByKey.set(message.projectionKey, message);
    }

    const conversation = Object.freeze({
      projectionKey: conversationKey,
      kind: "conversation",
      basis: conversationBasis,
      ownerRef: conversationOwnerRef,
      renderKey: semanticMessages ? (trimmed(conversationInput.renderKey) || null) : null,
      sourceRef: freezeRef({ chatId: source.chatId, snapshotId: source.snapshotId }),
      turnKeys: Object.freeze(turnRecords.map((turn) => turn.projectionKey)),
      messageKeys: Object.freeze(messageRecords.map((message) => message.projectionKey)),
      blockKeys: Object.freeze(blockRecords.map((block) => block.projectionKey)),
      textKeys: Object.freeze(textRecords.map((text) => text.projectionKey)),
      target: root,
    });

    const frozenTurns = Object.freeze(turnRecords.slice());
    const frozenMessages = Object.freeze(messageRecords.slice());
    const frozenBlocks = Object.freeze(blockRecords.slice());
    const frozenTexts = Object.freeze(textRecords.slice());

    function lookup(key) {
      const text = typeof key === "string" ? key : "";
      if (!text) return null;
      if (text === conversation.projectionKey) return conversation;
      return turnsByKey.get(text) || messagesByKey.get(text) || contentByKey.get(text) || null;
    }

    return Object.freeze({
      schema: SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      version: API_VERSION,
      renderMode,
      basis,
      /* True only when a semantic conversation was supplied but its messages
       * did not correspond one-to-one with the projected shells; the index then
       * falls back to source/path identity instead of guessing ownership. */
      semanticCorrespondenceLost: semanticRequested && !semanticMessages,
      getConversation() { return conversation; },
      getTurn(key) { const rec = typeof key === "string" ? turnsByKey.get(key) : undefined; return rec || null; },
      getMessage(key) { const rec = typeof key === "string" ? messagesByKey.get(key) : undefined; return rec || null; },
      getBlock(key) { const rec = typeof key === "string" ? contentByKey.get(key) : undefined; return rec && rec.kind === "block" ? rec : null; },
      getText(key) { const rec = typeof key === "string" ? contentByKey.get(key) : undefined; return rec && rec.kind === "text" ? rec : null; },
      turns() { return frozenTurns; },
      messages() { return frozenMessages; },
      blocks() { return frozenBlocks; },
      texts() { return frozenTexts; },
      getGeometry(key) {
        const rec = lookup(key);
        if (!rec) return null;
        return readGeometry(rec.target);
      },
    });
  }

  Renderer.semanticIndex = Object.freeze({
    __installed: true,
    __version: API_VERSION,
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    kinds: KINDS,
    bases: BASES,
    createShellIndex,
  });
})(typeof window !== "undefined" ? window : globalThis);
