// shared/knowledge/contracts-v0.js
//
// Lane: L-COCKPIT-KNOWLEDGE-MODEL
// Mission: knowledge-model-contract-foundation-v0 (T2)
//
// Pure, experimental v0 contract foundation for shared semantic references,
// anchors and provenance. Self-publishing IIFE on
// `H2O.Knowledge.ContractsV0`, matching the shared pure-core convention used
// by `shared/library/*-core.js`.
//
// EXPERIMENTAL v0 - these are runtime contracts, not durable serialized
// storage schemas and not a stable v1 API. `contractVersion` is 0. The
// individual contracts carry no independent persistence schema number
// because this layer introduces no persistent store and no migration.
//
// The seven admitted v0 contracts:
//
//   ItemRef            - owner-issued item identity, referenced not reminted
//   VersionRef         - owner-issued version identity of one ItemRef
//   SemanticBlockRef   - owner/source-issued block identity of one VersionRef
//   Anchor             - selectors scoped to exactly one SemanticBlockRef
//   Provenance         - semantic derivation/source lineage of an Excerpt
//   Excerpt            - exact resolved text, bound through Provenance
//   ReanchorResult     - same-version resolution outcome
//
// Ownership boundaries this module consumes but never redefines:
//
//   - Library / Chat Registry owns item identity.
//   - Saved Chats Storage owns saved-chat package/version identity.
//   - Authoring owns annotation/highlight lifecycle.
//   - Reader owns navigation; Renderer owns visual projection.
//   - Platform Sync owns propagation/convergence.
//
// This module is a CONSUMER of every one of those identities. Identity
// strings are never coerced, reminted, re-derived, hashed, parsed for
// meaning, or trimmed: a value that is not already a clean owner identity
// fails closed instead of being silently rewritten.
//
// PURITY (asserted by the T2 validator against comment-stripped source):
// no DOM, no browser or platform storage, no network, no persistence, no
// migration, no Sync, no clock, no randomness, no module loading, and no
// mutation of any caller-supplied input. Every constructor returns a
// detached plain object; every validator is fail-closed.
//
// XPath data may be preserved as opaque deferred compatibility bytes. v0
// does NOT resolve XPath and this module contains no resolver of any kind -
// resolution stays with the incumbent Reader & Notes anchor resolver.
//
// Public API (all pure):
//
//   contractVersion, VERSION, KINDS, REANCHOR_STATUSES, VERSION_SCOPE,
//   REANCHOR_VERSION_SCOPES, SELECTOR_FAMILIES, DEFERRED_SELECTOR_FAMILIES,
//   DERIVATIONS, supportsSelector(name), isDeferredSelector(name),
//   makeItemRef/validateItemRef, makeVersionRef/validateVersionRef,
//   makeSemanticBlockRef/validateSemanticBlockRef,
//   makeAnchor/validateAnchor, makeProvenance/validateProvenance,
//   makeExcerpt/validateExcerpt,
//   makeReanchorResult/validateReanchorResult,
//   sameReference(a, b), diagnose()

