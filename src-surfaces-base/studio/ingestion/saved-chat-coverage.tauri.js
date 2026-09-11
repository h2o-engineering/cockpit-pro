/* Saved-Chat per-chat archive coverage engine (M05 Phase 2.2).
 *
 * Composes three EXISTING authorities and adds none of its own:
 *
 *   1. trusted archive enumeration + package validity
 *                                      (M10 readSavedChatArchiveIntegrityV1)
 *   2. canonical occupant partition    (M10 archiveHealthMapping.partitionOccupants)
 *   3. current Desktop projection      (Phase 2.1 probe)
 *
 * M10 P3.5a: archive package validity moved from the legacy JavaScript verifier
 * to the trusted Rust authority. Coverage reads the trusted envelope DIRECTLY —
 * not through the Archive Health facade — because it needs package truth, not
 * Health aggregation, DB drift or renderer hygiene. A trusted-path failure fails
 * closed; there is no fallback to the legacy verifier.
 *
 * It is stateless: no persistent index, no mutable current pointer, no second
 * package validator, no second contentHash implementation. Every verdict is
 * recomputed from those three authorities on each call.
 *
 * THE ONE FRESHNESS RULE (§E)
 *
 *   FRESH  ==  VALID package
 *              AND package RECOMPUTED contentHash == current projection contentHash
 *
 * Nothing else can establish it. Not a filesystem mtime, not a directory
 * creation time, not manifest.generatedAt, not a queue timestamp, and not the
 * package's name. In particular the comparison uses the hash the governed
 * validator RECOMPUTES from stored bytes, never `manifest.contentHash` as
 * written — a package that lies about its own identity must not be able to
 * claim freshness by editing one string.
 *
 * NEGATIVE CONCLUSIONS NEED AUTHORITY (§E)
 *
 * "No fresh package exists" is a claim about the WHOLE archive, so it requires
 * a complete enumeration and an authoritative projection. A truncated scan or
 * an indeterminate projection yields null — not false — because a consumer
 * reading `covered:false` would act on it. A positive fact from an
 * already-verified package is still safe under a partial scan; an absence is
 * not.
 *
 * Contracts: docs/systems/archive/saved-chat-generations.md §D §E §F §G
 */
