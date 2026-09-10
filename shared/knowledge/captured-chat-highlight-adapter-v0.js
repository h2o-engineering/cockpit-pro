// shared/knowledge/captured-chat-highlight-adapter-v0.js
//
// Lane: L-COCKPIT-KNOWLEDGE-MODEL
// Mission: knowledge-model-contract-foundation-v0 (T3)
//
// READ-ONLY compatibility adapter: the thinnest semantic path from existing
// captured-chat / highlight owner data to the Knowledge Model v0 contracts
// and back out again as an exact Excerpt.
//
//   captured_chat LibraryItem  ->  ItemRef
//   owner-verified contentHash ->  VersionRef
//   highlight source.answerId  ->  SemanticBlockRef
//   highlight raw.anchors      ->  Anchor  (xpath preserved as deferred)
//                              ->  [incumbent anchor resolver, unchanged]
//                              ->  ReanchorResult (same_version)
//                              ->  Excerpt + Provenance (successes only)
//
// WHAT THIS ADAPTER IS NOT ALLOWED TO DO
//
// It performs semantic conversion only. It never invents, derives, parses or
// recomputes an owner identity:
//
//   - chatId comes from Library / Chat Registry authority, never from an
//     answerId, a DOM node, or a saved-chat filename;
//   - the version id is the verified generation contentHash the CALLER
//     supplies. Its grammar is Saved Chats Storage's to define, so this layer
//     references the string and deliberately does not parse or re-derive it;
//   - the block id is the existing message/answer id, never minted here;
//   - attribution is read from the annotation, never inferred.
//
// Any missing, malformed or self-contradictory owner input fails closed with
// a reason code. Nothing is guessed.
//
// RESOLUTION is delegated whole to the incumbent Reader & Notes anchor
// resolver, which is INJECTED (`options.resolver`) rather than looked up.
// This module therefore has no Studio dependency, no runtime wiring, and no
// bootstrap registration, and it reimplements none of the matching algorithm.
// `anchored`/`reanchored`/`orphaned` are mapped through verbatim; the v0
// `versionScope` stays `same_version`, so a `reanchored` result continues to
// mean "safe selector fallback inside the one supplied version" and never
// cross-version recovery.
//
// EXCERPT TEXT is `plainText.slice(span.start, span.end)` - the exact
// substring of the same plain text the resolver matched against. It is never
// the highlight preview, the annotation body, a Library snippet, or a bare
// `textQuote.exact` that was not confirmed by the resolved span. (Under the
// validated-textPos path the resolved substring may legitimately differ from
// `exact` in whitespace; the resolved substring wins.)
//
// PURITY: no DOM, no storage, no network, no persistence, no clock, no
// randomness, no global side effect beyond publishing this namespace.
//
// The value returned by `resolveHighlightExcerpt` is an adapter envelope, not
// an eighth v0 contract: the v0 contract set stays exactly the seven frozen
// in T1.

