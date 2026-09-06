/* H2O Studio — Saved Chat Recovery Center, timeline surface (Mission T02)
 *
 * New UI only. A read-only operator surface mounted as a sibling beneath the
 * Archive Health card, following the same pattern as the inspector, importer,
 * exporter and reclamation cards.
 *
 * WHAT IT IS: the first surface that answers "what versions of THIS chat does
 * the archive still hold, and which one is current?" — a per-chat version
 * timeline, plus a read-only detail view of one selected version.
 *
 * IT DECIDES NOTHING. Every fact on screen was established by an authority that
 * already owns it, and this module composes exactly four of them:
 *
 *   1. readSavedChatArchiveIntegrityV1()      trusted archive enumeration and
 *                                             package validity (once per open
 *                                             or refresh — never per row);
 *   2. archiveHealthMapping.partitionOccupants()
 *                                             the canonical occupant partition,
 *                                             never re-implemented here;
 *   3. describeSavedChatCoverageV1({chatId})  the per-chat version populations
 *                                             and the frozen freshness rule,
 *                                             for the SELECTED chat only;
 *   4. archiveInspector.inspectPackage()      the read-only detail view, and the
 *                                             fresh reverification gate, for the
 *                                             SELECTED version only.
 *
 * The read-only PREVIEW adds two more, and still no authority of its own:
 *
 *   5. savedChatPackageCodec.readBoundedPackageMemberBytes()
 *                                             the governed bounded member read —
 *                                             package-root scope, symlink and
 *                                             non-file refusal, physical cap
 *                                             enforced before a byte is read;
 *   6. savedChatPackageCodec.readVerifiedPackageMember()
 *                                             the governed v3 path: descriptor
 *                                             verification, bounded encoding-aware
 *                                             decode, logical length/SHA check.
 *
 * The verified snapshot is turned into rows by the existing pure mapper
 * `archiveImporter.buildTurnsFromPackageSnapshot`, which already owns the
 * v3-typed-parts vs v1/v2 scalar-text distinction. This module therefore
 * contains no gzip, no package or ZIP parsing, no descriptor or hash
 * verification, and no filesystem code at all.
 *
 * PREVIEW IS GATED ON FRESH TRUST, NOT ON THE LIST. `packagePath` is an address,
 * never proof. Every preview re-inspects the package through the trusted path
 * first, requires a current `verified` verdict, and compares the reverified
 * identity against the selected row's identity where one is available. A changed
 * or vanished package clears the preview and says so; it never silently follows
 * a different package and never shows stale content.
 *
 * Labels come from the shared presentation adapter, so this surface does not
 * invent a second vocabulary for "current" and "historical".
 *
 * It therefore performs NO semantic verification, NO contentHash or
 * representationHash derivation, NO validity decision, NO classification, NO
 * package-name grammar, NO filesystem discovery, NO ordering authority, NO
 * recovery-eligibility judgement and NO completeness authority.
 *
 * ORDERING (the one that matters). Version order is COVERAGE's order. This
 * module contains no comparator and calls no sort: it renders each coverage
 * population in the order coverage already produced, and never interleaves two
 * of them into a single invented sequence. A filename, an mtime, a
 * manifest.generatedAt, a queue timestamp and an insertion index are all
 * non-authorities here, and no timestamp is synthesized. `savedAt` is DISPLAYED
 * because it lives inside the hashed snapshot — it is content, not metadata —
 * but it never decides position.
 *
 * INCOMPLETE EVIDENCE IS SHOWN, NEVER SWALLOWED. When the trusted enumeration
 * reports `complete === false`, or coverage could not assert freshness, the card
 * says so in the Archive Health wording, and absence is never presented as a
 * conclusion.
 *
 * SELECTABILITY. Only rows addressing a package trusted verification ACCEPTED
 * can be selected. Unusable occupants stay VISIBLE — hiding a damaged package is
 * how an operator concludes their chat was never saved — but they cannot be
 * selected, and this module publishes no universal "recoverable" bit: whether
 * anything may be recovered from a version is a later Task's question, and no
 * answer to it is claimed, stored or implied here.
 *
 * ARCHIVED CONTENT IS DATA. It gains no execution authority by having come from
 * a trusted package. Preview text is written with `textContent` only — this
 * module never assigns `innerHTML`, never hydrates archived content into live
 * controls, and never re-renders archived markup. Where a v3 message carries
 * only an HTML body, the readable text is extracted with the EXISTING Studio
 * sanitizer; no second sanitizer family is introduced, and if that sanitizer is
 * absent the HTML is simply not rendered.
 *
 * TWO MUTATIONS CAN BE REQUESTED HERE, and this surface owns neither.
 *
 *   RECOVER AS NEW copies a saved version into a brand-new chat through the
 *   existing `importVerifiedPackage`.
 *
 *   RESTORE ORIGINAL IDENTITY re-creates the chat under its ORIGINAL saved
 *   chatId and snapshotId through the existing `restoreVerifiedPackage`. It is
 *   absent-only: the restore module inserts what is missing and refuses
 *   everything else.
 *
 * They are deliberately SEPARATE operations, not two modes of one generic
 * recovery call. Each takes two deliberate operator actions: one to prepare —
 * which runs that module's own non-mutating dry-run and shows its verdict
 * verbatim — and one to confirm, which issues exactly one governed call.
 * Nothing is prepared or executed by selecting, previewing, refreshing or
 * mounting.
 *
 * Each module re-runs its own dry-run and re-establishes its own trusted binding
 * at the write gate. The importer allocates the fresh recovered identity; the
 * restore module re-checks conflicts and tombstones inside its transaction,
 * writes INSERT-only and rolls back. A dry-run verdict held here is
 * PRESENTATION state that gates a button; it is never sent back, and there is no
 * argument by which this surface could tell either module that something is
 * permitted. UI MAY REQUEST; THE GOVERNED MODULE DECIDES.
 *
 * An approval is pinned to the version it was prepared for and dies on any
 * version change, chat change, refresh or remount. Starting either mutation
 * discards an approval prepared for the other, because the store it was judged
 * against is about to change.
 *
 * BOUNDARY. No relink, no restore-current, no overwrite-existing, no tombstone
 * override, no un-delete, no merge-into and no forced or overriding variant of
 * anything — and no control for any of them, not even a disabled one. A conflict
 * or tombstone refusal is final here: there is no retry, no fallback and no
 * destructive alternative. This surface holds no direct write authority of any
 * kind: no SQL, no store write, no filesystem write, no archive or CAS mutation,
 * no native command.
 *
 * Public API (H2O.Studio.recoveryCenterUi):
 *   mountRecoveryCenterCard(healthContainer, options)
 *   renderRecoveryCenterCard(container, options)
 *   buildChatIndex(packageOccupants) -> pure
 *   buildTimelineSections(coverage, entryPresentation) -> pure
 *   buildPreviewFromTurns(turns) -> pure
 *   selectionIdentityMatches(row, inspection) -> pure
 *   TEXT
 *
 * The card instance additionally exposes, for the two governed requests:
 *   prepareRecoverAsNew() / recoverAsNew()
 *   prepareRestoreOriginalIdentity() / restoreOriginalIdentity()
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  if (H2O.Studio.recoveryCenterUi && H2O.Studio.recoveryCenterUi.__installed) return;

  var MODULE_VERSION = '0.1.0-recovery-center-t02';

  /* The inspector's scope guard, mirrored so an unscoped or absolute path can
   * never leave this surface. It is a safety gate, never an authority: the path
   * itself is always the trusted occupant's own archive-relative path. */
  var PACKAGE_ROOT = 'archive/packages';

  /* Chats are grouped by the TRUSTED chatId the verifier proved. An occupant
   * with no proven chatId is NOT attributed to a chat by parsing its basename —
   * that is name-grammar authority this surface does not hold. It is shown in
   * its own clearly-labelled group instead, so it is never silently dropped. */
  var UNATTRIBUTED = ' unattributed';

  /* Bounded preview. Large-chat segmentation is a deferred architecture, so a
   * long conversation is shown honestly truncated rather than either rendered
   * whole or silently cut. Nothing here is cached, indexed or persisted. */
  var MAX_PREVIEW_MESSAGES = 200;
  var MAX_PREVIEW_CHARS = 2000;
  /* The construction families the trusted verifier reports. A v3 package must
   * take the governed verified-member path; there is deliberately no fallback
   * that would let a v3 package be read as though it were v1/v2. */
  var FAMILY_V3 = 'v3';

  /* The importer's own default and only accepted mode. Passed explicitly so the
   * request is legible at the call site rather than relying on a default. */
  var IMPORT_MODE = 'import-as-new';
  /* The importer's own verdict that opens the confirmation. Every other verdict
   * — including its other `ok` value, `already-imported` — is shown as-is and
   * leaves the mutation action unavailable. */
  var IMPORT_READY = 'import-ready';
  /* The restore module's own mode and its only accepted value, passed explicitly
   * so the request is legible at the call site. T05 is a DIFFERENT operation
   * from T04, not a mode of one generic recovery call. */
  var RESTORE_MODE = 'restore-original-ids';
  /* The restore module's own verdict that opens the confirmation. Every other
   * verdict — including its other `ok` value, `already-present` — is shown as
   * the restore module stated it and leaves the mutation action unavailable. */
  var RESTORE_READY = 'restore-ready';
  /* The restore module's own no-write outcome. Reported honestly as "nothing was
   * written" rather than as a restore that happened. */
  var RESTORE_ALREADY_PRESENT = 'already-present';
  /* The restore module's own success status. `ok` is TRUE for already-present
   * too, so success is read from the status, never from `ok`. */
  var RESTORE_RESTORED = 'restored';

  /* A preview that actually loaded. Recovery cannot be prepared for a version the
   * operator was never able to read. */
  var PREVIEWED_PHASES = ['ready', 'empty'];

  var TEXT = {
    title: 'Saved Chat Recovery Center',
    unavailable: 'The Recovery Center is available in Desktop Studio only.',
    loading: 'Reading the saved chat archive…',
    loadingChat: 'Reading saved versions for this chat…',
    loadingVersion: 'Reading this version…',
    error: 'Could not read the saved chat archive.',
    empty: 'No saved chat packages found yet.',
    emptyHint: 'Save a chat to a folder to create a package.',
    refreshButton: 'Refresh',
    chatLabel: 'Chat',
    chatPlaceholder: 'Select a chat…',
    noVersions: 'No saved versions were found for this chat.',
    unattributedLabel: 'Unattributed packages',
    /* Reused verbatim from the Archive Health surface, so an incomplete scan
     * reads identically wherever an operator meets it. */
    partialPill: 'Partial scan',
    partialHeadline: 'Archive discovery was incomplete.',
    partialNote: 'Archive discovery was incomplete; absence cannot be concluded.',
    freshnessNotAsserted: 'Current state could not be determined, so these versions are not marked current or historical.',
    sectionCurrent: 'Current',
    sectionCurrentNote: 'Matches the chat as it stands now.',
    sectionHistorical: 'Earlier versions',
    sectionHistoricalNote: 'Preserved, and not the current content.',
    sectionGenerations: 'Preserved generations',
    sectionLegacy: 'Preserved legacy packages',
    sectionUnusable: 'Damaged or unreadable',
    sectionUnusableNote: 'Trusted verification refused these. They are shown so they are not mistaken for absence, and cannot be selected.',
    detailHeading: 'Version detail',
    detailIdle: 'Select a version to see its details.',
    detailUnavailable: 'This version could not be read.',
    blockersHeading: 'Reported problems',
    /* This is a read-only surface. The boundary is stated on screen so the
     * absence of any action is understood as deliberate. */
    readOnlyNote: 'Read-only. Nothing on this card changes the archive.',
    previewHeading: 'Version preview',
    previewIdle: 'Select a version to preview its saved conversation.',
    previewLoading: 'Verifying and reading this version…',
    previewRefused: 'Trusted verification does not currently accept this version, so its content is not shown.',
    previewStale: 'This version changed since it was listed. Refresh to see the current archive.',
    previewUnsupported: 'Previewing saved versions is available in Desktop Studio only.',
    previewUnbindable: 'This version cannot be previewed: trusted verification did not supply the member facts needed to bind its content.',
    previewError: 'This version could not be read.',
    previewEmpty: 'This saved version contains no messages.',
    previewTruncatedNote: 'Showing the first ',
    previewTruncatedNoteTail: ' messages of ',
    previewMessageTruncated: '… (message shortened for preview)',
    previewAssets: 'attachments: ',
    recoverHeading: 'Recover as new chat',
    recoverIntro: 'Recovering copies this saved version into a brand-new chat. Nothing existing is changed or overwritten.',
    recoverPrepareButton: 'Review recovery…',
    recoverConfirmButton: 'Recover as new chat',
    recoverPreflighting: 'Checking whether this version can be recovered…',
    recoverExecuting: 'Recovering…',
    recoverReadyToConfirm: 'This version can be recovered as a new chat. Confirm to proceed.',
    recoverRefused: 'This version cannot be recovered right now.',
    recoverError: 'The recovery check could not be completed.',
    recoverStale: 'The selection changed. Review recovery again.',
    recoverSuccess: 'Recovered as a new chat.',
    recoverDecision: 'Result: ',
    recoverReason: 'Reason: ',
    recoverNewChat: 'New chat: ',
    restoreHeading: 'Restore original identity',
    restoreIntro: 'Restoring re-creates this chat under its ORIGINAL saved identity. It only adds what is absent: nothing existing is changed, overwritten, relinked or un-deleted.',
    restorePrepareButton: 'Review restore…',
    restoreConfirmButton: 'Restore original identity',
    restorePreflighting: 'Checking whether this version can be restored…',
    restoreExecuting: 'Restoring…',
    restoreReadyToConfirm: 'This version can be restored under its original identity. Confirm to proceed.',
    restoreNoWrite: 'Already present. Nothing was written.',
    restoreRefused: 'This version cannot be restored right now.',
    restoreError: 'The restore check could not be completed.',
    restoreStale: 'The selection changed. Review restore again.',
    restoreSuccess: 'Restored under the original identity.',
    restoreDecision: 'Result: ',
    restoreReason: 'Reason: ',
    restoreChat: 'Chat: ',
    restoreSnapshot: 'Version: ',
    restoreTurns: 'Messages restored: ',
  };

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }
  function safeObject(value) {
    return isObject(value) ? value : {};
  }
  function asArray(value) { return Array.isArray(value) ? value : []; }
  function cleanString(value) { return typeof value === 'string' ? value.trim() : ''; }

  function el(tag, text, style) {
    var node = global.document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (style) node.setAttribute('style', style);
    return node;
  }

  /* The governed codec hands back bytes; turning already-verified bytes into
   * text and then JSON is the only decoding this module does. There is no
   * package parsing, no gzip and no encoding negotiation here — the codec
   * performed all of that before returning. */
  function textFromBytes(value) {
    if (typeof value === 'string') return value;
    var bytes = value;
    if (bytes && !(bytes instanceof Uint8Array)) {
      try { bytes = new Uint8Array(bytes); } catch (_) { return ''; }
    }
    if (!bytes) return '';
    try { return new TextDecoder('utf-8').decode(bytes); } catch (_) { return ''; }
  }

  function jsonFromBytes(value) {
    try {
      var parsed = JSON.parse(textFromBytes(value));
      return isObject(parsed) ? parsed : null;
    } catch (_) { return null; }
  }

  function packageDirNameForPath(packagePath) {
    var p = cleanString(packagePath).replace(/[/\\]+$/g, '');
    var idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return idx >= 0 ? p.slice(idx + 1) : p;
  }

  /* CONTAINMENT, not grammar. A selector must be an archive-relative path inside
   * the known package root, with no traversal and no absolute or Windows form.
   *
   * It deliberately does NOT test the package extension. Which basenames are
   * packages is name-grammar authority owned trusted-side, and the sanctioned
   * readers of that vocabulary are a pinned set this surface is not part of. The
   * path here always came from a trusted occupant the verifier already
   * classified, and the inspector re-applies its own full scope check before
   * reading anything, so containment is the whole job at this layer. */
  function isScopedPackagePath(packagePath) {
    var p = cleanString(packagePath);
    var prefix = PACKAGE_ROOT + '/';
    if (!p || p.indexOf(prefix) !== 0) return false;
    if (p.indexOf('..') >= 0 || p.indexOf('\\') >= 0) return false;
    /* Exactly ONE segment below the package root: a package directory, never
     * the root itself and never anything nested deeper inside a package. */
    var leaf = p.slice(prefix.length);
    return !!leaf && leaf.indexOf('/') < 0;
  }

  /* ── Chat index ───────────────────────────────────────────────────────────
   *
   * Built from the ONE trusted enumeration, after the canonical partition has
   * already removed reserved infrastructure and non-package strays.
   *
   * The listing order is the trusted producer's own enumeration order, carried
   * through unchanged. This module does not sort it and attaches no meaning to
   * it — it is not recency, not importance and not size. */
  function buildChatIndex(packageOccupants) {
    var order = [];
    var byId = {};
    asArray(packageOccupants).forEach(function (occupant) {
      var o = safeObject(occupant);
      var path = cleanString(o.path);
      if (!path) return;
      var proven = cleanString(o.chatId);
      var key = proven || UNATTRIBUTED;
      if (!Object.prototype.hasOwnProperty.call(byId, key)) {
        byId[key] = {
          chatId: proven,
          attributed: !!proven,
          label: proven || TEXT.unattributedLabel,
          packageCount: 0,
        };
        order.push(key);
      }
      byId[key].packageCount += 1;
    });
    return order.map(function (key) { return byId[key]; });
  }

  /* ── Timeline rows ────────────────────────────────────────────────────────
   *
   * One row per coverage entry, labelled by the shared presentation adapter.
   * `selectable` is a UI affordance derived from the trusted classification: it
   * says the row addresses a package trusted verification accepted, and says
   * nothing whatever about whether a recovery from it would be permitted. */
  function rowFor(entry, coverage, entryPresentation, allowSelection) {
    var e = safeObject(entry);
    var p = safeObject(entryPresentation(e, coverage));
    var kind = cleanString(p.kind);
    var packagePath = cleanString(p.packagePath);
    var trustedValid = (kind === 'generation' || kind === 'legacy');
    return {
      packagePath: packagePath,
      packageDirName: cleanString(p.packageDirName) || packageDirNameForPath(packagePath),
      kind: kind,
      kindLabel: cleanString(p.kindLabel),
      freshness: cleanString(p.freshness),
      freshnessLabel: cleanString(p.freshnessLabel),
      isCurrent: p.isCurrent === true,
      isHistoricalOnly: p.isHistoricalOnly === true,
      /* Recomputed by the trusted verifier from the stored bytes. */
      contentHash: cleanString(p.contentHash),
      schemaVersion: typeof p.schemaVersion === 'number' ? p.schemaVersion : null,
      /* Content, not filesystem metadata — displayed, never positional. */
      savedAt: cleanString(e.savedAt),
      blockers: asArray(p.blockers).map(cleanString).filter(Boolean),
      selectable: allowSelection === true && trustedValid && isScopedPackagePath(packagePath),
    };
  }

  /* Pure: coverage populations -> ordered, labelled sections.
   *
   * Each section renders ONE coverage array in coverage's own order. Two
   * populations are never merged into a single invented sequence, which is
   * precisely how an ordering authority would creep back in. */
  function buildTimelineSections(coverage, entryPresentation) {
    var cov = safeObject(coverage);
    var present = typeof entryPresentation === 'function'
      ? entryPresentation
      : safeObject(safeObject(safeObject(H2O.Studio).ingestion).savedChatArchivePresentationV1).entryPresentation;
    if (typeof present !== 'function') return [];

    var projection = safeObject(cov.projection);
    var freshnessAsserted = cleanString(projection.status) === 'ok'
      && !!cleanString(projection.contentHash);

    var sections = [];
    function push(key, title, note, entries, allowSelection) {
      var rows = asArray(entries).map(function (entry) {
        return rowFor(entry, cov, present, allowSelection);
      });
      if (rows.length) sections.push({ key: key, title: title, note: note, rows: rows });
    }

    if (freshnessAsserted) {
      push('current', TEXT.sectionCurrent, TEXT.sectionCurrentNote, cov.fresh, true);
      push('historical', TEXT.sectionHistorical, TEXT.sectionHistoricalNote, cov.stale, true);
    } else {
      /* Coverage refused to assert freshness, so neither may this card. The
       * valid populations are still shown — they are preserved either way. */
      push('preserved-generations', TEXT.sectionGenerations, TEXT.freshnessNotAsserted, cov.generations, true);
      push('preserved-legacy', TEXT.sectionLegacy, TEXT.freshnessNotAsserted, cov.legacy, true);
    }
    push('unusable', TEXT.sectionUnusable, TEXT.sectionUnusableNote, cov.unusable, false);
    return sections;
  }

  function allRowsOf(sections) {
    var rows = [];
    asArray(sections).forEach(function (section) {
      asArray(safeObject(section).rows).forEach(function (row) { rows.push(row); });
    });
    return rows;
  }

  /* ── Preview: pure helpers ────────────────────────────────────────────────
   *
   * contentHash REPRESENTATION normalization only, exactly the convention
   * coverage and the shared presentation adapter already use: the trusted wire
   * carries a bare lowercase digest and the inspector re-applies the `sha256-`
   * prefix outwardly. Nothing is recomputed here and no second stale-selection
   * policy is introduced. */
  function bareIdentity(value) {
    var text = cleanString(value).toLowerCase();
    return text.indexOf('sha256-') === 0 ? text.slice(7) : text;
  }

  /* Does the freshly reverified package still have the identity the selected row
   * was listed with? When either side carries no identity there is nothing to
   * compare, and this refuses to manufacture a mismatch — the trusted `verified`
   * verdict is the gate in that case. */
  function selectionIdentityMatches(row, inspection) {
    var expected = bareIdentity(safeObject(row).contentHash);
    var actual = bareIdentity(safeObject(safeObject(inspection).identity).contentHash);
    if (!expected || !actual) return true;
    return expected === actual;
  }

  /* Binds the two independent trusted reads — the inspection that produced the
   * verdict, and the enumeration that produced the member anchors — to the SAME
   * package state. Unlike the selected-row comparison above this is STRICT:
   * both sides are trusted output, so a missing identity on either side is
   * itself a failure to bind rather than an absence of evidence. */
  function trustedStateMatches(inspection, occupant) {
    var inspected = bareIdentity(safeObject(safeObject(inspection).identity).contentHash);
    var enumerated = bareIdentity(safeObject(occupant).contentHash);
    if (!inspected || !enumerated) return false;
    return inspected === enumerated;
  }

  /* The trusted member anchors the verifier publishes for a package occupant.
   *
   * These are the load-bearing values of the whole preview: they come from the
   * trusted scan's own read of the package, never from anything this renderer
   * or a package file claims about itself. A substituted package can copy a
   * manifest's `contentHash` string, but it cannot make the trusted scan report
   * a snapshot digest it did not compute.
   *
   * Returned only when COMPLETE. A partial set is not silently tolerated,
   * because every missing field is a check that would otherwise be skipped. */
  function trustedMemberAnchors(occupant) {
    var o = safeObject(occupant);
    var encoding = cleanString(o.snapshotEncoding);
    var physicalSha = cleanString(o.snapshotPhysicalSha256);
    var logicalSha = cleanString(o.logicalSnapshotSha256);
    var physicalLength = o.snapshotPhysicalByteLength;
    var logicalLength = o.logicalSnapshotByteLength;
    if (!encoding || !physicalSha || !logicalSha) return null;
    if (typeof physicalLength !== 'number' || !isFinite(physicalLength) || physicalLength < 0) return null;
    if (typeof logicalLength !== 'number' || !isFinite(logicalLength) || logicalLength < 0) return null;
    return {
      encoding: encoding,
      physicalSha256: physicalSha,
      physicalByteLength: physicalLength,
      logicalSha256: logicalSha,
      logicalByteLength: logicalLength,
      family: cleanString(o.constructionFamily),
    };
  }

  /* The governed member descriptor, built ENTIRELY from trusted anchors.
   *
   * The importer builds this from the package's own manifest, which is correct
   * for an import that has already verified that manifest. A preview has no such
   * verification of its own, so taking the descriptor from a freshly read
   * manifest would let a substituted package describe — and therefore validate —
   * itself. Sourcing every field from the trusted scan removes the manifest from
   * the trust chain altogether. */
  function trustedSnapshotDescriptor(anchors) {
    var a = safeObject(anchors);
    return {
      path: 'snapshot.json',
      encoding: a.encoding,
      sha256: a.physicalSha256,
      byteLength: a.physicalByteLength,
      contentSha256: a.logicalSha256,
      contentByteLength: a.logicalByteLength,
    };
  }

  /* Readable text for one mapped turn. The v3 typed text part is preferred; an
   * HTML-only body is reduced to text by the EXISTING Studio sanitizer. When
   * that sanitizer is unavailable the HTML is not rendered at all rather than
   * introducing a second sanitizer. */
  function previewTextFor(turn, extractText) {
    var t = safeObject(turn);
    var text = cleanString(t.text);
    if (text) return text;
    var html = cleanString(t.outerHtml);
    if (!html) return '';
    return (typeof extractText === 'function') ? cleanString(extractText(html)) : '';
  }

  /* Pure: mapped turns -> a bounded preview model. Truncation is always stated,
   * never silent, and no message is synthesized. */
  function buildPreviewFromTurns(turns, extractText) {
    var list = asArray(turns);
    var shown = Math.min(list.length, MAX_PREVIEW_MESSAGES);
    var messages = [];
    for (var i = 0; i < shown; i += 1) {
      var turn = safeObject(list[i]);
      var text = previewTextFor(turn, extractText);
      var tooLong = text.length > MAX_PREVIEW_CHARS;
      messages.push({
        role: cleanString(turn.role) || 'assistant',
        text: tooLong ? text.slice(0, MAX_PREVIEW_CHARS) : text,
        textTruncated: tooLong,
        assetCount: asArray(safeObject(turn.meta).assetRefs).length,
      });
    }
    return {
      messages: messages,
      totalMessages: list.length,
      shownMessages: shown,
      truncated: list.length > shown,
    };
  }

  /* ── Render ───────────────────────────────────────────────────────────── */

  function detectTauri() {
    try {
      if (typeof global.__TAURI_INTERNALS__ !== 'undefined') return true;
      if (typeof global.__TAURI__ !== 'undefined') return true;
    } catch (_) { /* ignore */ }
    return false;
  }

  function renderRecoveryCenterCard(container, options) {
    if (!container || !global.document) return null;
    var opts = safeObject(options);
    var ingestion = safeObject(safeObject(H2O.Studio).ingestion);
    var mapping = safeObject(safeObject(H2O.Studio).archiveHealthMapping);
    var inspector = safeObject(safeObject(H2O.Studio).archiveInspector);

    var readIntegrity = typeof opts.readIntegrity === 'function'
      ? opts.readIntegrity : ingestion.readSavedChatArchiveIntegrityV1;
    var partitionOccupants = typeof opts.partitionOccupants === 'function'
      ? opts.partitionOccupants : mapping.partitionOccupants;
    var describeCoverage = typeof opts.describeCoverage === 'function'
      ? opts.describeCoverage : ingestion.describeSavedChatCoverageV1;
    var describeState = typeof opts.describeState === 'function'
      ? opts.describeState : ingestion.describeSavedChatArchiveStateV1;
    var inspectPackage = typeof opts.inspectPackage === 'function'
      ? opts.inspectPackage : inspector.inspectPackage;
    var entryPresentation = typeof opts.entryPresentation === 'function'
      ? opts.entryPresentation
      : safeObject(ingestion.savedChatArchivePresentationV1).entryPresentation;
    /* The governed codec seam already used by trusted import/restore. This
     * module adds no reader of its own. */
    var codec = isObject(opts.codec) ? opts.codec : ingestion.savedChatPackageCodec;
    /* The existing PURE snapshot -> turns mapper, which owns the v3 typed-parts
     * vs v1/v2 scalar-text distinction. */
    var buildTurns = typeof opts.buildTurns === 'function'
      ? opts.buildTurns
      : safeObject(safeObject(H2O.Studio).archiveImporter).buildTurnsFromPackageSnapshot;
    /* The existing Studio sanitizer, used only to reduce an HTML-only body to
     * readable text. No markup from a package is ever rendered as markup. */
    var extractText = typeof opts.extractText === 'function'
      ? opts.extractText
      : safeObject(safeObject(safeObject(H2O.Studio).html).sanitize).extractTextFromHtml;
    /* The two governed importer entry points, and nothing else from that module
     * beyond the pure mapper resolved above. The dry-run is non-mutating; the
     * execution is the single mutation this surface can request. */
    var dryRunImport = typeof opts.dryRunImport === 'function'
      ? opts.dryRunImport
      : safeObject(safeObject(H2O.Studio).archiveImporter).dryRunImportPackage;
    var executeImport = typeof opts.executeImport === 'function'
      ? opts.executeImport
      : safeObject(safeObject(H2O.Studio).archiveImporter).importVerifiedPackage;
    /* The two governed restore entry points, and nothing else from that module.
     * The dry-run is non-mutating; the execution is the second — and only other
     * — mutation this surface can request. Everything beneath them, including
     * absent-only semantics, conflict and tombstone refusal, the trusted content
     * binding and the transaction, stays entirely inside the restore module. */
    var dryRunRestore = typeof opts.dryRunRestore === 'function'
      ? opts.dryRunRestore
      : safeObject(safeObject(H2O.Studio).archiveRestore).dryRunRestorePackage;
    var executeRestore = typeof opts.executeRestore === 'function'
      ? opts.executeRestore
      : safeObject(safeObject(H2O.Studio).archiveRestore).restoreVerifiedPackage;

    var capable = (opts.capable !== undefined)
      ? opts.capable === true
      : (detectTauri()
        && typeof readIntegrity === 'function'
        && typeof partitionOccupants === 'function'
        && typeof describeCoverage === 'function'
        && typeof inspectPackage === 'function'
        && typeof entryPresentation === 'function');

    var state = {
      phase: 'idle',
      error: '',
      complete: null,
      chats: [],
      selectedChatId: '',
      coverage: null,
      chatState: null,
      sections: [],
      chatPhase: 'idle',
      selectedPackagePath: '',
      inspection: null,
      versionPhase: 'idle',
      previewPhase: 'idle',
      preview: null,
      /* T04 request state. `recoverForPath` pins a prepared confirmation to the
       * exact version it was prepared for, so it can never be spent on another. */
      recoverPhase: 'idle',
      recoverDryRun: null,
      recoverResult: null,
      recoverForPath: '',
      /* T05 request state, deliberately SEPARATE from T04's. The two are
       * different mutations with different consequences, so one prepared
       * approval can never be spent on the other, and starting either one
       * discards any approval prepared for the other. */
      restorePhase: 'idle',
      restoreDryRun: null,
      restoreResult: null,
      restoreForPath: '',
      /* A single monotonically increasing token orders every asynchronous
       * inspection and preview read. Any result whose token is no longer current
       * is discarded, so a slow answer for an abandoned selection can never
       * overwrite a newer one. */
      requestToken: 0,
    };

    container.textContent = '';
    var card = global.document.createElement('section');
    card.setAttribute('data-h2o-card', 'saved-chat-recovery-center');
    container.appendChild(card);

    var head = el('div', null, 'display:flex;align-items:center;gap:12px;justify-content:space-between');
    head.appendChild(el('h3', TEXT.title, 'margin:0'));
    var refresh = el('button', TEXT.refreshButton);
    refresh.setAttribute('type', 'button');
    refresh.setAttribute('data-h2o-action', 'recovery-center-refresh');
    head.appendChild(refresh);
    card.appendChild(head);
    card.appendChild(el('div', TEXT.readOnlyNote, 'opacity:.7;font-size:12px;margin:4px 0 10px'));

    var noticeBox = el('div', null, 'margin:0 0 10px');
    card.appendChild(noticeBox);
    var chooserBox = el('div', null, 'display:flex;align-items:center;gap:8px;margin:0 0 10px');
    card.appendChild(chooserBox);
    var timelineBox = el('div');
    card.appendChild(timelineBox);
    var detailBox = el('div', null, 'margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08)');
    card.appendChild(detailBox);
    var previewBox = el('div', null, 'margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08)');
    card.appendChild(previewBox);
    var recoverBox = el('div', null, 'margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08)');
    card.appendChild(recoverBox);
    var restoreBox = el('div', null, 'margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08)');
    card.appendChild(restoreBox);

    function pill(label) {
      return el('span', label,
        'display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;background:rgba(240,180,60,.16);color:#f0b43c');
    }

    function renderNotices() {
      noticeBox.textContent = '';
      if (state.complete === false) {
        var warn = el('div', null, 'display:flex;align-items:center;gap:8px;flex-wrap:wrap');
        warn.appendChild(pill(TEXT.partialPill));
        warn.appendChild(el('span', TEXT.partialHeadline, 'font-weight:600'));
        noticeBox.appendChild(warn);
        noticeBox.appendChild(el('div', TEXT.partialNote, 'opacity:.8;font-size:12px;margin-top:4px'));
      }
      var cs = safeObject(state.chatState);
      if (state.selectedChatId) {
        if (cleanString(cs.discoveryNote)) {
          noticeBox.appendChild(el('div', cs.discoveryNote, 'opacity:.8;font-size:12px;margin-top:4px'));
        }
        if (cleanString(cs.projectionNote)) {
          noticeBox.appendChild(el('div', cs.projectionNote, 'opacity:.8;font-size:12px;margin-top:4px'));
        }
        if (cleanString(cs.preservedLabel) || cleanString(cs.coverageLabel)) {
          noticeBox.appendChild(el('div',
            cleanString(cs.preservedLabel) + ' · ' + cleanString(cs.coverageLabel),
            'font-size:12px;margin-top:6px'));
        }
      }
    }

    function renderChooser() {
      chooserBox.textContent = '';
      if (!state.chats.length) return;
      var label = el('label', TEXT.chatLabel, 'font-size:12px;opacity:.8');
      label.setAttribute('for', 'h2oRecoveryCenterChat');
      var select = global.document.createElement('select');
      select.id = 'h2oRecoveryCenterChat';
      select.setAttribute('data-h2o-control', 'recovery-center-chat');
      var placeholder = global.document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = TEXT.chatPlaceholder;
      select.appendChild(placeholder);
      state.chats.forEach(function (chat) {
        var option = global.document.createElement('option');
        /* Unattributed packages carry no proven chat identity, so there is
         * nothing to ask coverage about; the group is listed, not selectable. */
        option.value = chat.attributed ? chat.chatId : '';
        option.disabled = !chat.attributed;
        option.textContent = chat.label + ' (' + chat.packageCount + ')';
        if (chat.attributed && chat.chatId === state.selectedChatId) option.selected = true;
        select.appendChild(option);
      });
      select.addEventListener('change', function () { selectChat(select.value); });
      chooserBox.appendChild(label);
      chooserBox.appendChild(select);
    }

    function renderTimeline() {
      timelineBox.textContent = '';
      if (state.phase === 'ready' && !state.chats.length) {
        timelineBox.appendChild(el('div', TEXT.empty));
        timelineBox.appendChild(el('div', TEXT.emptyHint, 'opacity:.7;font-size:12px'));
        return;
      }
      if (!state.selectedChatId) return;
      if (state.chatPhase === 'loading') { timelineBox.appendChild(el('div', TEXT.loadingChat)); return; }
      if (state.chatPhase === 'error') { timelineBox.appendChild(el('div', TEXT.error)); return; }
      if (!state.sections.length) { timelineBox.appendChild(el('div', TEXT.noVersions)); return; }

      state.sections.forEach(function (section) {
        var group = el('div', null, 'margin:10px 0 0');
        group.setAttribute('data-h2o-section', section.key);
        group.appendChild(el('div', section.title, 'font-weight:600;font-size:13px'));
        if (section.note) group.appendChild(el('div', section.note, 'opacity:.75;font-size:12px;margin-bottom:4px'));
        section.rows.forEach(function (row) {
          group.appendChild(renderRow(row));
        });
        timelineBox.appendChild(group);
      });
    }

    function renderRow(row) {
      var selected = row.selectable && row.packagePath === state.selectedPackagePath;
      var line = global.document.createElement(row.selectable ? 'button' : 'div');
      if (row.selectable) {
        line.setAttribute('type', 'button');
        line.setAttribute('data-h2o-action', 'recovery-center-select-version');
        line.addEventListener('click', function () { selectVersion(row.packagePath); });
      }
      line.setAttribute('data-h2o-row', 'recovery-center-version');
      line.setAttribute('data-h2o-selectable', row.selectable ? '1' : '0');
      if (selected) line.setAttribute('data-h2o-selected', '1');
      line.setAttribute('style', 'display:block;width:100%;text-align:left;margin:4px 0;padding:8px 10px;border-radius:8px;'
        + 'border:1px solid rgba(255,255,255,' + (selected ? '.30' : '.10') + ');'
        + 'background:rgba(255,255,255,' + (selected ? '.06' : '.02') + ');'
        + 'color:inherit;font:inherit;'
        + (row.selectable ? 'cursor:pointer' : 'cursor:default;opacity:.75'));

      var top = el('div', null, 'display:flex;gap:8px;flex-wrap:wrap;align-items:baseline');
      top.appendChild(el('span', row.kindLabel, 'font-weight:600;font-size:13px'));
      top.appendChild(el('span', row.freshnessLabel, 'font-size:12px;opacity:.85'));
      if (row.savedAt) top.appendChild(el('span', row.savedAt, 'font-size:12px;opacity:.6'));
      line.appendChild(top);
      line.appendChild(el('div', row.packageDirName, 'font-size:11px;opacity:.6;word-break:break-all'));
      if (row.blockers.length) {
        line.appendChild(el('div', TEXT.blockersHeading + ': ' + row.blockers.join(', '),
          'font-size:11px;opacity:.8;margin-top:2px'));
      }
      return line;
    }

    function renderDetail() {
      detailBox.textContent = '';
      detailBox.appendChild(el('div', TEXT.detailHeading, 'font-weight:600;font-size:13px'));
      if (!state.selectedPackagePath) { detailBox.appendChild(el('div', TEXT.detailIdle, 'opacity:.75;font-size:12px')); return; }
      if (state.versionPhase === 'loading') { detailBox.appendChild(el('div', TEXT.loadingVersion)); return; }
      var ins = safeObject(state.inspection);
      if (state.versionPhase === 'error' || !cleanString(ins.status)) {
        detailBox.appendChild(el('div', TEXT.detailUnavailable, 'opacity:.85;font-size:12px'));
        return;
      }
      var identity = safeObject(ins.identity);
      var list = el('div', null, 'font-size:12px;display:grid;gap:2px;margin-top:4px');
      function pair(key, value) {
        if (!cleanString(value) && value !== 0) return;
        list.appendChild(el('div', key + ': ' + value, 'word-break:break-all'));
      }
      pair('Status', ins.status);
      pair('Package', ins.packageDirName);
      if (cleanString(identity.title)) pair('Title', identity.title);
      pair('Chat', identity.chatId);
      pair('Snapshot', identity.snapshotId);
      pair('Verified contentHash', identity.contentHash);
      if (identity.schemaVersion !== null && identity.schemaVersion !== undefined) pair('Format', 'v' + identity.schemaVersion);
      if (identity.messageCount !== null && identity.messageCount !== undefined) pair('Messages', String(identity.messageCount));
      detailBox.appendChild(list);
      if (asArray(ins.blockers).length) {
        detailBox.appendChild(el('div', TEXT.blockersHeading + ': ' + asArray(ins.blockers).join(', '),
          'font-size:12px;opacity:.85;margin-top:6px'));
      }
      if (safeObject(ins.checks).archiveEnumerationComplete === false) {
        detailBox.appendChild(el('div', TEXT.partialNote, 'font-size:12px;opacity:.8;margin-top:6px'));
      }
    }

    /* Archived content is DATA. Every value below is written with textContent;
     * this function assigns no innerHTML and creates no interactive control from
     * package content. */
    function renderPreview() {
      previewBox.textContent = '';
      previewBox.appendChild(el('div', TEXT.previewHeading, 'font-weight:600;font-size:13px'));

      var phase = state.previewPhase;
      var flat = {
        idle: TEXT.previewIdle,
        loading: TEXT.previewLoading,
        refused: TEXT.previewRefused,
        stale: TEXT.previewStale,
        unbindable: TEXT.previewUnbindable,
        unsupported: TEXT.previewUnsupported,
        error: TEXT.previewError,
        empty: TEXT.previewEmpty,
      };
      if (Object.prototype.hasOwnProperty.call(flat, phase)) {
        previewBox.appendChild(el('div', flat[phase], 'opacity:.8;font-size:12px;margin-top:4px'));
        return;
      }
      if (phase !== 'ready') return;

      var preview = safeObject(state.preview);
      var head = el('div', null, 'font-size:12px;margin-top:4px;display:grid;gap:2px');
      if (cleanString(preview.title)) head.appendChild(el('div', preview.title, 'font-weight:600'));
      var meta = [];
      if (cleanString(preview.capturedAt)) meta.push(preview.capturedAt);
      if (preview.schemaVersion !== null && preview.schemaVersion !== undefined) meta.push('Format v' + preview.schemaVersion);
      meta.push(preview.totalMessages + (preview.totalMessages === 1 ? ' message' : ' messages'));
      head.appendChild(el('div', meta.join(' · '), 'opacity:.7'));
      previewBox.appendChild(head);

      if (preview.truncated) {
        previewBox.appendChild(el('div',
          TEXT.previewTruncatedNote + preview.shownMessages + TEXT.previewTruncatedNoteTail + preview.totalMessages + '.',
          'font-size:12px;opacity:.8;margin-top:6px'));
      }

      var list = el('div', null, 'margin-top:8px;display:grid;gap:6px;max-height:420px;overflow:auto');
      list.setAttribute('data-h2o-preview', 'messages');
      asArray(preview.messages).forEach(function (message) {
        var row = el('div', null, 'padding:6px 8px;border-radius:6px;background:rgba(255,255,255,.03)');
        row.setAttribute('data-h2o-preview-role', message.role);
        row.appendChild(el('div', message.role, 'font-size:11px;opacity:.65;text-transform:uppercase;letter-spacing:.04em'));
        var body = el('div', message.text, 'font-size:12px;white-space:pre-wrap;word-break:break-word;margin-top:2px');
        row.appendChild(body);
        if (message.textTruncated) {
          row.appendChild(el('div', TEXT.previewMessageTruncated, 'font-size:11px;opacity:.7;margin-top:2px'));
        }
        if (message.assetCount) {
          row.appendChild(el('div', TEXT.previewAssets + message.assetCount, 'font-size:11px;opacity:.7;margin-top:2px'));
        }
        list.appendChild(row);
      });
      previewBox.appendChild(list);
    }

    /* The recovery request area. It appears only once a version has actually
     * been previewed, and the confirming control appears only while a current
     * import-ready verdict belongs to the selected version. Both controls are
     * ordinary buttons — there is no native confirm dialog and no generic
     * confirmation framework. */
    function renderRecover() {
      recoverBox.textContent = '';
      if (!state.selectedPackagePath || !previewIsReadable()) return;

      recoverBox.appendChild(el('div', TEXT.recoverHeading, 'font-weight:600;font-size:13px'));
      recoverBox.appendChild(el('div', TEXT.recoverIntro, 'opacity:.8;font-size:12px;margin-top:2px'));

      var busy = state.recoverPhase === 'preflighting' || state.recoverPhase === 'executing';
      var controls = el('div', null, 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px');
      var prepare = el('button', TEXT.recoverPrepareButton);
      prepare.setAttribute('type', 'button');
      prepare.setAttribute('data-h2o-action', 'recovery-center-prepare-recover-as-new');
      prepare.disabled = busy;
      prepare.addEventListener('click', function () { prepareRecoverAsNew(); });
      controls.appendChild(prepare);

      /* The mutation control EXISTS only while a current confirmation stands. */
      if (recoverConfirmable()) {
        var confirmBtn = el('button', TEXT.recoverConfirmButton);
        confirmBtn.setAttribute('type', 'button');
        confirmBtn.setAttribute('data-h2o-action', 'recovery-center-recover-as-new');
        confirmBtn.disabled = busy;
        confirmBtn.addEventListener('click', function () { executeRecoverAsNew(); });
        controls.appendChild(confirmBtn);
      }
      recoverBox.appendChild(controls);

      var status = {
        preflighting: TEXT.recoverPreflighting,
        executing: TEXT.recoverExecuting,
        'ready-to-confirm': TEXT.recoverReadyToConfirm,
        refused: TEXT.recoverRefused,
        error: TEXT.recoverError,
        stale: TEXT.recoverStale,
        success: TEXT.recoverSuccess,
      };
      if (Object.prototype.hasOwnProperty.call(status, state.recoverPhase)) {
        recoverBox.appendChild(el('div', status[state.recoverPhase], 'font-size:12px;margin-top:8px'));
      }

      /* The importer's own verdict, reported as it stated it. Nothing here
       * re-derives recoverability, conflicts, verification or refusal meaning. */
      var dry = safeObject(state.recoverDryRun);
      if (cleanString(dry.decision)) {
        recoverBox.appendChild(el('div', TEXT.recoverDecision + dry.decision, 'font-size:12px;opacity:.85;margin-top:4px'));
        if (cleanString(dry.reason)) {
          recoverBox.appendChild(el('div', TEXT.recoverReason + dry.reason, 'font-size:12px;opacity:.75'));
        }
      }
      var done = safeObject(state.recoverResult);
      if (cleanString(done.status)) {
        recoverBox.appendChild(el('div', TEXT.recoverDecision + done.status, 'font-size:12px;opacity:.85;margin-top:4px'));
        if (cleanString(done.reason)) {
          recoverBox.appendChild(el('div', TEXT.recoverReason + done.reason, 'font-size:12px;opacity:.75'));
        }
        /* Only what the importer itself returned about the recovered chat. */
        var recovered = safeObject(done.recovered);
        if (cleanString(recovered.chatId)) {
          recoverBox.appendChild(el('div', TEXT.recoverNewChat + recovered.chatId, 'font-size:12px;opacity:.85'));
        }
      }
    }

    /* The restore request area. Same shape as the recovery area above and
     * deliberately NOT merged with it: two separate operations, two separate
     * approvals, two separate governed calls. It appears only once a version has
     * actually been previewed, and the confirming control appears only while a
     * current restore-ready verdict belongs to the selected version. Both
     * controls are ordinary buttons — no native confirm dialog, no generic
     * confirmation framework. */
    function renderRestore() {
      restoreBox.textContent = '';
      if (!state.selectedPackagePath || !previewIsReadable()) return;

      restoreBox.appendChild(el('div', TEXT.restoreHeading, 'font-weight:600;font-size:13px'));
      restoreBox.appendChild(el('div', TEXT.restoreIntro, 'opacity:.8;font-size:12px;margin-top:2px'));

      var busy = state.restorePhase === 'preflighting' || state.restorePhase === 'executing';
      var controls = el('div', null, 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px');
      var prepare = el('button', TEXT.restorePrepareButton);
      prepare.setAttribute('type', 'button');
      prepare.setAttribute('data-h2o-action', 'recovery-center-prepare-restore-original');
      prepare.disabled = busy;
      prepare.addEventListener('click', function () { prepareRestoreOriginal(); });
      controls.appendChild(prepare);

      /* The mutation control EXISTS only while a current approval stands. */
      if (restoreConfirmable()) {
        var confirmBtn = el('button', TEXT.restoreConfirmButton);
        confirmBtn.setAttribute('type', 'button');
        confirmBtn.setAttribute('data-h2o-action', 'recovery-center-restore-original');
        confirmBtn.disabled = busy;
        confirmBtn.addEventListener('click', function () { executeRestoreOriginal(); });
        controls.appendChild(confirmBtn);
      }
      restoreBox.appendChild(controls);

      var status = {
        preflighting: TEXT.restorePreflighting,
        executing: TEXT.restoreExecuting,
        'ready-to-confirm': TEXT.restoreReadyToConfirm,
        'no-write': TEXT.restoreNoWrite,
        refused: TEXT.restoreRefused,
        error: TEXT.restoreError,
        stale: TEXT.restoreStale,
        success: TEXT.restoreSuccess,
      };
      if (Object.prototype.hasOwnProperty.call(status, state.restorePhase)) {
        restoreBox.appendChild(el('div', status[state.restorePhase], 'font-size:12px;margin-top:8px'));
      }

      /* The restore module's own verdict, reported as it stated it. Nothing here
       * re-derives eligibility, conflicts, tombstones, digest comparability or
       * overwrite safety. */
      var dry = safeObject(state.restoreDryRun);
      if (cleanString(dry.decision)) {
        restoreBox.appendChild(el('div', TEXT.restoreDecision + dry.decision, 'font-size:12px;opacity:.85;margin-top:4px'));
        if (cleanString(dry.reason)) {
          restoreBox.appendChild(el('div', TEXT.restoreReason + dry.reason, 'font-size:12px;opacity:.75'));
        }
      }
      var done = safeObject(state.restoreResult);
      if (cleanString(done.status)) {
        restoreBox.appendChild(el('div', TEXT.restoreDecision + done.status, 'font-size:12px;opacity:.85;margin-top:4px'));
        if (cleanString(done.reason)) {
          restoreBox.appendChild(el('div', TEXT.restoreReason + done.reason, 'font-size:12px;opacity:.75'));
        }
        /* Only what the restore module itself returned about the restored rows.
         * Nothing is fabricated and nothing is counted here. */
        var restored = safeObject(done.restored);
        if (cleanString(restored.chatId)) {
          restoreBox.appendChild(el('div', TEXT.restoreChat + restored.chatId, 'font-size:12px;opacity:.85'));
        }
        if (cleanString(restored.snapshotId)) {
          restoreBox.appendChild(el('div', TEXT.restoreSnapshot + restored.snapshotId, 'font-size:12px;opacity:.85'));
        }
        if (typeof restored.turnCount === 'number') {
          restoreBox.appendChild(el('div', TEXT.restoreTurns + restored.turnCount, 'font-size:12px;opacity:.85'));
        }
      }
    }

    function render() {
      if (!capable) {
        card.textContent = '';
        card.appendChild(el('h3', TEXT.title, 'margin:0'));
        card.appendChild(el('div', TEXT.unavailable, 'margin-top:6px'));
        return;
      }
      refresh.disabled = state.phase === 'loading';
      if (state.phase === 'loading') {
        noticeBox.textContent = ''; chooserBox.textContent = '';
        timelineBox.textContent = ''; detailBox.textContent = ''; previewBox.textContent = '';
        recoverBox.textContent = ''; restoreBox.textContent = '';
        timelineBox.appendChild(el('div', TEXT.loading));
        return;
      }
      if (state.phase === 'error') {
        noticeBox.textContent = ''; chooserBox.textContent = '';
        timelineBox.textContent = ''; detailBox.textContent = ''; previewBox.textContent = '';
        recoverBox.textContent = ''; restoreBox.textContent = '';
        timelineBox.appendChild(el('div', TEXT.error + (state.error ? ' ' + state.error : '')));
        return;
      }
      renderNotices();
      renderChooser();
      renderTimeline();
      renderDetail();
      renderPreview();
      renderRecover();
      renderRestore();
    }

    /* ONE trusted read per open/refresh. Rows never trigger their own. */
    function load() {
      if (!capable) { render(); return Promise.resolve(); }
      invalidateRequests();
      state.phase = 'loading';
      state.error = '';
      render();
      return Promise.resolve()
        .then(function () { return readIntegrity(); })
        .then(function (envelope) {
          var env = safeObject(envelope);
          /* Completeness is the trusted envelope's own statement. A missing
           * flag is treated as incomplete rather than assumed complete. */
          state.complete = env.complete === true;
          var partition = safeObject(partitionOccupants(env.occupants));
          state.chats = buildChatIndex(partition.packageOccupants);
          state.phase = 'ready';
          /* A refresh must not leave a selection pointing at something the new
           * evidence no longer contains. */
          var stillPresent = state.chats.some(function (chat) {
            return chat.attributed && chat.chatId === state.selectedChatId;
          });
          if (!stillPresent) {
            state.selectedChatId = '';
            clearChat();
            render();
            return null;
          }
          return loadChat(state.selectedChatId);
        })
        .catch(function (err) {
          state.phase = 'error';
          state.error = cleanString(String((err && err.message) || err || ''));
          state.complete = null;
          state.chats = [];
          state.selectedChatId = '';
          clearChat();
          render();
        });
    }

    function clearChat() {
      state.coverage = null;
      state.chatState = null;
      state.sections = [];
      state.chatPhase = 'idle';
      clearVersion();
    }

    function clearVersion() {
      state.selectedPackagePath = '';
      state.inspection = null;
      state.versionPhase = 'idle';
      clearPreview();
    }

    /* Preview content never outlives the selection that justified it. */
    function clearPreview() {
      state.previewPhase = 'idle';
      state.preview = null;
      clearPreparedActions();
    }

    /* Both prepared approvals die together whenever the thing they depended on
     * moves. Neither operation may outlive the selection, chat, preview or card
     * instance that justified it. */
    function clearPreparedActions() {
      clearRecover();
      clearRestore();
    }

    /* A prepared confirmation is discarded whenever anything it depended on
     * moves. It is presentation state, so losing it costs only a click; keeping
     * it would let an operator spend one version's approval on another. */
    function clearRecover() {
      state.recoverPhase = 'idle';
      state.recoverDryRun = null;
      state.recoverResult = null;
      state.recoverForPath = '';
    }

    /* The T05 counterpart. Separate state, separate lifetime. */
    function clearRestore() {
      state.restorePhase = 'idle';
      state.restoreDryRun = null;
      state.restoreResult = null;
      state.restoreForPath = '';
    }

    /* The preview actually loaded for the version now selected. */
    function previewIsReadable() {
      return PREVIEWED_PHASES.indexOf(state.previewPhase) >= 0;
    }

    /* A confirmation may be spent only on the version it was prepared for, only
     * while that version is still selected and still readable. */
    function recoverConfirmable() {
      return state.recoverPhase === 'ready-to-confirm'
        && !!state.recoverForPath
        && state.recoverForPath === state.selectedPackagePath
        && isScopedPackagePath(state.selectedPackagePath)
        && previewIsReadable();
    }

    /* A request that has been issued and has not settled. */
    function isBusyPhase(phase) {
      return phase === 'preflighting' || phase === 'executing';
    }

    /* T04 and T05 share ONE request token, so starting either one strands any
     * IN-FLIGHT read belonging to the other: its result is discarded and its
     * phase would never settle. A busy counterpart is therefore reset when a
     * request starts. A SETTLED approval is deliberately left alone here — it is
     * invalidated when a mutation actually BEGINS, which is the moment the store
     * it was judged against is about to change. */
    function releaseStrandedRecover() { if (isBusyPhase(state.recoverPhase)) clearRecover(); }
    function releaseStrandedRestore() { if (isBusyPhase(state.restorePhase)) clearRestore(); }

    /* The T05 counterpart, on its own pinned path. */
    function restoreConfirmable() {
      return state.restorePhase === 'ready-to-confirm'
        && !!state.restoreForPath
        && state.restoreForPath === state.selectedPackagePath
        && isScopedPackagePath(state.selectedPackagePath)
        && previewIsReadable();
    }

    /* Invalidate every in-flight inspection and preview read. */
    function invalidateRequests() {
      state.requestToken += 1;
      return state.requestToken;
    }
    function currentToken(token) { return token === state.requestToken; }

    /* One coverage call per chat selection — never one per row. */
    function loadChat(chatId) {
      var id = cleanString(chatId);
      invalidateRequests();
      if (!id) { clearChat(); render(); return Promise.resolve(); }
      state.chatPhase = 'loading';
      clearVersion();
      render();
      return Promise.resolve()
        .then(function () { return describeCoverage({ chatId: id }); })
        .then(function (coverage) {
          /* A slower response for a chat the operator has since left must never
           * overwrite the current one. */
          if (cleanString(state.selectedChatId) !== id) return;
          state.coverage = safeObject(coverage);
          state.chatState = (typeof describeState === 'function')
            ? safeObject(describeState(state.coverage)) : null;
          state.sections = buildTimelineSections(state.coverage, entryPresentation);
          state.chatPhase = 'ready';
          render();
        })
        .catch(function () {
          if (cleanString(state.selectedChatId) !== id) return;
          state.chatPhase = 'error';
          state.sections = [];
          render();
        });
    }

    function selectChat(chatId) {
      var id = cleanString(chatId);
      if (id === state.selectedChatId) return Promise.resolve();
      state.selectedChatId = id;
      return loadChat(id);
    }

    /* Locate the trusted occupant for exactly this package in a FRESH trusted
     * enumeration. The canonical partition is reused, so reserved
     * infrastructure and non-package strays can never be matched. */
    function trustedOccupantFor(packagePath) {
      return Promise.resolve()
        .then(function () { return readIntegrity(); })
        .then(function (envelope) {
          var partition = safeObject(partitionOccupants(safeObject(envelope).occupants));
          var found = null;
          asArray(partition.packageOccupants).forEach(function (occupant) {
            if (!found && cleanString(safeObject(occupant).path) === packagePath) found = safeObject(occupant);
          });
          return found;
        });
    }

    /* Read the snapshot bytes BOUND to the trusted anchors.
     *
     * v3 goes through the governed verified-member path with a descriptor built
     * from trusted values, so the codec's physical size/digest, encoding,
     * bounded decode and logical size/digest checks are all made against what
     * the trusted scan measured. A v3 package whose trusted anchors are absent
     * is refused outright — it never falls through to the plain read, because
     * that fallback is exactly how a v3 package could be downgraded into an
     * unverified one.
     *
     * v1/v2 have no governed logical representation, so the bounded read is used
     * and its returned physical digest and length are compared against the
     * trusted anchors before a single byte is parsed. */
    function readBoundSnapshot(packagePath, anchors) {
      if (!isObject(codec) || typeof codec.readBoundedPackageMemberBytes !== 'function'
        || typeof codec.readVerifiedPackageMember !== 'function') {
        return Promise.reject(new Error('preview-codec-unavailable'));
      }
      var snapshotCap = codec.LOGICAL_SNAPSHOT_CAP_BYTES;
      if (anchors.family === FAMILY_V3) {
        return Promise.resolve(codec.readVerifiedPackageMember({
          packagePath: packagePath,
          descriptor: trustedSnapshotDescriptor(anchors),
          expectedPath: 'snapshot.json',
          physicalByteCap: snapshotCap,
          logicalByteCap: snapshotCap,
        })).then(function (verified) {
          return jsonFromBytes(safeObject(verified).logicalBytes);
        });
      }
      return Promise.resolve(codec.readBoundedPackageMemberBytes({
        packagePath: packagePath,
        memberPath: 'snapshot.json',
        physicalByteCap: snapshotCap,
      })).then(function (bounded) {
        var read = safeObject(bounded);
        /* The digest is RETURNED by the governed reader; nothing is recomputed
         * here. It is compared against what the trusted scan measured, so a
         * package substituted after inspection cannot be parsed. */
        if (bareIdentity(read.physicalSha256) !== bareIdentity(anchors.physicalSha256)) {
          throw new Error('preview-member-digest-mismatch');
        }
        if (read.physicalByteLength !== anchors.physicalByteLength) {
          throw new Error('preview-member-length-mismatch');
        }
        return jsonFromBytes(read.storedBytes);
      });
    }

    /* One inspection per version selection — never one per row — and the
     * preview is gated on THAT fresh verdict, never on the list result. */
    function selectVersion(packagePath) {
      var path = cleanString(packagePath);
      var row = null;
      allRowsOf(state.sections).forEach(function (candidate) {
        if (!row && candidate.packagePath === path) row = candidate;
      });
      /* Selection identity is the trusted row's own archive-relative path. An
       * unknown, unscoped or non-selectable target is refused outright. */
      if (!row || !row.selectable) return Promise.resolve();
      var token = invalidateRequests();
      state.selectedPackagePath = path;
      state.inspection = null;
      state.versionPhase = 'loading';
      state.previewPhase = 'loading';
      state.preview = null;
      /* Any approval prepared for the previous version dies here — both of them.
       * The path pin already makes each unspendable, but leaving the phase
       * behind would show a confirmed-looking state for a version nobody
       * approved. Re-selecting the SAME version clears them too, so a prepared
       * approval can never be resurrected by navigating back to it. */
      clearPreparedActions();
      render();
      return Promise.resolve()
        .then(function () { return inspectPackage({ packagePath: path }); })
        .then(function (result) {
          if (!currentToken(token)) return null;
          var inspection = safeObject(result);
          state.inspection = inspection;
          state.versionPhase = 'ready';

          /* The list said this row was usable; only the FRESH trusted verdict
           * may open the content. */
          if (cleanString(inspection.status) !== 'verified') {
            state.previewPhase = 'refused';
            state.preview = null;
            render();
            return null;
          }
          /* The address still resolves, but to a package with a different
           * identity: refuse rather than silently preview a different version. */
          if (!selectionIdentityMatches(row, inspection)) {
            state.previewPhase = 'stale';
            state.preview = null;
            render();
            return null;
          }
          render();

          /* The verdict is fresh, and the selected row still names this
           * identity. What is still unproven is that the bytes about to be read
           * belong to the state that was just verified — so the member anchors
           * are taken from a fresh trusted enumeration and bound to the
           * inspection before anything is read. */
          return trustedOccupantFor(path).then(function (occupant) {
            if (!currentToken(token)) return;
            if (!occupant || !trustedStateMatches(inspection, occupant)) {
              state.previewPhase = 'stale';
              state.preview = null;
              render();
              return;
            }
            var anchors = trustedMemberAnchors(occupant);
            if (!anchors) {
              /* A v3 package with no governed member facts is refused, never
               * downgraded into the plain read. */
              state.previewPhase = 'unbindable';
              state.preview = null;
              render();
              return;
            }
            return readBoundSnapshot(path, anchors).then(function (snapshot) {
              if (!currentToken(token)) return;
              if (!isObject(snapshot)) {
                state.previewPhase = 'error';
                state.preview = null;
                render();
                return;
              }
              var turns = (typeof buildTurns === 'function') ? buildTurns(snapshot) : [];
              var preview = buildPreviewFromTurns(turns, extractText);
              preview.title = cleanString(snapshot.title)
                || cleanString(safeObject(inspection.identity).title);
              preview.capturedAt = cleanString(snapshot.capturedAt);
              preview.schemaVersion = safeObject(inspection.identity).schemaVersion;
              state.preview = preview;
              state.previewPhase = preview.totalMessages ? 'ready' : 'empty';
              render();
            }, function (err) {
              if (!currentToken(token)) return;
              state.previewPhase = (cleanString(String(safeObject(err).message)) === 'preview-codec-unavailable')
                ? 'unsupported' : 'error';
              state.preview = null;
              render();
            });
          }, function () {
            if (!currentToken(token)) return;
            /* The trusted enumeration itself failed: nothing can be bound, so
             * nothing is shown. */
            state.previewPhase = 'error';
            state.preview = null;
            render();
          });
        })
        .catch(function () {
          if (!currentToken(token)) return;
          state.versionPhase = 'error';
          state.previewPhase = 'error';
          state.preview = null;
          render();
        });
    }

    /* STEP ONE — non-mutating. Runs the importer's OWN dry-run and shows its
     * verdict. Nothing here interprets that verdict beyond deciding whether to
     * offer the second action. */
    function prepareRecoverAsNew() {
      if (typeof dryRunImport !== 'function') return Promise.resolve();
      var path = cleanString(state.selectedPackagePath);
      if (!path || !isScopedPackagePath(path) || !previewIsReadable()) return Promise.resolve();
      if (state.recoverPhase === 'preflighting' || state.recoverPhase === 'executing') return Promise.resolve();
      var token = invalidateRequests();
      releaseStrandedRestore();
      clearRecover();
      state.recoverPhase = 'preflighting';
      render();
      return Promise.resolve()
        .then(function () { return dryRunImport({ packagePath: path }); })
        .then(function (result) {
          if (!currentToken(token) || state.selectedPackagePath !== path) return;
          var dry = safeObject(result);
          state.recoverDryRun = dry;
          if (cleanString(dry.decision) === IMPORT_READY) {
            state.recoverPhase = 'ready-to-confirm';
            state.recoverForPath = path;
          } else {
            /* Every other verdict — including the importer's other `ok` value —
             * is reported as the importer stated it, with no action offered. */
            state.recoverPhase = 'refused';
            state.recoverForPath = '';
          }
          render();
        })
        .catch(function () {
          if (!currentToken(token) || state.selectedPackagePath !== path) return;
          state.recoverPhase = 'error';
          state.recoverDryRun = null;
          state.recoverForPath = '';
          render();
        });
    }

    /* STEP TWO — the single mutation this surface can request. It sends the
     * trusted row's own archive-relative path and the importer's mode, and
     * nothing else: no dry-run result, no eligibility, no identity, no hash. The
     * importer re-runs its dry-run, re-verifies at the write gate, allocates the
     * fresh recovered identity and decides the outcome. */
    function executeRecoverAsNew() {
      if (typeof executeImport !== 'function') return Promise.resolve();
      if (!recoverConfirmable()) return Promise.resolve();
      var path = cleanString(state.selectedPackagePath);
      var token = invalidateRequests();
      /* A T05 approval prepared BEFORE this mutation request must never be
       * spendable after it: the store it was judged against is about to change. */
      clearRestore();
      /* Consumed synchronously, before the first await: the phase transition
       * makes recoverConfirmable() false, so a second synchronous dispatch of
       * this action cannot issue a second import. */
      state.recoverPhase = 'executing';
      state.recoverForPath = '';
      state.recoverResult = null;
      render();
      return Promise.resolve()
        .then(function () { return executeImport({ packagePath: path, mode: IMPORT_MODE }); })
        .then(function (result) {
          if (!currentToken(token) || state.selectedPackagePath !== path) return;
          var imported = safeObject(result);
          state.recoverResult = imported;
          state.recoverPhase = imported.ok === true ? 'success' : 'refused';
          state.recoverForPath = '';
          render();
        })
        .catch(function () {
          if (!currentToken(token) || state.selectedPackagePath !== path) return;
          state.recoverPhase = 'error';
          state.recoverResult = null;
          state.recoverForPath = '';
          render();
        });
    }

    /* T05 STEP ONE — non-mutating. Runs the restore module's OWN dry-run and
     * shows its verdict. Nothing here interprets that verdict beyond deciding
     * whether to offer the second action: conflict, tombstone, digest
     * comparability, eligibility and overwrite safety are all decided there. */
    function prepareRestoreOriginal() {
      if (typeof dryRunRestore !== 'function') return Promise.resolve();
      var path = cleanString(state.selectedPackagePath);
      if (!path || !isScopedPackagePath(path) || !previewIsReadable()) return Promise.resolve();
      if (state.restorePhase === 'preflighting' || state.restorePhase === 'executing') return Promise.resolve();
      var token = invalidateRequests();
      releaseStrandedRecover();
      clearRestore();
      state.restorePhase = 'preflighting';
      render();
      return Promise.resolve()
        .then(function () { return dryRunRestore({ packagePath: path }); })
        .then(function (result) {
          if (!currentToken(token) || state.selectedPackagePath !== path) return;
          var dry = safeObject(result);
          state.restoreDryRun = dry;
          var decision = cleanString(dry.decision);
          if (decision === RESTORE_READY) {
            state.restorePhase = 'ready-to-confirm';
            state.restoreForPath = path;
          } else if (decision === RESTORE_ALREADY_PRESENT) {
            /* The restore module's other `ok` verdict. Nothing would be written,
             * so it is reported as exactly that and no action is offered. */
            state.restorePhase = 'no-write';
            state.restoreForPath = '';
          } else {
            /* Every refusal — conflict-chat-id, conflict-snapshot-id, tombstoned,
             * rejected, corrupted, unsupported-version, read-error — is reported
             * as the restore module stated it, with no action offered and no
             * fallback of any kind. */
            state.restorePhase = 'refused';
            state.restoreForPath = '';
          }
          render();
        })
        .catch(function () {
          if (!currentToken(token) || state.selectedPackagePath !== path) return;
          state.restorePhase = 'error';
          state.restoreDryRun = null;
          state.restoreForPath = '';
          render();
        });
    }

    /* T05 STEP TWO — the second mutation this surface can request, and the last.
     * It sends the trusted row's own archive-relative path, the restore module's
     * mode and its explicit confirmation, and nothing else: no dry-run result,
     * no eligibility, no identity, no hash, no conflict or tombstone finding.
     * The restore module re-runs its own dry-run, re-establishes the trusted
     * content binding at the write gate, re-checks conflicts and tombstones
     * inside the transaction, and decides the outcome. */
    function executeRestoreOriginal() {
      if (typeof executeRestore !== 'function') return Promise.resolve();
      if (!restoreConfirmable()) return Promise.resolve();
      var path = cleanString(state.selectedPackagePath);
      var token = invalidateRequests();
      /* A T04 approval prepared BEFORE this mutation request must never be
       * spendable after it. */
      clearRecover();
      /* Consumed synchronously, before the first await: both the phase
       * transition and the cleared path pin make restoreConfirmable() false, so
       * rapid repeated dispatches issue exactly one restore for one approval. */
      state.restorePhase = 'executing';
      state.restoreForPath = '';
      state.restoreResult = null;
      render();
      return Promise.resolve()
        .then(function () { return executeRestore({ packagePath: path, mode: RESTORE_MODE, confirm: true }); })
        .then(function (result) {
          if (!currentToken(token) || state.selectedPackagePath !== path) return;
          var restored = safeObject(result);
          state.restoreResult = restored;
          var status = cleanString(restored.status);
          /* Success is read from the STATUS, never from `ok`: the restore module
           * reports ok === true for already-present too, and a no-write outcome
           * must never be shown as a restore that happened. */
          if (status === RESTORE_RESTORED) state.restorePhase = 'success';
          else if (status === RESTORE_ALREADY_PRESENT) state.restorePhase = 'no-write';
          else state.restorePhase = 'refused';
          render();
        })
        .catch(function () {
          if (!currentToken(token) || state.selectedPackagePath !== path) return;
          state.restorePhase = 'error';
          state.restoreResult = null;
          render();
        });
    }

    refresh.addEventListener('click', function () { load(); });

    render();
    if (capable && opts.autoLoad !== false) load();

    return {
      getState: function () { return state; },
      load: load,
      selectChat: selectChat,
      selectVersion: selectVersion,
      prepareRecoverAsNew: prepareRecoverAsNew,
      recoverAsNew: executeRecoverAsNew,
      prepareRestoreOriginalIdentity: prepareRestoreOriginal,
      restoreOriginalIdentity: executeRestoreOriginal,
    };
  }

  /* Mount as a SIBLING below the read-only Archive Health card, so a health
   * re-render never wipes it. Idempotent: the stable mount owns exactly one
   * card and one set of listeners even if Settings re-enters. */
  function mountRecoveryCenterCard(healthContainer, options) {
    if (!healthContainer || !global.document) return null;
    var container = healthContainer;
    var parent = healthContainer.parentNode;
    if (parent && typeof parent.appendChild === 'function') {
      var mount = (typeof parent.querySelector === 'function')
        ? parent.querySelector('[data-h2o-recovery-center-mount="1"]') : null;
      if (!mount) {
        mount = global.document.createElement('div');
        mount.setAttribute('data-h2o-recovery-center-mount', '1');
        mount.style.marginTop = '12px';
        parent.appendChild(mount);
      }
      mount.textContent = '';
      container = mount;
    }
    return renderRecoveryCenterCard(container, options || {});
  }

  H2O.Studio.recoveryCenterUi = {
    __installed: true,
    __version: MODULE_VERSION,
    TEXT: TEXT,
    buildChatIndex: buildChatIndex,
    buildTimelineSections: buildTimelineSections,
    buildPreviewFromTurns: buildPreviewFromTurns,
    selectionIdentityMatches: selectionIdentityMatches,
    trustedStateMatches: trustedStateMatches,
    trustedMemberAnchors: trustedMemberAnchors,
    trustedSnapshotDescriptor: trustedSnapshotDescriptor,
    renderRecoveryCenterCard: renderRecoveryCenterCard,
    mountRecoveryCenterCard: mountRecoveryCenterCard,
  };
})(typeof window !== 'undefined' ? window : globalThis);
