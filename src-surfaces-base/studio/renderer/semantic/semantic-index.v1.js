// @version 0.1.0-m03-s4a
"use strict";

/*
 * H2O Studio Renderer — Semantic Index v1 (S4A slice A: shell projection index).
 *
 * Authority boundary:
 *   owner semantic input / source snapshot -> Renderer H2O shells -> read-only projection index
 *
 * One index describes exactly ONE render result: the H2O-owned conversation
 * root (cgFrame), its turn shells (cgTurn) and message hosts (cgMsg). The
 * Renderer builds it after the final structure of a render is known and hands
 * it back with the render result; the result owns the index lifetime, a
 * rerender yields a different instance, and nothing here is a singleton,
 * registry, observer or daemon.
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
 *   A duplicated source id never overwrites an earlier record: later
 *   duplicates receive a deterministic ordinal suffix (<key>:ordinal:<n>).
 *
 * This module does NOT touch the DOM, emit attributes, persist, navigate,
 * scroll, decorate, index blocks or text (S4A slice B), or expose mutation.
 * Geometry is read live from the indexed target at request time.
 */
(function installRendererSemanticIndex(global) {
  const H2O = global.H2O = global.H2O || {};
  const Studio = H2O.Studio = H2O.Studio || {};
  const Renderer = Studio.Renderer = Studio.Renderer || {};
  if (Renderer.semanticIndex && Renderer.semanticIndex.__installed) return;

  const SCHEMA = "h2o.renderer.semantic-index";
  const SCHEMA_VERSION = 1;
  const API_VERSION = "0.1.0-m03-s4a";

  const KINDS = Object.freeze(["conversation", "turn", "message"]);
  const ROLES = Object.freeze(["user", "assistant", "system", "tool"]);
  const BASES = Object.freeze({ SEMANTIC: "semantic", SOURCE: "source", PATH: "path" });
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
    if (!isElement(target)) return null;
    if (target.isConnected !== true) return null;
    const doc = target.ownerDocument;
    if (!doc || !doc.defaultView || typeof target.getBoundingClientRect !== "function") return null;
    const rect = target.getBoundingClientRect();
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

    const conversation = Object.freeze({
      projectionKey: conversationKey,
      kind: "conversation",
      basis: conversationBasis,
      ownerRef: conversationOwnerRef,
      renderKey: semanticMessages ? (trimmed(conversationInput.renderKey) || null) : null,
      sourceRef: freezeRef({ chatId: source.chatId, snapshotId: source.snapshotId }),
      turnKeys: Object.freeze(turnRecords.map((turn) => turn.projectionKey)),
      messageKeys: Object.freeze(messageRecords.map((message) => message.projectionKey)),
      target: root,
    });

    const frozenTurns = Object.freeze(turnRecords.slice());
    const frozenMessages = Object.freeze(messageRecords.slice());

    function lookup(key) {
      const text = typeof key === "string" ? key : "";
      if (!text) return null;
      if (text === conversation.projectionKey) return conversation;
      return turnsByKey.get(text) || messagesByKey.get(text) || null;
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
      turns() { return frozenTurns; },
      messages() { return frozenMessages; },
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