(function (global) {
  'use strict';

  const H2O = (global.H2O = global.H2O || {});
  H2O.Knowledge = H2O.Knowledge || {};
  if (H2O.Knowledge.CapturedChatHighlightAdapterV0
    && H2O.Knowledge.CapturedChatHighlightAdapterV0.__installed) return;

  const VERSION = '0.1.0';
  const CONTRACT_VERSION = 0;

  // The frozen T1 first-adapter mapping.
  const ITEM_KIND = 'captured_chat';
  const ITEM_SCHEME = 'chat-registry/chat-id';
  const IDENTITY_AUTHORITY = 'chat-registry';
  const VERSION_SCHEME = 'saved-chat/generation-content-hash';
  const BLOCK_KIND = 'message';
  const BLOCK_SCHEME = 'captured-chat/message-id';
  const DERIVATION = 'anchor_resolution';

  // Incumbent annotation eligibility, mirrored from the existing highlight
  // resolution consumer: attributed highlights only.
  const ANNOTATION_KIND = 'highlight';
  const ANNOTATION_ATTRIBUTION = 'attributed';

  const RESOLVED_STATUSES = Object.freeze(['anchored', 'reanchored']);

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  // Same rule the v0 contracts apply to identity strings: verbatim or
  // rejected, never trimmed into shape.
  function isCleanString(value) {
    return typeof value === 'string' && value.length > 0 && value.trim() === value;
  }

  function contracts() {
    const api = H2O.Knowledge && H2O.Knowledge.ContractsV0;
    return (api && api.__installed === true) ? api : null;
  }

  function fail(reason) {
    return {
      ok: false,
      reason: reason,
      itemRef: null,
      versionRef: null,
      blockRef: null,
      anchor: null,
      resolverInput: null,
      result: null,
      excerpt: null,
    };
  }

  /* ── Identity extraction (owner-issued, never invented) ────────────────── */

  // A captured_chat item carries its chatId twice: `id` and
  // `identity.chatId`. Either may be used, but a disagreement between them is
  // a genuine identity conflict that this layer must not silently pick a
  // winner for.
  function chatIdFrom(item) {
    if (!isPlainObject(item)) return { ok: false, reason: 'invalid-item' };
    if (item.kind !== ITEM_KIND) return { ok: false, reason: 'item-kind-mismatch' };

    let fromIdentity = null;
    if (item.identity !== undefined) {
      if (!isPlainObject(item.identity)) return { ok: false, reason: 'invalid-item-identity' };
      if (item.identity.authority !== undefined && item.identity.authority !== IDENTITY_AUTHORITY) {
        return { ok: false, reason: 'identity-authority-mismatch' };
      }
      if (item.identity.chatId !== undefined) fromIdentity = item.identity.chatId;
    }
    const fromId = item.id === undefined ? null : item.id;

    if (fromIdentity !== null && fromId !== null && fromIdentity !== fromId) {
      return { ok: false, reason: 'item-identity-conflict' };
    }
    const chatId = fromIdentity !== null ? fromIdentity : fromId;
    if (!isCleanString(chatId)) return { ok: false, reason: 'missing-item-identity' };
    return { ok: true, chatId: chatId };
  }

  function checkAnnotation(annotation, chatId) {
    if (!isPlainObject(annotation)) return { ok: false, reason: 'invalid-annotation' };
    if (annotation.kind !== ANNOTATION_KIND) return { ok: false, reason: 'annotation-kind-mismatch' };
    if (annotation.attribution !== ANNOTATION_ATTRIBUTION) {
      return { ok: false, reason: 'annotation-not-attributed' };
    }
    const source = annotation.source;
    if (!isPlainObject(source)) return { ok: false, reason: 'missing-block-identity' };
    if (!isCleanString(source.answerId)) return { ok: false, reason: 'missing-block-identity' };
    // An annotation that names a different chat must never be folded into
    // this item's reference chain.
    if (source.chatId !== undefined && source.chatId !== null && source.chatId !== chatId) {
      return { ok: false, reason: 'annotation-item-mismatch' };
    }
    if (isPlainObject(annotation.item) && annotation.item.id !== undefined
      && annotation.item.id !== null && annotation.item.id !== chatId) {
      return { ok: false, reason: 'annotation-item-mismatch' };
    }
    if (!isPlainObject(annotation.raw) || !isPlainObject(annotation.raw.anchors)) {
      return { ok: false, reason: 'missing-anchors' };
    }
    return { ok: true, answerId: source.answerId, anchors: annotation.raw.anchors };
  }

  /* ── Reference chain construction ──────────────────────────────────────── */

  function buildItemRef(item) {
    const C = contracts();
    if (!C) return null;
    const id = chatIdFrom(item);
    if (!id.ok) return null;
    return C.makeItemRef({ itemKind: ITEM_KIND, scheme: ITEM_SCHEME, id: id.chatId });
  }

  // `contentHash` is the owner's verified generation identity, supplied by the
  // caller. Referenced as an opaque string: not parsed, not recomputed, and
  // never read off a package filename.
  function buildVersionRef(item, contentHash) {
    const C = contracts();
    if (!C) return null;
    const itemRef = buildItemRef(item);
    if (!itemRef) return null;
    return C.makeVersionRef({ item: itemRef, scheme: VERSION_SCHEME, id: contentHash });
  }

  function buildSemanticBlockRef(versionRef, annotation) {
    const C = contracts();
    if (!C || !isPlainObject(versionRef)) return null;
    const checked = checkAnnotation(annotation, versionRef.item ? versionRef.item.id : null);
    if (!checked.ok) return null;
    return C.makeSemanticBlockRef({
      version: versionRef,
      blockKind: BLOCK_KIND,
      scheme: BLOCK_SCHEME,
      id: checked.answerId,
    });
  }

  // Existing highlight selectors, carried across unchanged. Only the families
  // the incumbent actually produces are read; xpath goes to the deferred slot.
  function buildAnchor(blockRef, anchors) {
    const C = contracts();
    if (!C || !isPlainObject(anchors)) return null;
    const quote = anchors.textQuote;
    if (!isPlainObject(quote)) return null;

    const selectors = { textQuote: { exact: quote.exact } };
    if (quote.prefix !== undefined) selectors.textQuote.prefix = quote.prefix;
    if (quote.suffix !== undefined) selectors.textQuote.suffix = quote.suffix;
    if (quote.approx !== undefined) selectors.textQuote.approx = quote.approx;
    if (anchors.textPos !== undefined && anchors.textPos !== null) {
      if (!isPlainObject(anchors.textPos)) return null;
      selectors.textPos = { start: anchors.textPos.start, end: anchors.textPos.end };
    }

    const input = { target: blockRef, selectors: selectors };
    if (anchors.xpath !== undefined && anchors.xpath !== null) {
      input.deferredSelectors = { xpath: anchors.xpath };
    }
    return C.makeAnchor(input);
  }

  // Project a Knowledge Anchor back into the incumbent resolver's own input
  // shape, so the resolver runs on the contract-carried selectors rather than
  // on the raw annotation. Deferred xpath is handed over as opaque data; the
  // resolver only ever reports it as deferred.
  function toResolverAnchors(anchor) {
    if (!isPlainObject(anchor) || !isPlainObject(anchor.selectors)) return null;
    const quote = anchor.selectors.textQuote;
    if (!isPlainObject(quote)) return null;

    const out = { textQuote: { exact: quote.exact } };
    if (quote.prefix !== undefined) out.textQuote.prefix = quote.prefix;
    if (quote.suffix !== undefined) out.textQuote.suffix = quote.suffix;
    if (quote.approx !== undefined) out.textQuote.approx = quote.approx;
    if (anchor.selectors.textPos !== undefined) {
      out.textPos = { start: anchor.selectors.textPos.start, end: anchor.selectors.textPos.end };
    }
    if (isPlainObject(anchor.deferredSelectors) && anchor.deferredSelectors.xpath !== undefined) {
      out.xpath = anchor.deferredSelectors.xpath;
    }
    return out;
  }

  /* ── Resolver result mapping ───────────────────────────────────────────── */

  // Semantic fields (status, span, selectorUsed, confidence, reason) are
  // passed through verbatim so the v0 validator - not this adapter - decides
  // whether the outcome is coherent. Only the diagnostics bag, which carries
  // no semantics, is shaped defensively.
  function mapResolverResult(anchor, resolverResult) {
    const C = contracts();
    if (!C || !isPlainObject(resolverResult)) return null;
    const d = isPlainObject(resolverResult.diagnostics) ? resolverResult.diagnostics : {};
    const matchCount = (typeof d.matchCount === 'number' && Number.isInteger(d.matchCount) && d.matchCount >= 0)
      ? d.matchCount
      : 0;
    const approx = (typeof d.approx === 'number' && Number.isFinite(d.approx)) ? d.approx : null;

    return C.makeReanchorResult({
      status: resolverResult.status,
      anchor: anchor,
      span: resolverResult.span === undefined ? null : resolverResult.span,
      selectorUsed: resolverResult.selectorUsed === undefined ? null : resolverResult.selectorUsed,
      confidence: resolverResult.confidence,
      reason: typeof resolverResult.reason === 'string' ? resolverResult.reason : '',
      diagnostics: {
        tried: Array.isArray(d.tried) ? d.tried.slice() : [],
        matchCount: matchCount,
        approx: approx,
        xpathDeferred: d.xpathDeferred === true,
        notes: Array.isArray(d.notes) ? d.notes.slice() : [],
      },
    });
  }

  function isResolvedStatus(status) {
    return RESOLVED_STATUSES.indexOf(status) !== -1;
  }

  /* ── Excerpt construction (successful resolutions only) ────────────────── */

  function buildExcerpt(reanchorResult, plainText) {
    const C = contracts();
    if (!C || !isPlainObject(reanchorResult)) return null;
    if (!isResolvedStatus(reanchorResult.status)) return null;   // orphaned -> no Excerpt
    if (typeof plainText !== 'string') return null;
    const span = reanchorResult.span;
    if (!isPlainObject(span)) return null;
    if (span.end > plainText.length) return null;

    // The exact resolved substring of the same plain text the resolver
    // matched against - never the quote, preview, or body text.
    const text = plainText.slice(span.start, span.end);
    const provenance = C.makeProvenance({ derivation: DERIVATION, source: reanchorResult.anchor });
    if (!provenance) return null;
    // The cross-check makes the binding explicit: this Excerpt's provenance
    // must point at the very Anchor that produced the result.
    return C.makeExcerpt({ text: text, provenance: provenance }, { anchor: reanchorResult.anchor });
  }

  /* ── Whole chain ───────────────────────────────────────────────────────── */

  function resolveHighlightExcerpt(input, options) {
    if (!contracts()) return fail('contracts-unavailable');
    if (!isPlainObject(input)) return fail('invalid-input');

    const opts = isPlainObject(options) ? options : {};
    const resolver = opts.resolver;
    if (!resolver || typeof resolver.resolveInText !== 'function') return fail('resolver-unavailable');
    if (typeof input.plainText !== 'string') return fail('invalid-plain-text');

    const id = chatIdFrom(input.item);
    if (!id.ok) return fail(id.reason);
    if (!isCleanString(input.contentHash)) return fail('missing-version-identity');
    const checked = checkAnnotation(input.annotation, id.chatId);
    if (!checked.ok) return fail(checked.reason);

    const versionRef = buildVersionRef(input.item, input.contentHash);
    if (!versionRef) return fail('missing-version-identity');
    const blockRef = buildSemanticBlockRef(versionRef, input.annotation);
    if (!blockRef) return fail('missing-block-identity');
    const anchor = buildAnchor(blockRef, checked.anchors);
    if (!anchor) return fail('invalid-anchor');

    const resolverInput = toResolverAnchors(anchor);
    if (!resolverInput) return fail('invalid-anchor');

    let resolverResult;
    try {
      resolverResult = resolver.resolveInText(resolverInput, input.plainText, opts.resolverOptions || {});
    } catch (_e) {
      return fail('resolver-error');
    }
    if (!isPlainObject(resolverResult)) return fail('resolver-result-invalid');

    const result = mapResolverResult(anchor, resolverResult);
    if (!result) return fail('unmappable-result');

    // Orphaned is a legitimate outcome of a chain that ran: ok stays true and
    // the Excerpt is simply absent.
    const excerpt = isResolvedStatus(result.status) ? buildExcerpt(result, input.plainText) : null;
    if (isResolvedStatus(result.status) && !excerpt) return fail('excerpt-unavailable');

    return {
      ok: true,
      reason: '',
      itemRef: versionRef.item,
      versionRef: versionRef,
      blockRef: blockRef,
      anchor: anchor,
      resolverInput: resolverInput,
      result: result,
      excerpt: excerpt,
    };
  }

  function diagnose() {
    const C = contracts();
    return {
      ok: true,
      module: 'knowledge/captured-chat-highlight-adapter-v0',
      lane: 'L-COCKPIT-KNOWLEDGE-MODEL',
      version: VERSION,
      contractVersion: CONTRACT_VERSION,
      readonly: true,
      contractsAvailable: !!C,
      mapping: {
        itemKind: ITEM_KIND,
        itemScheme: ITEM_SCHEME,
        identityAuthority: IDENTITY_AUTHORITY,
        versionScheme: VERSION_SCHEME,
        blockKind: BLOCK_KIND,
        blockScheme: BLOCK_SCHEME,
        derivation: DERIVATION,
      },
      resolver: {
        injected: true,
        reimplemented: false,
        resolvesDeferred: false,
      },
      excerptStatuses: RESOLVED_STATUSES.slice(),
      mintsOwnerIdentity: false,
      recomputesVersionIdentity: false,
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
    };
  }

  const AdapterV0 = Object.freeze({
    __installed: true,
    version: VERSION,
    contractVersion: CONTRACT_VERSION,
    readonly: true,
    ITEM_KIND,
    ITEM_SCHEME,
    IDENTITY_AUTHORITY,
    VERSION_SCHEME,
    BLOCK_KIND,
    BLOCK_SCHEME,
    DERIVATION,
    RESOLVED_STATUSES,
    buildItemRef,
    buildVersionRef,
    buildSemanticBlockRef,
    buildAnchor,
    toResolverAnchors,
    mapResolverResult,
    buildExcerpt,
    resolveHighlightExcerpt,
    diagnose,
  });

  H2O.Knowledge.CapturedChatHighlightAdapterV0 = AdapterV0;
})(typeof globalThis !== 'undefined' ? globalThis : this);
