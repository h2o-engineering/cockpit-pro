// @version 0.1.0-m03-s4b
"use strict";

/*
 * H2O Studio Renderer — DecorationContribution v1 (S4B: per-render lifecycle).
 *
 * Authority boundary:
 *   Semantic Index projection record (read-only) -> DecorationContribution lifecycle -> consumer application
 *
 * One lifecycle governs the decorations contributed to exactly ONE render
 * result. The Renderer creates it after that result's Semantic Index exists,
 * binds it to that index alone and hands it back with the render result; a
 * rerender yields a different lifecycle with an empty registry. Nothing here
 * is a singleton, a global registry, an observer or a daemon, and the Renderer
 * itself registers no contribution: an ordinary render carries zero.
 *
 * A contribution is REGISTERED by a consumer (owner + id + targetKey + value +
 * apply), APPLIED exactly once through its `apply(context, value)` factory,
 * UPDATED through the private lifecycle object that factory returned, and
 * DISPOSED at most once - explicitly through its handle, or in reverse
 * registration order through disposeAll(). Targets resolve exclusively through
 * the bound Semantic Index (conversation / turn / message / block / text); an
 * unknown key fails registration instead of falling back to provider DOM.
 *
 * Identity is per-render and deterministic:
 *   decoration:<encoded owner>:<encoded id>
 * A duplicate owner + id inside one lifecycle is rejected, never overwritten.
 * No UUID, random value, timestamp or durable Product identity is minted.
 *
 * The application context handed to `apply` is frozen and bounded: the
 * contribution identity, the exact immutable projection record, its indexed
 * DOM Element / Text node and a bound read-only geometry lookup. It carries no
 * navigation, scrolling, focus, routing, Reader or index internals. The
 * consumer's value is passed through opaque - never reinterpreted, copied into
 * snapshots or stored.
 *
 * Failure semantics are rollback-safe: an `apply` that throws or returns no
 * usable lifecycle leaves no registration; an `update` that throws leaves the
 * contribution registered at its previous revision; a `dispose` that throws
 * propagates only after the contribution is already out of the registry;
 * disposeAll() attempts every cleanup and reports the failures aggregated.
 *
 * This module does NOT touch the DOM, emit attributes, wrap text, observe,
 * persist, navigate, or mutate the Semantic Index.
 */