(function (global) {
  'use strict';

  function detectTauri() {
    try {
      if (typeof global.__TAURI_INTERNALS__ !== 'undefined') return true;
      if (typeof global.__TAURI__ !== 'undefined') return true;
    } catch (_) { /* ignore */ }
    return false;
  }
  if (!detectTauri()) return;

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.ingestion = H2O.Studio.ingestion || {};

  var MODULE_VERSION = '1.0.0-m05-p22';

  function safeObject(v) { return v && typeof v === 'object' ? v : {}; }
  function asArray(v) { return Array.isArray(v) ? v : []; }
  function cleanString(v) { return typeof v === 'string' ? v.trim() : ''; }

  /* The live writer's contentHash construction FAMILY. §F distinguishes
   * format-stale from content-stale by whether the package's construction
   * differs from the live writer's — for example, v1/v2 packages under the v3
   * production policy. v1 and v2 are two arms of the SAME rollback family (the
   * writer picks between them per content, by whether inline assets exist), so
   * a v1-vs-v2 difference is ordinary content drift, not a format transition. */
  function constructionFamily(schemaVersion) {
    if (schemaVersion === 1 || schemaVersion === 2) return 'v1v2';
    if (schemaVersion === 3) return 'v3';
    return '';
  }

  /* Deterministic ordering for testability: newest verified savedAt first,
   * then contentHash hex ascending. savedAt lives inside the hashed snapshot,
   * so it is content — never filesystem metadata. */
  function compareHistorical(a, b) {
    var av = cleanString(a.savedAt);
    var bv = cleanString(b.savedAt);
    if (av !== bv) return av < bv ? 1 : -1;
    var ah = cleanString(a.contentHash);
    var bh = cleanString(b.contentHash);
    if (ah === bh) return 0;
    return ah < bh ? -1 : 1;
  }

  /* M10 P3.5a: contentHash REPRESENTATION normalization only.
   *
   * The trusted archive envelope carries a bare lowercase hex digest; the
   * current-projection probe and the legacy validator both carry the
   * `sha256-<hex>` form. Comparing the two representations directly would make
   * every package read stale, so both sides are normalized to bare hex before
   * comparison. The freshness RULE is unchanged — trusted recomputed
   * contentHash == current projection contentHash — and nothing is recomputed
   * here. */
  function bareHash(value) {
    var text = cleanString(value).toLowerCase();
    return text.indexOf('sha256-') === 0 ? text.slice(7) : text;
  }

  /* The canonical version triple, as the publisher's own gate established it.
   * V1 carries no payloadVersion at all; V2 and V3 carry theirs. Derived from
   * the trusted construction family rather than re-read from bytes. */
  var SCHEMA_VERSION_BY_FAMILY = { v1: 1, v2: 2, v3: 3 };
  var PAYLOAD_VERSION_BY_FAMILY = { v1: null, v2: 2, v3: 3 };

  /* M10 P3.5a: built from a TRUSTED occupant. Archive package validity is
   * decided by Rust; this maps already-established facts and derives nothing
   * about integrity. */
  function entryFromOccupant(occupant) {
    var o = safeObject(occupant);
    var klass = cleanString(o.class);
    var family = cleanString(o.constructionFamily);
    var classification = klass === 'verified-generation' ? 'generation'
      : (klass === 'legacy-package' ? 'legacy' : 'unclassified');
    return {
      packagePath: cleanString(o.path),
      packageDirName: cleanString(o.name),
      classification: classification,
      chatId: cleanString(o.chatId),
      snapshotId: cleanString(o.snapshotId),
      schemaVersion: Object.prototype.hasOwnProperty.call(SCHEMA_VERSION_BY_FAMILY, family)
        ? SCHEMA_VERSION_BY_FAMILY[family] : null,
      /* Still read by the archive materializer's recovery record, so it is
       * retained and derived from the trusted family rather than dropped. */
      payloadVersion: Object.prototype.hasOwnProperty.call(PAYLOAD_VERSION_BY_FAMILY, family)
        ? PAYLOAD_VERSION_BY_FAMILY[family] : null,
      /* RECOMPUTED by the trusted verifier from the stored bytes. */
      contentHash: bareHash(o.contentHash),
      savedAt: cleanString(o.savedAt),
      status: classification === 'unclassified' ? 'blocked' : 'ok',
      blockers: asArray(o.blockers).map(function (b) { return cleanString(b && b.code); }).filter(Boolean),
    };
  }

  async function describeSavedChatCoverageV1(options, policyToken) {
    var opts = safeObject(options);
    var chatId = cleanString(opts.chatId);
    var ing = H2O.Studio.ingestion || {};

    var result = {
      chatId: chatId,
      projection: null,
      legacy: [],
      generations: [],
      unusable: [],
      fresh: [],
      stale: [],
      preserved: null,
      covered: null,
      selected: null,
      bestHistorical: null,
      bestHistoricalTies: [],
      complete: false,
      reason: '',
    };

    if (!chatId) { result.reason = 'chat-id-required'; return result; }
    /* M10 P3.5a: archive package validity now comes from the trusted Rust
     * authority. Coverage deliberately does NOT go through the Health facade —
     * it needs package truth, not Health aggregation, DB drift or hygiene. */
    var mapping = (H2O.Studio && H2O.Studio.archiveHealthMapping) || null;
    if (typeof ing.readSavedChatArchiveIntegrityV1 !== 'function'
      || !mapping || typeof mapping.partitionOccupants !== 'function') {
      result.reason = 'archive-integrity-unavailable';
      return result;
    }

    /* ── 1. Current projection (Phase 2.1) ──────────────────────────────── */
    var projection = safeObject(opts.projection);
    if (!cleanString(projection.status)) {
      if (typeof ing.probeCurrentSavedChatProjectionV1 !== 'function') {
        projection = { status: 'indeterminate', reason: 'projection-probe-unavailable', contentHash: '' };
      } else {
        projection = safeObject(await ing.probeCurrentSavedChatProjectionV1({ chatId: chatId }, policyToken));
      }
    }
    result.projection = {
      status: cleanString(projection.status) || 'indeterminate',
      reason: cleanString(projection.reason),
      /* Only an authoritative projection may expose a hash. */
      contentHash: projection.status === 'ok' ? cleanString(projection.contentHash) : '',
      snapshotId: projection.status === 'ok' ? cleanString(projection.snapshotId) : '',
      schemaVersion: projection.status === 'ok' && typeof projection.schemaVersion === 'number' ? projection.schemaVersion : null,
      liveGenerationFamily: projection.status === 'ok' ? cleanString(projection.liveGenerationFamily) : '',
    };
    var projectionOk = result.projection.status === 'ok' && !!result.projection.contentHash;

    /* ── 2. Trusted archive facts (one read, complete by construction) ──── */
    var envelope;
    try {
      envelope = safeObject(await ing.readSavedChatArchiveIntegrityV1());
    } catch (err) {
      /* Fail closed. There is deliberately no fallback to the legacy archive
       * verifier: a trusted-path failure must never be answered by a weaker
       * second opinion. */
      result.reason = 'archive-integrity-unavailable';
      return result;
    }
    /* Absence of an explicit `complete` flag is treated as INCOMPLETE: a
     * missing signal is not evidence of completeness. */
    var discoveryComplete = envelope.complete === true;
    result.complete = discoveryComplete;

    /* ── 3. Canonical partition (shared, never re-implemented) ──────────── */
    var partition;
    try {
      partition = mapping.partitionOccupants(envelope.occupants);
    } catch (err) {
      result.complete = false;
      result.reason = 'archive-integrity-unavailable';
      return result;
    }
    /* Reserved infrastructure and non-package strays are excluded by the
     * partition itself; only package-class occupants reach Coverage. */
    var packageOccupants = asArray(partition && partition.packageOccupants);
    for (var i = 0; i < packageOccupants.length; i += 1) {
      var entry = entryFromOccupant(packageOccupants[i]);
      /* Verified identity decides ownership for any package that can CONFER
       * coverage — never the basename, so a lying filename cannot claim one.
       *
       * An occupant trusted integrity REFUSED has no proven identity at all, so
       * the archive's own naming convention is the only signal that it belongs
       * to this chat. Using it here is safe precisely because such an entry can
       * only ever land in `unusable`: it is gated out of legacy/generations
       * below and can never establish preserved, covered or fresh. */
      var owns = entry.chatId
        ? entry.chatId === chatId
        : entry.packageDirName.indexOf(chatId + '.') === 0;
      if (!owns) continue;

      var valid = entry.status === 'ok' && !!entry.contentHash
        && (entry.classification === 'legacy' || entry.classification === 'generation');
      if (!valid) {
        result.unusable.push(entry);
        continue;
      }
      if (entry.classification === 'legacy') result.legacy.push(entry);
      else result.generations.push(entry);
    }

    var validEntries = result.legacy.concat(result.generations);
    result.legacy.sort(compareHistorical);
    result.generations.sort(compareHistorical);
    result.unusable.sort(compareHistorical);

    /* PRESERVED: ≥1 VALID package. A positive is safe even under a partial
     * scan — we already hold a verified package. A negative is not. */
    if (validEntries.length > 0) result.preserved = true;
    else result.preserved = discoveryComplete ? false : null;

    /* ── 4. Freshness (§E) ──────────────────────────────────────────────── */
    if (!projectionOk) {
      /* Neither fresh nor stale may be asserted: with no authoritative current
       * identity there is nothing to compare against. Packages stay PRESERVED.
       * (§E: "freshness is not asserted either way".) */
      result.covered = null;
      result.reason = result.projection.status === 'undefined-no-snapshot'
        ? 'no-current-snapshot'
        : 'projection-' + (result.projection.status || 'indeterminate');
    } else {
      var currentHash = bareHash(result.projection.contentHash);
      var liveFamily = constructionFamily(result.projection.schemaVersion);
      for (var j = 0; j < validEntries.length; j += 1) {
        var e = validEntries[j];
        if (e.contentHash === currentHash) {
          result.fresh.push(e);
        } else {
          /* §F, mechanically: same construction family ⇒ the content itself
           * differs; a different family ⇒ the identity was built a different
           * way, which is a format transition rather than content drift. */
          var family = constructionFamily(e.schemaVersion);
          result.stale.push(Object.assign({}, e, {
            staleKind: (liveFamily && family && family !== liveFamily) ? 'format-stale' : 'content-stale',
          }));
        }
      }
      result.fresh.sort(compareHistorical);
      result.stale.sort(compareHistorical);

      if (result.fresh.length > 0) {
        result.covered = true;
        /* §E deterministic selection: a FRESH generation is preferred, else a
         * FRESH legacy. */
        var freshGeneration = null;
        for (var k = 0; k < result.fresh.length; k += 1) {
          if (result.fresh[k].classification === 'generation') { freshGeneration = result.fresh[k]; break; }
        }
        result.selected = freshGeneration || result.fresh[0];
      } else {
        /* Only a COMPLETE scan may conclude that no fresh package exists. */
        result.covered = discoveryComplete ? false : null;
        if (!discoveryComplete) result.reason = 'discovery-incomplete';
      }
    }

    /* ── 5. BEST-HISTORICAL (§G) — presentation only ────────────────────── */
    if (validEntries.length > 0 && result.fresh.length === 0) {
      var ordered = validEntries.slice().sort(compareHistorical);
      var top = ordered[0];
      /* Ties are PRESERVED as ties rather than resolved by inventing
       * superiority; empty savedAt values all tie with each other. */
      var ties = ordered.filter(function (e) { return cleanString(e.savedAt) === cleanString(top.savedAt); });
      result.bestHistorical = top;
      result.bestHistoricalTies = ties.length > 1 ? ties : [];
    }

    return result;
  }

  function diagnoseSavedChatCoverageV1() {
    return {
      installed: true,
      version: MODULE_VERSION,
      stateless: true,
      persistentIndex: false,
      mutableCurrentPointer: false,
      freshnessRule: 'recomputed-package-contentHash == current-projection-contentHash',
      usesTimestampsForFreshness: false,
      staleKinds: ['content-stale', 'format-stale'],
    };
  }

  H2O.Studio.ingestion.describeSavedChatCoverageV1 = describeSavedChatCoverageV1;
  H2O.Studio.ingestion.diagnoseSavedChatCoverageV1 = diagnoseSavedChatCoverageV1;
})(typeof window !== 'undefined' ? window : globalThis);
