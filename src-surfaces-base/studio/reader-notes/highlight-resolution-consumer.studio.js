/* H2O Studio - Reader & Notes - MVP-A2a.4.2: highlight resolution consumer
 *
 * Read-only explicit-invocation adapter that connects A1 attributed highlight
 * annotations to the A2a DOM resolver. This module returns serializable
 * resolution rows only. It never renders, persists, or returns live Range
 * objects.
 *
 * M03 P4 S4C T8 (slice A): the message-root lookup for source.answerId now
 * resolves through the Renderer's read-only Semantic Index first (message
 * record sourceRef.messageId -> indexed message target), obtained from an
 * explicit options.semanticIndex or the current Reader render bridge
 * (H2O.Studio.getReaderSemanticIndex(root)). The provider-compatible
 * [data-message-id] scan stays as the fallback bridge; annotation eligibility,
 * anchor resolution, rows, flags and serialization are unchanged.
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.readerNotes = H2O.Studio.readerNotes || {};

  if (H2O.Studio.readerNotes.highlightResolutionConsumer && H2O.Studio.readerNotes.highlightResolutionConsumer.__installed) {
    return;
  }

  var VERSION = 1;
  var SCHEMA_VERSION = 1;
  var FLAG_KEY = 'studio.readerNotes.highlightResolutionConsumer.enabled';
  var SEMANTIC_INDEX_SCHEMA = 'h2o.renderer.semantic-index';
  var MESSAGE_ROOT_AUTHORITY_SEMANTIC = 'semantic-index';
  var MESSAGE_ROOT_AUTHORITY_COMPAT = 'data-message-id';
  var ANCESTRY_HOPS_MAX = 64;
  var errors = [];
  var ERR_MAX = 20;
  var lastDiagnostics = null;

  function recordError(op, e) {
    try {
      errors.push({ t: Date.now(), op: String(op), e: String((e && e.message) || (e && e.stack) || e || '') });
      if (errors.length > ERR_MAX) errors.splice(0, errors.length - ERR_MAX);
    } catch (_) { /* swallow */ }
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
  }

  function safeString(value) {
    return value == null ? null : String(value);
  }

  function cloneValue(value) {
    if (value == null) return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      if (Array.isArray(value)) return value.slice();
      if (isPlainObject(value)) {
        var out = {};
        Object.keys(value).forEach(function (key) {
          var v = value[key];
          if (v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[key] = v;
          else if (Array.isArray(v)) out[key] = v.slice();
          else if (isPlainObject(v)) out[key] = cloneValue(v);
        });
        return out;
      }
      return null;
    }
  }

  function cloneSpan(span) {
    if (!span || !Number.isFinite(span.start) || !Number.isFinite(span.end)) return null;
    return { start: span.start, end: span.end };
  }

  function getFlags() {
    var f = H2O && H2O.flags;
    return (f && typeof f.get === 'function') ? f : null;
  }

  function isEnabled() {
    try {
      var flags = getFlags();
      if (!flags) return false;
      return flags.get(FLAG_KEY, false) === true;
    } catch (e) {
      recordError('isEnabled', e);
      return false;
    }
  }

  function getAnnotationsApi() {
    var api = H2O && H2O.Studio && H2O.Studio.readerNotes && H2O.Studio.readerNotes.annotations;
    return (api && typeof api.listForItem === 'function') ? api : null;
  }

  function getResolverApi() {
    var api = H2O && H2O.Studio && H2O.Studio.readerNotes && H2O.Studio.readerNotes.anchorResolverDom;
    return (api && typeof api.resolveHighlight === 'function') ? api : null;
  }

  function apiEnabled(api) {
    try {
      return api && typeof api.isEnabled === 'function' ? api.isEnabled() === true : null;
    } catch (e) {
      recordError('upstream.isEnabled', e);
      return false;
    }
  }

  function safeResult(itemId, reason, details) {
    var diagnostics = {
      reason: reason,
      enabled: isEnabled(),
      considered: 0,
      resolvedCount: 0,
      unresolvedCount: 0,
      skippedCount: 0,
      skipped: [],
      upstream: details && details.upstream ? cloneValue(details.upstream) : {},
      messageRootLookup: emptyMessageRootLookup(false),
      errors: errors.slice(),
    };
    if (details && details.error) diagnostics.error = String(details.error);
    lastDiagnostics = cloneValue(diagnostics);
    return {
      schemaVersion: SCHEMA_VERSION,
      itemId: isNonEmptyString(itemId) ? itemId : null,
      resolved: [],
      unresolved: [],
      diagnostics: diagnostics,
    };
  }

  function resultBase(itemId, reason, annotationsApi, resolverApi) {
    var upstream = {
      annotationsAvailable: !!annotationsApi,
      resolverAvailable: !!resolverApi,
      annotationsEnabled: apiEnabled(annotationsApi),
      resolverEnabled: apiEnabled(resolverApi),
    };
    return {
      schemaVersion: SCHEMA_VERSION,
      itemId: itemId,
      resolved: [],
      unresolved: [],
      diagnostics: {
        reason: reason || 'ok',
        enabled: true,
        considered: 0,
        resolvedCount: 0,
        unresolvedCount: 0,
        skippedCount: 0,
        skipped: [],
        upstream: upstream,
        messageRootLookup: emptyMessageRootLookup(false),
        errors: errors.slice(),
      },
    };
  }

  /* Additive diagnostics only: which authority produced each message root.
   * Rows keep their accepted shape; nothing about the outcome semantics moves. */
  function emptyMessageRootLookup(semanticIndexAvailable) {
    return {
      primary: MESSAGE_ROOT_AUTHORITY_SEMANTIC,
      fallback: MESSAGE_ROOT_AUTHORITY_COMPAT,
      semanticIndexAvailable: semanticIndexAvailable === true,
      bySemanticIndex: 0,
      byCompatibilityAttribute: 0,
    };
  }

  function updateCounts(out) {
    out.diagnostics.resolvedCount = out.resolved.length;
    out.diagnostics.unresolvedCount = out.unresolved.length;
    out.diagnostics.skippedCount = out.diagnostics.skipped.length;
    lastDiagnostics = cloneValue(out.diagnostics);
  }

  function safeAnnotationId(annotation) {
    return safeString(annotation && annotation.id);
  }

  function annotationSource(annotation) {
    return isPlainObject(annotation && annotation.source) ? annotation.source : {};
  }

  function answerIdFor(annotation) {
    var source = annotationSource(annotation);
    return isNonEmptyString(source.answerId) ? source.answerId : null;
  }

  function nativeIdFor(annotation) {
    var source = annotationSource(annotation);
    return safeString(source.nativeId);
  }

  function hasAnchors(annotation) {
    return isPlainObject(annotation && annotation.raw) && isPlainObject(annotation.raw.anchors);
  }

  function eligibility(annotation) {
    if (!isPlainObject(annotation) || annotation.kind !== 'highlight') return { ok: false, reason: 'not-eligible' };
    if (annotation.attribution !== 'attributed') return { ok: false, reason: 'not-eligible' };
    if (!hasAnchors(annotation)) return { ok: false, reason: 'not-eligible', unresolved: true };
    if (!answerIdFor(annotation)) return { ok: false, reason: 'missing-answer', unresolved: true };
    return { ok: true };
  }

  function skip(out, annotation, reason) {
    out.diagnostics.skipped.push({
      reason: reason || 'not-eligible',
      annotationId: safeAnnotationId(annotation),
      kind: safeString(annotation && annotation.kind),
      attribution: safeString(annotation && annotation.attribution),
    });
  }

  function unresolvedRow(annotation, status, reason, resolverResult) {
    var result = isPlainObject(resolverResult) ? resolverResult : {};
    return {
      annotationId: safeAnnotationId(annotation),
      nativeId: nativeIdFor(annotation),
      answerId: answerIdFor(annotation),
      source: cloneValue(annotationSource(annotation)) || {},
      status: status || result.status || 'orphaned',
      span: cloneSpan(result.span),
      selectorUsed: result.selectorUsed || null,
      confidence: Number.isFinite(result.confidence) ? result.confidence : 0,
      reason: reason || result.reason || 'resolver-orphaned',
      text: '',
      diagnostics: cloneValue(result.diagnostics || {}) || {},
    };
  }

  function resolvedRow(annotation, resolverResult, text) {
    return {
      annotationId: safeAnnotationId(annotation),
      nativeId: nativeIdFor(annotation),
      answerId: answerIdFor(annotation),
      source: cloneValue(annotationSource(annotation)) || {},
      status: resolverResult.status,
      span: cloneSpan(resolverResult.span),
      selectorUsed: resolverResult.selectorUsed || null,
      confidence: Number.isFinite(resolverResult.confidence) ? resolverResult.confidence : 0,
      reason: resolverResult.reason || '',
      text: safeString(text) || '',
      diagnostics: cloneValue(resolverResult.diagnostics || {}) || {},
    };
  }

  /* ---- S4C slice A: message-root authority ------------------------------
   * Primary: the Renderer's read-only Semantic Index for THIS root. It is
   * accepted only when its conversation projection targets the requested root,
   * so a stale or foreign render's index is never consulted. Fallback: the
   * pre-existing provider-compatible [data-message-id] scan, unchanged. */

  function isSemanticIndex(candidate) {
    return !!candidate && typeof candidate === 'object'
      && candidate.schema === SEMANTIC_INDEX_SCHEMA
      && typeof candidate.getConversation === 'function'
      && typeof candidate.messages === 'function';
  }

  function semanticIndexDescribesRoot(index, root) {
    try {
      var conversation = index.getConversation();
      return !!conversation && conversation.target === root;
    } catch (e) {
      recordError('semanticIndex.getConversation', e);
      return false;
    }
  }

  function readerSemanticIndexFor(root) {
    var studio = H2O && H2O.Studio;
    if (!studio || typeof studio.getReaderSemanticIndex !== 'function') return null;
    try {
      var index = studio.getReaderSemanticIndex(root);
      return isSemanticIndex(index) ? index : null;
    } catch (e) {
      recordError('getReaderSemanticIndex', e);
      return null;
    }
  }

  function semanticIndexFor(root, options) {
    var explicit = isPlainObject(options) ? options.semanticIndex : null;
    if (isSemanticIndex(explicit) && semanticIndexDescribesRoot(explicit, root)) return explicit;
    var current = readerSemanticIndexFor(root);
    if (current && semanticIndexDescribesRoot(current, root)) return current;
    return null;
  }

  function isDescendantOf(node, root) {
    var current = node;
    for (var hops = 0; current && hops < ANCESTRY_HOPS_MAX; hops += 1) {
      if (current === root) return true;
      current = current.parentNode || null;
    }
    return false;
  }

  /* answerId is a SOURCE identifier: it is matched against the message
   * record's sourceRef.messageId only (never projectionKey, renderKey,
   * ownerRef or text). The first match in index message order keeps the old
   * first-matching-DOM-message behavior for malformed duplicate ids. */
  function findMessageRootBySemanticIndex(index, root, answerId) {
    var records;
    try {
      records = index.messages();
    } catch (e) {
      recordError('semanticIndex.messages', e);
      return null;
    }
    if (!records || typeof records.length !== 'number') return null;
    for (var i = 0; i < records.length; i += 1) {
      var record = records[i];
      var sourceRef = record && record.sourceRef;
      if (!record || !sourceRef || sourceRef.messageId !== answerId) continue;
      if (record.kind !== 'message') return null;
      var target = record.target;
      if (!target || target.nodeType !== 1 || !isDescendantOf(target, root)) return null;
      return target;
    }
    return null;
  }

  function findMessageRootByCompatibilityAttribute(root, answerId) {
    if (!root || typeof root.querySelectorAll !== 'function' || !isNonEmptyString(answerId)) return null;
    var nodes;
    try {
      nodes = Array.prototype.slice.call(root.querySelectorAll('[data-message-id]') || []);
    } catch (_) {
      return null;
    }
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      if (el && typeof el.getAttribute === 'function' && el.getAttribute('data-message-id') === answerId) return el;
    }
    return null;
  }

  function findMessageRoot(root, answerId, semanticIndex, lookup) {
    if (!isNonEmptyString(answerId)) return null;
    if (semanticIndex) {
      var indexed = findMessageRootBySemanticIndex(semanticIndex, root, answerId);
      if (indexed) {
        if (lookup) lookup.bySemanticIndex += 1;
        return indexed;
      }
    }
    var compat = findMessageRootByCompatibilityAttribute(root, answerId);
    if (compat && lookup) lookup.byCompatibilityAttribute += 1;
    return compat;
  }

  function resolverFailureReason(resolverResult) {
    var reason = resolverResult && resolverResult.reason;
    if (reason === 'disabled') return 'resolver-disabled';
    if (reason === 'range-unavailable') return 'range-unavailable';
    if (reason === 'resolver-error') return 'resolver-error';
    return 'resolver-orphaned';
  }

  function resolveForItem(itemId, root, options) {
    if (!isEnabled()) return safeResult(itemId, 'disabled');
    if (!isNonEmptyString(itemId)) return safeResult(itemId, 'invalid-item');
    if (!root || typeof root.querySelectorAll !== 'function') return safeResult(itemId, 'missing-root');

    var annotationsApi = getAnnotationsApi();
    var resolverApi = getResolverApi();
    if (!annotationsApi || !resolverApi) {
      return safeResult(itemId, 'deps-unavailable', {
        upstream: {
          annotationsAvailable: !!annotationsApi,
          resolverAvailable: !!resolverApi,
          annotationsEnabled: apiEnabled(annotationsApi),
          resolverEnabled: apiEnabled(resolverApi),
        },
      });
    }

    var out = resultBase(itemId, 'ok', annotationsApi, resolverApi);
    var annotations;
    try {
      annotations = annotationsApi.listForItem(itemId, { kind: 'highlight' });
    } catch (e) {
      recordError('annotations.listForItem', e);
      return safeResult(itemId, 'deps-unavailable', {
        upstream: out.diagnostics.upstream,
        error: e,
      });
    }
    if (!Array.isArray(annotations) || annotations.length === 0) {
      out.diagnostics.reason = 'no-highlights';
      updateCounts(out);
      return out;
    }

    /* S4C: one Semantic Index decision per invocation - explicit option first,
     * then the current Reader render's index, both only when they describe
     * this root. Null keeps the compatibility scan as the sole authority. */
    var semanticIndex = semanticIndexFor(root, options);
    out.diagnostics.messageRootLookup = emptyMessageRootLookup(!!semanticIndex);
    var lookup = out.diagnostics.messageRootLookup;

    for (var i = 0; i < annotations.length; i += 1) {
      var annotation = annotations[i];
      out.diagnostics.considered += 1;
      var eligible = eligibility(annotation);
      if (!eligible.ok) {
        if (eligible.unresolved) out.unresolved.push(unresolvedRow(annotation, 'orphaned', eligible.reason));
        else skip(out, annotation, eligible.reason);
        continue;
      }

      var answerId = answerIdFor(annotation);
      var msgEl = findMessageRoot(root, answerId, semanticIndex, lookup);
      if (!msgEl) {
        out.unresolved.push(unresolvedRow(annotation, 'orphaned', 'message-root-missing'));
        continue;
      }

      var resolverResult;
      try {
        resolverResult = resolverApi.resolveHighlight(annotation, msgEl, options || {});
      } catch (e) {
        recordError('anchorResolverDom.resolveHighlight', e);
        out.unresolved.push(unresolvedRow(annotation, 'orphaned', 'resolver-error', { diagnostics: { error: String(e && e.message || e || '') } }));
        continue;
      }

      if (!isPlainObject(resolverResult)) {
        out.unresolved.push(unresolvedRow(annotation, 'orphaned', 'resolver-error'));
        continue;
      }
      if (resolverResult.status !== 'anchored' && resolverResult.status !== 'reanchored') {
        out.unresolved.push(unresolvedRow(annotation, resolverResult.status || 'orphaned', resolverFailureReason(resolverResult), resolverResult));
        continue;
      }
      if (!resolverResult.range || typeof resolverResult.range.toString !== 'function') {
        out.unresolved.push(unresolvedRow(annotation, 'orphaned', 'range-unavailable', resolverResult));
        continue;
      }

      var text = '';
      try {
        text = resolverResult.range.toString();
      } catch (e) {
        recordError('range.toString', e);
        out.unresolved.push(unresolvedRow(annotation, 'orphaned', 'range-unavailable', resolverResult));
        continue;
      }
      out.resolved.push(resolvedRow(annotation, resolverResult, text));
    }

    if (out.resolved.length === 0 && out.unresolved.length === 0 && out.diagnostics.skipped.length > 0) out.diagnostics.reason = 'not-eligible';
    updateCounts(out);
    return out;
  }

  function selfCheck() {
    var annotationsApi = getAnnotationsApi();
    var resolverApi = getResolverApi();
    return {
      ok: errors.length === 0,
      version: VERSION,
      readonly: true,
      schemaVersion: SCHEMA_VERSION,
      flagKey: FLAG_KEY,
      enabled: isEnabled(),
      annotationsAvailable: !!annotationsApi,
      resolverAvailable: !!resolverApi,
      upstream: {
        annotationsEnabled: apiEnabled(annotationsApi),
        resolverEnabled: apiEnabled(resolverApi),
      },
      errors: errors.slice(),
    };
  }

  function diagnose() {
    var base = selfCheck();
    return {
      ok: base.ok,
      version: VERSION,
      readonly: true,
      flagKey: FLAG_KEY,
      enabled: base.enabled,
      supported: ['resolveForItem'],
      supportedKinds: ['highlight'],
      exclusions: ['unattributed', 'note', 'bookmark'],
      returnsLiveRange: false,
      xpath: 'deferred',
      noRender: true,
      messageRootAuthority: { primary: MESSAGE_ROOT_AUTHORITY_SEMANTIC, fallback: MESSAGE_ROOT_AUTHORITY_COMPAT },
      annotationsAvailable: base.annotationsAvailable,
      resolverAvailable: base.resolverAvailable,
      upstream: cloneValue(base.upstream) || {},
      lastDiagnostics: cloneValue(lastDiagnostics),
      errors: base.errors,
    };
  }

  var api = Object.freeze({
    __installed: true,
    version: VERSION,
    readonly: true,
    flagKey: FLAG_KEY,
    isEnabled: isEnabled,
    resolveForItem: resolveForItem,
    selfCheck: selfCheck,
    diagnose: diagnose,
  });

  H2O.Studio.readerNotes.highlightResolutionConsumer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