(function installRendererDecorationContribution(global) {
  const H2O = global.H2O = global.H2O || {};
  const Studio = H2O.Studio = H2O.Studio || {};
  const Renderer = Studio.Renderer = Studio.Renderer || {};
  if (Renderer.decorationContribution && Renderer.decorationContribution.__installed) return;

  const SCHEMA = "h2o.renderer.decoration-contribution";
  const SCHEMA_VERSION = 1;
  const API_VERSION = "0.1.0-m03-s4b";
  const INDEX_SCHEMA = "h2o.renderer.semantic-index";
  const INDEX_SCHEMA_VERSION = 1;
  const INDEX_LOOKUPS = Object.freeze(["getConversation", "getTurn", "getMessage", "getBlock", "getText", "getGeometry"]);
  const TARGET_KINDS = Object.freeze(["conversation", "turn", "message", "block", "text"]);
  const KEY_NAMESPACE = "decoration";
  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;

  function isObject(value) { return !!value && typeof value === "object"; }
  function isFunction(value) { return typeof value === "function"; }
  function isNonBlankString(value) { return typeof value === "string" && value.trim() !== ""; }
  function encode(value) { return encodeURIComponent(String(value)); }

  /* ------------------------------------------------------------ identity -- */

  /* Deterministic per-render contribution key: owner namespace + consumer id,
   * both verbatim (encoded). Never a durable Product identity. */
  function contributionKeyOf(owner, id) {
    if (!isNonBlankString(owner)) throw new TypeError("DecorationContribution key requires a non-empty owner");
    if (!isNonBlankString(id)) throw new TypeError("DecorationContribution key requires a non-empty id");
    return `${KEY_NAMESPACE}:${encode(owner)}:${encode(id)}`;
  }

  /* --------------------------------------------------------------- index -- */

  function assertSemanticIndex(index) {
    if (!isObject(index) || index.schema !== INDEX_SCHEMA || index.schemaVersion !== INDEX_SCHEMA_VERSION) {
      throw new TypeError("DecorationContribution requires the render result's Semantic Index (h2o.renderer.semantic-index v1)");
    }
    for (const name of INDEX_LOOKUPS) {
      if (!isFunction(index[name])) throw new TypeError(`DecorationContribution requires a Semantic Index exposing ${name}()`);
    }
    return index;
  }

  /* Target resolution goes through the bound index only: the conversation
   * record by key equality, then the turn / message / block / text lookups.
   * The record must be one of the five projection kinds and carry its indexed
   * DOM target (Element or Text node); anything else is unknown. */
  function resolveProjection(index, targetKey) {
    const conversation = index.getConversation();
    const record = isObject(conversation) && conversation.projectionKey === targetKey
      ? conversation
      : (index.getTurn(targetKey) || index.getMessage(targetKey) || index.getBlock(targetKey) || index.getText(targetKey) || null);
    if (!isObject(record) || record.projectionKey !== targetKey || !TARGET_KINDS.includes(record.kind)) return null;
    const target = record.target;
    if (!isObject(target) || (target.nodeType !== ELEMENT_NODE && target.nodeType !== TEXT_NODE)) return null;
    return record;
  }

  /* ------------------------------------------------------------ failures -- */

  function aggregateFailure(errors, message) {
    if (typeof AggregateError === "function") return new AggregateError(errors, message);
    const error = new Error(message);
    error.errors = errors.slice();
    return error;
  }

  /* ----------------------------------------------------------- lifecycle -- */

  function createLifecycle(input) {
    if (!isObject(input)) throw new TypeError("DecorationContribution lifecycle input must be an object");
    const index = assertSemanticIndex(input.semanticIndex);

    /* The active registry of THIS lifecycle only. Insertion order is the
     * registration order; a disposed entry leaves it immediately. */
    const active = new Map();
    let disposingAll = false;

    function snapshotOf(entry) {
      return Object.freeze({
        contributionKey: entry.key,
        owner: entry.owner,
        id: entry.id,
        targetKey: entry.targetKey,
        targetKind: entry.targetKind,
        revision: entry.revision,
        active: entry.active,
      });
    }

    /* Bookkeeping runs BEFORE any consumer cleanup: once retired, an entry can
     * neither be found through the registry nor have its cleanup run twice,
     * whatever that cleanup does afterwards. */
    function retire(entry) {
      entry.active = false;
      if (active.get(entry.key) === entry) active.delete(entry.key);
    }

    function createHandle(entry) {
      return Object.freeze({
        contributionKey: entry.key,
        owner: entry.owner,
        id: entry.id,
        targetKey: entry.targetKey,
        /* Updates change the application state only; owner, id, targetKey and
         * apply are fixed for the contribution's lifetime (retargeting is
         * dispose + register). The revision advances only after the private
         * lifecycle accepted the new value; a throw propagates unchanged. */
        update(nextValue) {
          if (!entry.active) throw new Error(`DecorationContribution ${entry.key} is disposed; update refused`);
          entry.lifecycle.update(nextValue);
          entry.revision += 1;
          return snapshotOf(entry);
        },
        /* Idempotent: true once, false afterwards. Cleanup runs at most once and
         * a cleanup error propagates only after the state is already disposed. */
        dispose() {
          if (!entry.active) return false;
          retire(entry);
          entry.lifecycle.dispose();
          return true;
        },
        snapshot() { return snapshotOf(entry); },
      });
    }

    function register(definition) {
      if (!isObject(definition)) throw new TypeError("DecorationContribution registration requires a definition object");
      const owner = definition.owner;
      const id = definition.id;
      const targetKey = definition.targetKey;
      const apply = definition.apply;
      if (!isNonBlankString(owner)) throw new TypeError("DecorationContribution registration requires a non-empty owner");
      if (!isNonBlankString(id)) throw new TypeError("DecorationContribution registration requires a non-empty id");
      if (!isNonBlankString(targetKey)) throw new TypeError("DecorationContribution registration requires a non-empty targetKey");
      if (!isFunction(apply)) throw new TypeError("DecorationContribution registration requires an apply(context, value) function");
      if (disposingAll) throw new Error("DecorationContribution registration is refused while disposeAll() runs");
      const key = contributionKeyOf(owner, id);
      if (active.has(key)) {
        throw new Error(`DecorationContribution ${key} is already registered in this render lifecycle; dispose it before registering again`);
      }
      const projection = resolveProjection(index, targetKey);
      if (!projection) {
        throw new Error(`DecorationContribution ${key}: targetKey ${JSON.stringify(targetKey)} is not a projection of this render's Semantic Index`);
      }
      /* The bounded application context: identity, the exact projection record
       * and its indexed target, and a geometry lookup bound to that key. */
      const context = Object.freeze({
        contributionKey: key,
        owner,
        id,
        targetKey,
        projection,
        target: projection.target,
        getGeometry() { return index.getGeometry(targetKey); },
      });
      /* APPLY runs exactly once and before any bookkeeping: a throw or an
       * unusable lifecycle leaves no registration and returns no handle. */
      const lifecycle = apply(context, definition.value);
      if (!isObject(lifecycle) || !isFunction(lifecycle.update) || !isFunction(lifecycle.dispose)) {
        throw new TypeError(`DecorationContribution ${key}: apply() must return a lifecycle object with update(nextValue) and dispose() functions`);
      }
      const entry = { key, owner, id, targetKey, targetKind: projection.kind, lifecycle, revision: 0, active: true };
      active.set(key, entry);
      return createHandle(entry);
    }

    function get(contributionKey) {
      const entry = typeof contributionKey === "string" ? active.get(contributionKey) : undefined;
      return entry ? snapshotOf(entry) : null;
    }

    function list() {
      return Object.freeze(Array.from(active.values(), snapshotOf));
    }

    /* Render-lifecycle cleanup: every active contribution is retired and its
     * cleanup attempted in REVERSE registration order (later decorations may
     * depend on earlier surfaces). Registration is refused meanwhile, so the
     * registry is empty on completion. Failures never stop the sweep; they are
     * reported together afterwards. Returns the disposed keys in sweep order. */
    function disposeAll() {
      if (disposingAll) throw new Error("DecorationContribution disposeAll() is already running");
      disposingAll = true;
      const entries = Array.from(active.values()).reverse();
      const disposed = [];
      const failures = [];
      try {
        for (const entry of entries) {
          if (!entry.active) continue;
          retire(entry);
          try {
            entry.lifecycle.dispose();
          } catch (error) {
            failures.push({ key: entry.key, error });
          }
          disposed.push(entry.key);
        }
      } finally {
        disposingAll = false;
      }
      if (failures.length) {
        throw aggregateFailure(
          failures.map((failure) => failure.error),
          `DecorationContribution disposeAll: ${failures.length} of ${disposed.length} cleanup callbacks failed (${failures.map((failure) => failure.key).join(", ")})`
        );
      }
      return Object.freeze(disposed);
    }

    return Object.freeze({
      schema: SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      version: API_VERSION,
      /* The bound index: read-only by its own contract, exposed so a consumer
       * can resolve keys against the same snapshot it decorates. */
      semanticIndex: index,
      register,
      get,
      list,
      disposeAll,
    });
  }

  Renderer.decorationContribution = Object.freeze({
    __installed: true,
    __version: API_VERSION,
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    targetKinds: TARGET_KINDS,
    contributionKeyOf,
    createLifecycle,
  });
})(typeof window !== "undefined" ? window : globalThis);
