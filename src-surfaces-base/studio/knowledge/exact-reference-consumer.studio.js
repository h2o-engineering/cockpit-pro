/* H2O Studio — Knowledge Model — exact-reference runtime consumer (v0).
 *
 * Lane: L-COCKPIT-KNOWLEDGE-MODEL
 * Mission: knowledge-model-current-main-semantic-runtime-convergence-v0 (T3)
 *
 * Read-only, explicitly-invoked composition of EXISTING owner output into the
 * accepted Knowledge Model v0 semantic chain:
 *
 *   captured-chat Library identity        (Reader & Notes typed view)
 *   + verified immutable generation id    (Saved Chats coverage)
 *   + attributed highlight selectors      (annotation facade)
 *   + incumbent Reader resolution         (highlight resolution consumer)
 *       -> ItemRef -> VersionRef -> SemanticBlockRef -> Anchor
 *       -> ReanchorResult -> Excerpt + Provenance
 *
 * OWNERSHIP. This module composes; it does not resolve and it does not own
 * identity. Reader keeps flattening, matching, Range creation, resolved source
 * text and navigation. Authoring keeps annotation lifecycle. Library keeps
 * captured-chat identity. Saved Chats keeps package/version identity. Every
 * construction is delegated to the accepted Knowledge contracts and adapter —
 * none of their logic is reimplemented here.
 *
 * WHY IT LIVES UNDER studio/. It must read `H2O.Studio.*` owner namespaces at
 * call time, which shared/knowledge/ deliberately never does. Physical
 * placement carries no semantics: the ownership map is explicit that Studio
 * placement does not transfer feature ownership away from this Lane.
 *
 * VERSION AUTHORITY — load-bearing. A VersionRef is admitted only from
 * `coverage.selected.contentHash`, and only when the owner's coverage verdict
 * is positive and the selection is a verified fresh generation. Saved Chats
 * compares its bare selected digest with the possibly prefixed projection
 * digest internally; Knowledge never compares or normalizes those strings.
 * `projection.contentHash` alone is the identity
 * of MUTABLE live state and can never establish a VersionRef on its own;
 * `bestHistorical` is presentation-only and is never read here. This module
 * computes no hash, enumerates no package, parses no filename, reads no
 * timestamp, and never chooses between generations — the owner already did.
 * `covered` is tri-state and a null is reported as indeterminate, never as
 * false.
 *
 * EXCERPT TEXT is the Reader row's own `text`. The incumbent DOM wrapper only
 * returns a range whose `toString()` equals the flattened plain text at the
 * resolved span, so that string IS the exact resolved substring. It is never
 * the stored `textQuote.exact`, a preview, a body, or a re-slice performed
 * here — this module never touches the DOM at all.
 *
 * READ-ONLY / INERT. Installing this file attaches one frozen namespace and
 * does nothing else: no owner API is called, no work is scheduled, no flag is
 * changed. `describeForItemV1` runs only when called, and only when
 * 'studio.knowledge.exactReferences.enabled' is explicitly true. There is no
 * watcher, poller, daemon, startup pass, persistence, storage, network,
 * navigation or write-back of any kind, and `root` is forwarded to Reader as
 * an opaque handle that is never queried or mutated here.
 *
 * The returned envelope is a bounded serializable report — not an eighth v0
 * contract. It never carries a live Range and never carries the policy token.
 *
 * Feature flag: 'studio.knowledge.exactReferences.enabled', default OFF.
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.knowledge = H2O.Studio.knowledge || {};

  if (H2O.Studio.knowledge.exactReferences && H2O.Studio.knowledge.exactReferences.__installed) {
    return;
  }

  var VERSION = 1;
  var SCHEMA_VERSION = 1;
  var CONTRACT_VERSION = 0;
  var FLAG_KEY = 'studio.knowledge.exactReferences.enabled';

  /* Bounded diagnostics only. */
  var SKIP_MAX = 50;
  var ERR_MAX = 20;
  var errors = [];

  function recordError(op) {
    try {
      // Owner errors may contain private chat data or a policy token. Keep only
      // the fixed operation label; the public failure reason stays bounded.
      errors.push({ op: String(op) });
      if (errors.length > ERR_MAX) errors.splice(0, errors.length - ERR_MAX);
    } catch (_) { /* swallow */ }
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  /* Identity strings are consumed verbatim: surrounding whitespace is a
   * rejection, never a normalization. Same rule the v0 contracts apply. */
  function isCleanString(value) {
    return typeof value === 'string' && value.length > 0 && value.trim() === value;
  }

  function strOrNull(value) {
    return (value == null) ? null : String(value);
  }

  /* ── Lazy, defensive dependency accessors ─────────────────────────────── */

  function contractsApi() {
    var api = H2O.Knowledge && H2O.Knowledge.ContractsV0;
    return (api && api.__installed === true) ? api : null;
  }
  function adapterApi() {
    var api = H2O.Knowledge && H2O.Knowledge.CapturedChatHighlightAdapterV0;
    return (api && api.__installed === true) ? api : null;
  }
  function libraryItemsApi() {
    var api = H2O.Studio.readerNotes && H2O.Studio.readerNotes.libraryItems;
    return (api && typeof api.get === 'function') ? api : null;
  }
  function annotationsApi() {
    var api = H2O.Studio.readerNotes && H2O.Studio.readerNotes.annotations;
    return (api && typeof api.listForItem === 'function') ? api : null;
  }
  function resolutionApi() {
    var api = H2O.Studio.readerNotes && H2O.Studio.readerNotes.highlightResolutionConsumer;
    return (api && typeof api.resolveForItem === 'function') ? api : null;
  }
  function coverageApi() {
    var fn = H2O.Studio.ingestion && H2O.Studio.ingestion.describeSavedChatCoverageV1;
    return (typeof fn === 'function') ? fn : null;
  }

  function isEnabled() {
    try {
      var flags = H2O && H2O.flags;
      if (!flags || typeof flags.get !== 'function') return false;   /* fail closed */
      return flags.get(FLAG_KEY, false) === true;
    } catch (e) {
      recordError('isEnabled', e);
      return false;
    }
  }

  /* ── Envelope helpers ─────────────────────────────────────────────────── */

  function envelope(ok, reason, extra) {
    var out = {
      schemaVersion: SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      ok: ok === true,
      reason: reason || '',
      itemRef: null,
      versionRef: null,
      references: [],
      skipped: [],
      diagnostics: {
        enabled: false,
        considered: 0,
        referenced: 0,
        excerpted: 0,
        orphaned: 0,
        skippedCount: 0,
        coverageCalls: 0,
        versionScope: null,
        deps: {},
        errors: errors.slice(),
      },
    };
    if (isPlainObject(extra)) {
      Object.keys(extra).forEach(function (key) {
        if (key === 'diagnostics') {
          Object.keys(extra.diagnostics).forEach(function (d) { out.diagnostics[d] = extra.diagnostics[d]; });
        } else {
          out[key] = extra[key];
        }
      });
    }
    return out;
  }

  function fail(reason, extra) {
    return envelope(false, reason, extra);
  }

  /* ── Saved-Chat version authority ─────────────────────────────────────── */

  /* Translate the owner's tri-state verdict into an exact reason. `covered`
   * null means the owner could not assert either way and must never be read
   * as false. */
  function coverageBlockReason(coverage) {
    var reason = typeof coverage.reason === 'string' ? coverage.reason : '';
    if (coverage.covered === false) return 'not-covered';
    if (coverage.covered !== true) {
      if (reason === 'no-current-snapshot') return 'no-current-snapshot';
      if (reason === 'discovery-incomplete') return 'coverage-incomplete';
      if (reason === 'archive-integrity-unavailable') return 'coverage-unavailable';
      if (reason === 'chat-id-required') return 'coverage-chat-id-required';
      if (reason.indexOf('projection-') === 0) return 'projection-indeterminate';
      return 'coverage-indeterminate';
    }
    return '';
  }

  /* The only admitted source of a v0 VersionRef identity. Every branch here
   * refuses rather than substituting a weaker identity. */
  function versionIdentityFrom(coverage, chatId) {
    if (!isPlainObject(coverage)) return { ok: false, reason: 'coverage-invalid' };
    if (coverage.chatId !== chatId) return { ok: false, reason: 'coverage-chat-mismatch' };

    var blocked = coverageBlockReason(coverage);
    if (blocked) return { ok: false, reason: blocked };
    if (coverage.reason !== '') return { ok: false, reason: 'coverage-inconsistent' };

    var selected = coverage.selected;
    if (!isPlainObject(selected)) return { ok: false, reason: 'version-identity-unavailable' };
    if (selected.status !== 'ok') return { ok: false, reason: 'version-identity-not-verified' };
    if (selected.chatId !== chatId) return { ok: false, reason: 'version-identity-chat-mismatch' };
    /* A fresh LEGACY package is a valid package but not a generation, and the
     * frozen scheme names the generation identity space. Fail closed rather
     * than misname it. */
    if (selected.classification !== 'generation') return { ok: false, reason: 'version-identity-not-generation' };
    if (typeof selected.contentHash !== 'string'
      || !/^[0-9a-f]{64}$/.test(selected.contentHash)) {
      return { ok: false, reason: 'version-identity-malformed' };
    }

    var projection = coverage.projection;
    if (!isPlainObject(projection)) return { ok: false, reason: 'projection-identity-missing' };
    if (projection.status !== 'ok') return { ok: false, reason: 'projection-indeterminate' };
    if (!isCleanString(projection.contentHash)) return { ok: false, reason: 'projection-identity-malformed' };
    /* Current coverage returns selected as one of its own fresh entry objects.
     * Check that owner-result consistency without reselecting a generation or
     * comparing either content hash to the projection hash. */
    if (!Array.isArray(coverage.fresh) || coverage.fresh.indexOf(selected) === -1) {
      return { ok: false, reason: 'version-selection-inconsistent' };
    }
    /* The owner's covered=true verdict asserts freshness. The returned hashes
     * use different allowed representations, so comparison here would create
     * a second, incorrect freshness authority. */
    return { ok: true, contentHash: selected.contentHash };
  }

  /* ── Annotation join ──────────────────────────────────────────────────── */

  /* Join is by owner annotation id only. A duplicated id is ambiguous and is
   * refused rather than resolved by picking one. */
  function annotationIndex(annotations) {
    var byId = Object.create(null);
    var ambiguous = Object.create(null);
    for (var i = 0; i < annotations.length; i += 1) {
      var annotation = annotations[i];
      if (!isPlainObject(annotation)) continue;
      var id = isCleanString(annotation.id) ? annotation.id : null;
      if (!id) continue;
      if (Object.prototype.hasOwnProperty.call(byId, id)) { ambiguous[id] = true; continue; }
      byId[id] = annotation;
    }
    return { byId: byId, ambiguous: ambiguous };
  }

  /* ── Per-row composition ──────────────────────────────────────────────── */

  function composeRow(ctx, row) {
    var annotationId = row && isCleanString(row.annotationId) ? row.annotationId : null;
    if (!isPlainObject(row) || !annotationId) {
      return { skipped: { annotationId: annotationId, reason: 'row-invalid' } };
    }
    if (Object.prototype.hasOwnProperty.call(ctx.index.ambiguous, annotationId)) {
      return { skipped: { annotationId: annotationId, reason: 'annotation-ambiguous' } };
    }
    var annotation = Object.prototype.hasOwnProperty.call(ctx.index.byId, annotationId)
      ? ctx.index.byId[annotationId]
      : null;
    if (!annotation) {
      return { skipped: { annotationId: annotationId, reason: 'annotation-not-found' } };
    }

    /* Block identity and selectors come from the owner annotation — never
     * reconstructed from the Reader row's text. */
    var blockRef = ctx.adapter.buildSemanticBlockRef(ctx.versionRef, annotation);
    if (!blockRef) {
      return { skipped: { annotationId: annotationId, reason: 'block-ref-unavailable' } };
    }
    if (row.answerId !== blockRef.id) {
      return { skipped: { annotationId: annotationId, reason: 'row-answer-mismatch' } };
    }
    var anchors = isPlainObject(annotation.raw) ? annotation.raw.anchors : null;
    var anchor = ctx.adapter.buildAnchor(blockRef, anchors);
    if (!anchor) {
      return { skipped: { annotationId: annotationId, reason: 'anchor-unavailable' } };
    }

    var result = ctx.adapter.mapResolverResult(anchor, row);
    if (!result) {
      return { skipped: { annotationId: annotationId, reason: 'result-unmappable' } };
    }

    var excerpt = null;
    if (ctx.adapter.RESOLVED_STATUSES.indexOf(result.status) !== -1) {
      /* Reader's own resolved text, verbatim. No normalization, no quote
       * substitution, no re-slice. */
      if (typeof row.text !== 'string' || row.text.length === 0) {
        return { skipped: { annotationId: annotationId, reason: 'resolved-text-unavailable' } };
      }
      var provenance = ctx.contracts.makeProvenance({
        derivation: ctx.adapter.DERIVATION,
        source: anchor,
      });
      if (!provenance) {
        return { skipped: { annotationId: annotationId, reason: 'provenance-unavailable' } };
      }
      excerpt = ctx.contracts.makeExcerpt({ text: row.text, provenance: provenance }, { anchor: anchor });
      if (!excerpt) {
        return { skipped: { annotationId: annotationId, reason: 'excerpt-unavailable' } };
      }
    }

    return {
      reference: {
        annotationId: annotationId,
        answerId: blockRef.id,
        blockRef: blockRef,
        anchor: anchor,
        result: result,
        excerpt: excerpt,
      },
    };
  }

  /* ── Public read API ──────────────────────────────────────────────────── */

  async function describeForItemV1(itemId, root, options) {
    if (!isEnabled()) return fail('disabled');
    try {
      var opts = isPlainObject(options) ? options : {};
      var id = itemId;
      if (!isCleanString(id)) return fail('invalid-item-id');

      var contracts = contractsApi();
      var adapter = adapterApi();
      var items = libraryItemsApi();
      var annotations = annotationsApi();
      var resolution = resolutionApi();
      var describeCoverage = coverageApi();
      var deps = {
        contracts: !!contracts,
        adapter: !!adapter,
        libraryItems: !!items,
        annotations: !!annotations,
        resolutionConsumer: !!resolution,
        coverage: !!describeCoverage,
      };
      var depDiag = { diagnostics: { enabled: true, deps: deps } };

      if (!contracts) return fail('contracts-unavailable', depDiag);
      if (!adapter) return fail('adapter-unavailable', depDiag);
      if (!items) return fail('library-items-unavailable', depDiag);
      if (!describeCoverage) return fail('coverage-unavailable', depDiag);
      if (!annotations) return fail('annotations-unavailable', depDiag);
      if (!resolution) return fail('resolution-consumer-unavailable', depDiag);

      /* 1. Owner-issued captured-chat identity. */
      var item;
      try {
        item = items.get(id);
      } catch (e) {
        recordError('libraryItems.get', e);
        return fail('item-lookup-failed', depDiag);
      }
      if (!isPlainObject(item)) return fail('item-not-found', depDiag);

      var itemRef = adapter.buildItemRef(item);
      if (!itemRef) return fail('item-identity-unusable', depDiag);
      if (itemRef.id !== id) return fail('item-identity-mismatch', depDiag);
      var chatId = itemRef.id;

      /* 2. Saved-Chats verified immutable generation identity. Exactly one
       * coverage call per describe operation; the policy token is forwarded
       * unchanged and never inspected, cached or reported. */
      var coverage;
      try {
        coverage = await describeCoverage({ chatId: chatId }, opts.policyToken);
      } catch (e) {
        recordError('describeSavedChatCoverageV1', e);
        return fail('coverage-failed', {
          itemRef: itemRef,
          diagnostics: { enabled: true, deps: deps, coverageCalls: 1 },
        });
      }
      var covDiag = { itemRef: itemRef, diagnostics: { enabled: true, deps: deps, coverageCalls: 1 } };

      var version = versionIdentityFrom(coverage, chatId);
      if (!version.ok) return fail(version.reason, covDiag);

      var versionRef = adapter.buildVersionRef(item, version.contentHash);
      if (!versionRef) return fail('version-ref-unavailable', covDiag);

      /* 3. Owner annotations, for selectors and block identity only. */
      var annotationList;
      try {
        annotationList = annotations.listForItem(id, { kind: 'highlight' });
      } catch (e) {
        recordError('annotations.listForItem', e);
        return fail('annotations-failed', covDiag);
      }
      if (!Array.isArray(annotationList)) return fail('annotations-invalid', covDiag);

      /* 4. Incumbent Reader resolution. `root` is forwarded untouched. */
      var resolved;
      try {
        resolved = resolution.resolveForItem(id, root, isPlainObject(opts.resolutionOptions) ? opts.resolutionOptions : {});
      } catch (e) {
        recordError('highlightResolutionConsumer.resolveForItem', e);
        return fail('resolution-failed', covDiag);
      }
      if (!isPlainObject(resolved)) return fail('resolution-invalid', covDiag);
      if (resolved.itemId !== id
        || !Array.isArray(resolved.resolved)
        || !Array.isArray(resolved.unresolved)) return fail('resolution-invalid', covDiag);
      if (!isPlainObject(resolved.diagnostics)
        || !isCleanString(resolved.diagnostics.reason)) return fail('resolution-invalid', covDiag);
      if (resolved.diagnostics.reason !== 'ok') return fail('resolution-unavailable', covDiag);

      var rows = resolved.resolved.concat(resolved.unresolved);

      var ctx = {
        contracts: contracts,
        adapter: adapter,
        versionRef: versionRef,
        index: annotationIndex(annotationList),
      };

      var references = [];
      var skipped = [];
      var excerpted = 0;
      var orphaned = 0;
      for (var i = 0; i < rows.length; i += 1) {
        var composed = composeRow(ctx, rows[i]);
        if (composed.reference) {
          references.push(composed.reference);
          if (composed.reference.excerpt) excerpted += 1;
          else orphaned += 1;
        } else if (composed.skipped && skipped.length < SKIP_MAX) {
          skipped.push(composed.skipped);
        } else if (composed.skipped) {
          skipped.length = SKIP_MAX;
        }
      }

      return envelope(true, '', {
        itemRef: itemRef,
        versionRef: versionRef,
        references: references,
        skipped: skipped,
        diagnostics: {
          enabled: true,
          considered: rows.length,
          referenced: references.length,
          excerpted: excerpted,
          orphaned: orphaned,
          skippedCount: skipped.length,
          coverageCalls: 1,
          versionScope: contracts.VERSION_SCOPE,
          deps: deps,
          resolutionReason: strOrNull(isPlainObject(resolved.diagnostics) ? resolved.diagnostics.reason : null),
        },
      });
    } catch (e) {
      recordError('describeForItemV1', e);
      return fail('consumer-error');
    }
  }

  function selfCheck() {
    return {
      ok: errors.length === 0,
      version: VERSION,
      readonly: true,
      schemaVersion: SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      flagKey: FLAG_KEY,
      enabled: isEnabled(),
      deps: {
        contracts: !!contractsApi(),
        adapter: !!adapterApi(),
        libraryItems: !!libraryItemsApi(),
        annotations: !!annotationsApi(),
        resolutionConsumer: !!resolutionApi(),
        coverage: !!coverageApi(),
      },
      errors: errors.slice(),
    };
  }

  function diagnose() {
    var base = selfCheck();
    return {
      ok: base.ok,
      version: VERSION,
      module: 'knowledge/exact-reference-consumer',
      lane: 'L-COCKPIT-KNOWLEDGE-MODEL',
      readonly: true,
      flagKey: FLAG_KEY,
      enabled: base.enabled,
      supported: ['describeForItemV1'],
      deps: base.deps,
      versionAuthority: {
        source: 'savedChatCoverage.selected.contentHash',
        scheme: 'saved-chat/generation-content-hash',
        requiresGeneration: true,
        requiresOwnerConfirmedFreshness: true,
        comparesReturnedHashes: false,
        usesProjectionHashAlone: false,
        usesBestHistorical: false,
        computesHash: false,
        enumeratesPackages: false,
        selectsGeneration: false,
      },
      excerptText: 'reader-row-text',
      resolutionOwner: 'readerNotes.highlightResolutionConsumer',
      reimplementsResolver: false,
      sideEffects: {
        dom: false,
        storage: false,
        network: false,
        persistence: false,
        navigation: false,
        writeBack: false,
        watchers: false,
        pollers: false,
        startupWork: false,
      },
      errors: base.errors,
    };
  }

  var api = Object.freeze({
    __installed: true,
    version: VERSION,
    readonly: true,
    schemaVersion: SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    flagKey: FLAG_KEY,
    isEnabled: isEnabled,
    describeForItemV1: describeForItemV1,
    selfCheck: selfCheck,
    diagnose: diagnose,
  });

  H2O.Studio.knowledge.exactReferences = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