(function (global) {
  'use strict';

  const H2O = (global.H2O = global.H2O || {});
  H2O.Knowledge = H2O.Knowledge || {};
  if (H2O.Knowledge.ContractsV0 && H2O.Knowledge.ContractsV0.__installed) return;

  const CONTRACT_VERSION = 0;
  const VERSION = '0.1.0';

  const KINDS = Object.freeze({
    ITEM_REF: 'item_ref',
    VERSION_REF: 'version_ref',
    SEMANTIC_BLOCK_REF: 'semantic_block_ref',
    ANCHOR: 'anchor',
    PROVENANCE: 'provenance',
    EXCERPT: 'excerpt',
    REANCHOR_RESULT: 'reanchor_result',
  });

  const REANCHOR_STATUSES = Object.freeze(['anchored', 'reanchored', 'orphaned']);

  // Load-bearing v0 rule: a ReanchorResult only ever describes resolution
  // WITHIN the single supplied source version. True cross-version
  // re-anchoring is deferred and needs an explicit contract revision.
  const VERSION_SCOPE = 'same_version';
  const REANCHOR_VERSION_SCOPES = Object.freeze([VERSION_SCOPE]);

  // Selector families that v0 admits as resolvable, and the ones whose bytes
  // may be preserved without being resolvable.
  const SELECTOR_FAMILIES = Object.freeze(['textQuote', 'textPos']);
  const DEFERRED_SELECTOR_FAMILIES = Object.freeze(['xpath']);

  const DERIVATIONS = Object.freeze(['anchor_resolution']);

  // Frozen key sets. Unknown keys fail closed so that no field this contract
  // has not admitted - a second version reference above all - can ride along
  // inside an otherwise valid object.
  const ITEM_REF_KEYS = ['kind', 'itemKind', 'scheme', 'id'];
  const VERSION_REF_KEYS = ['kind', 'item', 'scheme', 'id'];
  const BLOCK_REF_KEYS = ['kind', 'version', 'blockKind', 'scheme', 'id'];
  const ANCHOR_KEYS = ['kind', 'target', 'selectors', 'deferredSelectors'];
  const TEXT_QUOTE_KEYS = ['exact', 'prefix', 'suffix', 'approx'];
  const TEXT_POS_KEYS = ['start', 'end'];
  const SPAN_KEYS = ['start', 'end'];
  const PROVENANCE_KEYS = ['kind', 'derivation', 'source'];
  const EXCERPT_KEYS = ['kind', 'text', 'provenance'];
  const REANCHOR_KEYS = [
    'kind', 'status', 'versionScope', 'anchor', 'span',
    'selectorUsed', 'confidence', 'reason', 'diagnostics',
  ];
  const DIAGNOSTICS_KEYS = ['tried', 'matchCount', 'approx', 'xpathDeferred', 'notes'];

  /* ── Primitive predicates ─────────────────────────────────────────────── */

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  // Identity-bearing strings: consumed verbatim from the owner. Surrounding
  // whitespace is a rejection, never a normalization, so no owner identity is
  // ever silently rewritten by this layer.
  function isIdentityString(value) {
    return typeof value === 'string' && value.length > 0 && value.trim() === value;
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function isIndex(value) {
    return typeof value === 'number' && Number.isInteger(value);
  }

  function isStringArray(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
  }

  function unknownKeys(value, allowed) {
    return Object.keys(value).filter((key) => allowed.indexOf(key) === -1);
  }

  // Constructor input gate. Constructors normalize, but they are fail-closed
  // on shape: an unadmitted key is rejected outright rather than silently
  // dropped, so a caller can never believe a field it supplied was kept.
  function admissible(input, allowedKeys, kind) {
    if (!isPlainObject(input)) return false;
    if (input.kind !== undefined && input.kind !== kind) return false;
    return unknownKeys(input, allowedKeys).length === 0;
  }

  // Detached opaque copy for data this layer preserves but does not interpret
  // (deferred XPath bytes). Anything not JSON-representable fails closed.
  function cloneOpaque(value) {
    try {
      const text = JSON.stringify(value);
      if (text === undefined) return { ok: false, value: null };
      return { ok: true, value: JSON.parse(text) };
    } catch (_e) {
      return { ok: false, value: null };
    }
  }

  // Deterministic, key-sorted serialization used only for structural
  // comparison of contract objects.
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${parts.join(',')}}`;
  }

  function sameReference(a, b) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    return stableStringify(a) === stableStringify(b);
  }

  function result(errors) {
    return { ok: errors.length === 0, errors: errors };
  }

  // Shared shape gate: plain object, exact admitted key set, correct kind.
  function checkEnvelope(value, kind, allowedKeys, errors) {
    if (!isPlainObject(value)) {
      errors.push(`${kind}/not-an-object`);
      return false;
    }
    unknownKeys(value, allowedKeys).forEach((key) => errors.push(`${kind}/unknown-key:${key}`));
    if (value.kind !== kind) errors.push(`${kind}.kind/invalid`);
    return true;
  }

  function checkIdentityField(value, path, errors) {
    if (!isIdentityString(value)) errors.push(`${path}/invalid`);
  }

  /* ── ItemRef ──────────────────────────────────────────────────────────── */

  function validateItemRef(value) {
    const errors = [];
    if (!checkEnvelope(value, KINDS.ITEM_REF, ITEM_REF_KEYS, errors)) return result(errors);
    checkIdentityField(value.itemKind, 'item_ref.itemKind', errors);
    checkIdentityField(value.scheme, 'item_ref.scheme', errors);
    checkIdentityField(value.id, 'item_ref.id', errors);
    return result(errors);
  }

  function makeItemRef(input) {
    if (!admissible(input, ITEM_REF_KEYS, KINDS.ITEM_REF)) return null;
    const out = {
      kind: KINDS.ITEM_REF,
      itemKind: input.itemKind,
      scheme: input.scheme,
      id: input.id,
    };
    return validateItemRef(out).ok ? out : null;
  }

  /* ── VersionRef ───────────────────────────────────────────────────────── */

  function validateVersionRef(value) {
    const errors = [];
    if (!checkEnvelope(value, KINDS.VERSION_REF, VERSION_REF_KEYS, errors)) return result(errors);
    const item = validateItemRef(value.item);
    if (!item.ok) errors.push(...item.errors.map((code) => `version_ref.item>${code}`));
    checkIdentityField(value.scheme, 'version_ref.scheme', errors);
    checkIdentityField(value.id, 'version_ref.id', errors);
    return result(errors);
  }

  function makeVersionRef(input) {
    if (!admissible(input, VERSION_REF_KEYS, KINDS.VERSION_REF)) return null;
    const item = makeItemRef(input.item);
    if (!item) return null;
    const out = {
      kind: KINDS.VERSION_REF,
      item: item,
      scheme: input.scheme,
      id: input.id,
    };
    return validateVersionRef(out).ok ? out : null;
  }

  /* ── SemanticBlockRef ─────────────────────────────────────────────────── */

  function validateSemanticBlockRef(value) {
    const errors = [];
    if (!checkEnvelope(value, KINDS.SEMANTIC_BLOCK_REF, BLOCK_REF_KEYS, errors)) return result(errors);
    const version = validateVersionRef(value.version);
    if (!version.ok) errors.push(...version.errors.map((code) => `semantic_block_ref.version>${code}`));
    checkIdentityField(value.blockKind, 'semantic_block_ref.blockKind', errors);
    checkIdentityField(value.scheme, 'semantic_block_ref.scheme', errors);
    checkIdentityField(value.id, 'semantic_block_ref.id', errors);
    return result(errors);
  }

  function makeSemanticBlockRef(input) {
    if (!admissible(input, BLOCK_REF_KEYS, KINDS.SEMANTIC_BLOCK_REF)) return null;
    const version = makeVersionRef(input.version);
    if (!version) return null;
    const out = {
      kind: KINDS.SEMANTIC_BLOCK_REF,
      version: version,
      blockKind: input.blockKind,
      scheme: input.scheme,
      id: input.id,
    };
    return validateSemanticBlockRef(out).ok ? out : null;
  }

  /* ── Anchor ───────────────────────────────────────────────────────────── */

  function validateTextQuote(quote, errors) {
    if (!isPlainObject(quote)) {
      errors.push('anchor.selectors.textQuote/invalid');
      return;
    }
    unknownKeys(quote, TEXT_QUOTE_KEYS)
      .forEach((key) => errors.push(`anchor.selectors.textQuote/unknown-key:${key}`));
    // Content strings are preserved verbatim - never trimmed, never
    // whitespace-normalized - because they must match source text exactly.
    if (typeof quote.exact !== 'string' || quote.exact.length === 0) {
      errors.push('anchor.selectors.textQuote.exact/invalid');
    }
    if (quote.prefix !== undefined && typeof quote.prefix !== 'string') {
      errors.push('anchor.selectors.textQuote.prefix/invalid');
    }
    if (quote.suffix !== undefined && typeof quote.suffix !== 'string') {
      errors.push('anchor.selectors.textQuote.suffix/invalid');
    }
    if (quote.approx !== undefined && !isFiniteNumber(quote.approx)) {
      errors.push('anchor.selectors.textQuote.approx/invalid');
    }
  }

  function validateTextPos(pos, errors) {
    if (!isPlainObject(pos)) {
      errors.push('anchor.selectors.textPos/invalid');
      return;
    }
    unknownKeys(pos, TEXT_POS_KEYS)
      .forEach((key) => errors.push(`anchor.selectors.textPos/unknown-key:${key}`));
    if (!isIndex(pos.start) || !isIndex(pos.end)) {
      errors.push('anchor.selectors.textPos/malformed');
      return;
    }
    if (pos.start < 0 || pos.start >= pos.end) errors.push('anchor.selectors.textPos/out-of-range');
  }

  function validateAnchor(value) {
    const errors = [];
    if (!checkEnvelope(value, KINDS.ANCHOR, ANCHOR_KEYS, errors)) return result(errors);

    const target = validateSemanticBlockRef(value.target);
    if (!target.ok) errors.push(...target.errors.map((code) => `anchor.target>${code}`));

    if (!isPlainObject(value.selectors)) {
      errors.push('anchor.selectors/invalid');
    } else {
      // Unknown selector families fail closed until a contract revision
      // admits them.
      unknownKeys(value.selectors, SELECTOR_FAMILIES)
        .forEach((key) => errors.push(`anchor.selectors/unknown-family:${key}`));
      validateTextQuote(value.selectors.textQuote, errors);
      if (value.selectors.textPos !== undefined) validateTextPos(value.selectors.textPos, errors);
    }

    if (value.deferredSelectors !== undefined) {
      if (!isPlainObject(value.deferredSelectors)) {
        errors.push('anchor.deferredSelectors/invalid');
      } else {
        unknownKeys(value.deferredSelectors, DEFERRED_SELECTOR_FAMILIES)
          .forEach((key) => errors.push(`anchor.deferredSelectors/unknown-family:${key}`));
      }
    }

    return result(errors);
  }

  function makeAnchor(input) {
    if (!admissible(input, ANCHOR_KEYS, KINDS.ANCHOR)) return null;
    const target = makeSemanticBlockRef(input.target);
    if (!target) return null;
    if (!isPlainObject(input.selectors)) return null;
    if (unknownKeys(input.selectors, SELECTOR_FAMILIES).length) return null;

    const quote = input.selectors.textQuote;
    if (!isPlainObject(quote)) return null;
    if (unknownKeys(quote, TEXT_QUOTE_KEYS).length) return null;
    const outQuote = { exact: quote.exact };
    if (quote.prefix !== undefined) outQuote.prefix = quote.prefix;
    if (quote.suffix !== undefined) outQuote.suffix = quote.suffix;
    if (quote.approx !== undefined) outQuote.approx = quote.approx;

    const selectors = { textQuote: outQuote };
    if (input.selectors.textPos !== undefined) {
      const pos = input.selectors.textPos;
      if (!isPlainObject(pos)) return null;
      if (unknownKeys(pos, TEXT_POS_KEYS).length) return null;
      selectors.textPos = { start: pos.start, end: pos.end };
    }

    const out = { kind: KINDS.ANCHOR, target: target, selectors: selectors };

    if (input.deferredSelectors !== undefined) {
      const deferred = input.deferredSelectors;
      if (!isPlainObject(deferred)) return null;
      if (unknownKeys(deferred, DEFERRED_SELECTOR_FAMILIES).length) return null;
      if (deferred.xpath !== undefined) {
        // Opaque compatibility bytes only. Preserving them grants no
        // resolver capability: see supportsSelector().
        const cloned = cloneOpaque(deferred.xpath);
        if (!cloned.ok) return null;
        out.deferredSelectors = { xpath: cloned.value };
      }
    }

    return validateAnchor(out).ok ? out : null;
  }

  function supportsSelector(name) {
    return SELECTOR_FAMILIES.indexOf(name) !== -1;
  }

  function isDeferredSelector(name) {
    return DEFERRED_SELECTOR_FAMILIES.indexOf(name) !== -1;
  }

  /* ── Provenance ───────────────────────────────────────────────────────── */

  function validateProvenance(value) {
    const errors = [];
    if (!checkEnvelope(value, KINDS.PROVENANCE, PROVENANCE_KEYS, errors)) return result(errors);
    if (DERIVATIONS.indexOf(value.derivation) === -1) errors.push('provenance.derivation/invalid');
    const source = validateAnchor(value.source);
    if (!source.ok) errors.push(...source.errors.map((code) => `provenance.source>${code}`));
    return result(errors);
  }

  function makeProvenance(input) {
    if (!admissible(input, PROVENANCE_KEYS, KINDS.PROVENANCE)) return null;
    const source = makeAnchor(input.source);
    if (!source) return null;
    const out = {
      kind: KINDS.PROVENANCE,
      derivation: input.derivation,
      source: source,
    };
    return validateProvenance(out).ok ? out : null;
  }

  /* ── Excerpt ──────────────────────────────────────────────────────────── */

  function validateExcerpt(value) {
    const errors = [];
    if (!checkEnvelope(value, KINDS.EXCERPT, EXCERPT_KEYS, errors)) return result(errors);
    // Exact resolved text: verbatim, never normalized for display.
    if (typeof value.text !== 'string' || value.text.length === 0) errors.push('excerpt.text/invalid');
    const provenance = validateProvenance(value.provenance);
    if (!provenance.ok) errors.push(...provenance.errors.map((code) => `excerpt.provenance>${code}`));
    return result(errors);
  }

  // `options.anchor`, when supplied, must be the very Anchor the excerpt was
  // resolved from; a provenance that points somewhere else fails closed.
  function makeExcerpt(input, options) {
    if (!admissible(input, EXCERPT_KEYS, KINDS.EXCERPT)) return null;
    const provenance = makeProvenance(input.provenance);
    if (!provenance) return null;
    const opts = isPlainObject(options) ? options : {};
    if (opts.anchor !== undefined) {
      const expected = makeAnchor(opts.anchor);
      if (!expected || !sameReference(expected, provenance.source)) return null;
    }
    const out = {
      kind: KINDS.EXCERPT,
      text: input.text,
      provenance: provenance,
    };
    return validateExcerpt(out).ok ? out : null;
  }

  /* ── ReanchorResult ───────────────────────────────────────────────────── */

  function validateSpan(span, errors) {
    if (!isPlainObject(span)) {
      errors.push('reanchor_result.span/invalid');
      return;
    }
    unknownKeys(span, SPAN_KEYS).forEach((key) => errors.push(`reanchor_result.span/unknown-key:${key}`));
    if (!isIndex(span.start) || !isIndex(span.end)) {
      errors.push('reanchor_result.span/malformed');
      return;
    }
    if (span.start < 0 || span.start >= span.end) errors.push('reanchor_result.span/out-of-range');
  }

  function validateDiagnostics(diagnostics, errors) {
    if (!isPlainObject(diagnostics)) {
      errors.push('reanchor_result.diagnostics/invalid');
      return;
    }
    unknownKeys(diagnostics, DIAGNOSTICS_KEYS)
      .forEach((key) => errors.push(`reanchor_result.diagnostics/unknown-key:${key}`));
    if (!isStringArray(diagnostics.tried)) errors.push('reanchor_result.diagnostics.tried/invalid');
    if (!isIndex(diagnostics.matchCount) || diagnostics.matchCount < 0) {
      errors.push('reanchor_result.diagnostics.matchCount/invalid');
    }
    if (diagnostics.approx !== null && !isFiniteNumber(diagnostics.approx)) {
      errors.push('reanchor_result.diagnostics.approx/invalid');
    }
    if (typeof diagnostics.xpathDeferred !== 'boolean') {
      errors.push('reanchor_result.diagnostics.xpathDeferred/invalid');
    }
    if (!isStringArray(diagnostics.notes)) errors.push('reanchor_result.diagnostics.notes/invalid');
  }

  // Status/selector coherence, frozen from the incumbent resolver:
  //   anchored   <- same-version exact/approx textQuote resolution
  //   reanchored <- same-version validated textPos fallback only
  //   orphaned   <- fail closed, no span and no selector
  function validateStatusCoherence(value, errors) {
    if (value.status === 'orphaned') {
      if (value.span !== null) errors.push('reanchor_result/orphaned-with-span');
      if (value.selectorUsed !== null) errors.push('reanchor_result/orphaned-with-selector');
      return;
    }
    if (value.span === null) errors.push('reanchor_result/resolved-without-span');
    if (value.status === 'anchored' && value.selectorUsed !== 'textQuote') {
      errors.push('reanchor_result/anchored-selector-mismatch');
    }
    if (value.status === 'reanchored' && value.selectorUsed !== 'textPos') {
      errors.push('reanchor_result/reanchored-selector-mismatch');
    }
  }

  function validateReanchorResult(value) {
    const errors = [];
    if (!checkEnvelope(value, KINDS.REANCHOR_RESULT, REANCHOR_KEYS, errors)) return result(errors);

    if (REANCHOR_STATUSES.indexOf(value.status) === -1) errors.push('reanchor_result.status/invalid');
    // Fixed for v0: no result may claim any other version scope.
    if (value.versionScope !== VERSION_SCOPE) errors.push('reanchor_result.versionScope/invalid');

    const anchor = validateAnchor(value.anchor);
    if (!anchor.ok) errors.push(...anchor.errors.map((code) => `reanchor_result.anchor>${code}`));

    if (value.span !== null) validateSpan(value.span, errors);
    if (value.selectorUsed !== null && !supportsSelector(value.selectorUsed)) {
      errors.push('reanchor_result.selectorUsed/invalid');
    }
    if (!isFiniteNumber(value.confidence)) errors.push('reanchor_result.confidence/invalid');
    if (typeof value.reason !== 'string') errors.push('reanchor_result.reason/invalid');
    validateDiagnostics(value.diagnostics, errors);

    if (errors.length === 0) validateStatusCoherence(value, errors);
    return result(errors);
  }

  function shapeDiagnostics(input) {
    if (input === undefined) {
      return { tried: [], matchCount: 0, approx: null, xpathDeferred: false, notes: [] };
    }
    if (!isPlainObject(input)) return null;
    if (unknownKeys(input, DIAGNOSTICS_KEYS).length) return null;
    return {
      tried: Array.isArray(input.tried) ? input.tried.slice() : input.tried,
      matchCount: input.matchCount,
      approx: input.approx === undefined ? null : input.approx,
      xpathDeferred: input.xpathDeferred === undefined ? false : input.xpathDeferred,
      notes: Array.isArray(input.notes) ? input.notes.slice() : input.notes,
    };
  }

  function makeReanchorResult(input) {
    if (!admissible(input, REANCHOR_KEYS, KINDS.REANCHOR_RESULT)) return null;
    // A supplied versionScope may only restate the fixed v0 value.
    if (input.versionScope !== undefined && input.versionScope !== VERSION_SCOPE) return null;
    const anchor = makeAnchor(input.anchor);
    if (!anchor) return null;

    let span = null;
    if (input.span !== undefined && input.span !== null) {
      if (!isPlainObject(input.span)) return null;
      if (unknownKeys(input.span, SPAN_KEYS).length) return null;
      span = { start: input.span.start, end: input.span.end };
    }

    const diagnostics = shapeDiagnostics(input.diagnostics);
    if (!diagnostics) return null;

    const out = {
      kind: KINDS.REANCHOR_RESULT,
      status: input.status,
      versionScope: VERSION_SCOPE,
      anchor: anchor,
      span: span,
      selectorUsed: input.selectorUsed === undefined ? null : input.selectorUsed,
      confidence: input.confidence,
      reason: input.reason,
      diagnostics: diagnostics,
    };
    return validateReanchorResult(out).ok ? out : null;
  }

  /* ── Diagnose ─────────────────────────────────────────────────────────── */

  function diagnose() {
    return {
      ok: true,
      module: 'knowledge/contracts-v0',
      lane: 'L-COCKPIT-KNOWLEDGE-MODEL',
      version: VERSION,
      contractVersion: CONTRACT_VERSION,
      experimental: true,
      pure: true,
      contracts: Object.keys(KINDS).map((key) => KINDS[key]),
      selectors: {
        active: SELECTOR_FAMILIES.slice(),
        deferred: DEFERRED_SELECTOR_FAMILIES.slice(),
        resolvesDeferred: false,
        resolverIncluded: false,
      },
      reanchor: {
        statuses: REANCHOR_STATUSES.slice(),
        versionScopes: REANCHOR_VERSION_SCOPES.slice(),
        crossVersion: false,
      },
      sideEffects: {
        dom: false,
        storage: false,
        network: false,
        persistence: false,
        migrations: false,
        propagation: false,
        writes: false,
        clock: false,
        randomness: false,
        inputMutation: false,
      },
      runtimeWired: false,
      adaptersWired: false,
    };
  }

  const ContractsV0 = Object.freeze({
    __installed: true,
    contractVersion: CONTRACT_VERSION,
    VERSION,
    KINDS,
    REANCHOR_STATUSES,
    VERSION_SCOPE,
    REANCHOR_VERSION_SCOPES,
    SELECTOR_FAMILIES,
    DEFERRED_SELECTOR_FAMILIES,
    DERIVATIONS,
    supportsSelector,
    isDeferredSelector,
    makeItemRef,
    validateItemRef,
    makeVersionRef,
    validateVersionRef,
    makeSemanticBlockRef,
    validateSemanticBlockRef,
    makeAnchor,
    validateAnchor,
    makeProvenance,
    validateProvenance,
    makeExcerpt,
    validateExcerpt,
    makeReanchorResult,
    validateReanchorResult,
    sameReference,
    diagnose,
  });

  H2O.Knowledge.ContractsV0 = ContractsV0;
  H2O.KnowledgeContractsV0 = ContractsV0;
})(typeof globalThis !== 'undefined' ? globalThis : this);
