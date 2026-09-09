/* H2O Studio — Saved Chat Archive Importer / Recovery (Desktop, Phase H.4)
 *
 * Chat Saving Architecture Phase H.4. The FIRST import/recovery action for a
 * written `.h2ochat` package. It is a focused, Desktop-only, SIBLING of the
 * read-only Archive Inspector (the inspector stays read-only; this module owns
 * the single, verification-gated write). Two-step, no silent overwrite:
 *
 *   1. dryRunImportPackage({ packagePath })   — NON-MUTATING. Reuses the
 *      read-only inspector for verification, then reads existing store state to
 *      decide one of:
 *        import-ready / already-imported / conflict-chat-id /
 *        conflict-snapshot-id / corrupted / rejected.
 *      It performs only reads (inspect + store.get/listByChat); it never writes.
 *
 *   2. importVerifiedPackage({ packagePath, mode }) — EXPLICIT operator action.
 *      Allowed only when the dry-run is `import-ready` (writes a new recovered
 *      chat + snapshot) or `already-imported` (a documented NO-OP). Default mode
 *      `import-as-new` recovers the package as a BRAND-NEW chat + snapshot with a
 *      freshly generated id and recorded provenance — it NEVER reuses the
 *      package's original chatId/snapshotId, so it is structurally incapable of
 *      overwriting existing rows. The `restore` / `relink` mode (re-linking onto
 *      the original ids) is DEFERRED — too risky for H.4.
 *
 * No-overwrite guarantee (by construction):
 *   - chats are written via store.chats.upsert with a FRESH recovered id (the
 *     id does not exist → INSERT, never UPDATE).
 *   - snapshots are written via store.snapshots.create with NO snapshotId in the
 *     patch → the store generates a fresh id → INSERT, never UPDATE.
 *   - the overwrite-by-id snapshot store primitive is NEVER called.
 *   - the package's original ids are written only into provenance metadata.
 *
 * Boundaries (H.4):
 *   - Desktop/Tauri only. On Chrome the stores + inspector are absent, so the
 *     card is disabled with an "available in Desktop Studio only" message.
 *   - Writes ONLY through the Desktop store adapters (store.chats /
 *     store.snapshots). No raw SQL, no package write/overwrite, no fs write.
 *   - Reads ONLY packages already inside archive/packages (scoped path guard);
 *     reads manifest.json + snapshot.json. NEVER reads or executes chat.html.
 *   - No scanner / materializer / writer / projector / CAS change. No
 *     watcher/poller/daemon. No Chrome runtime, no sync/WebDAV/cloud/native.
 *   - Export / share of packages is NOT implemented here (deferred).
 *
 * Public API (H2O.Studio.archiveImporter):
 *   isDesktopCapable() -> boolean
 *   dryRunImportPackage({ packagePath }) -> Promise<dry-run decision>
 *   importVerifiedPackage({ packagePath, mode }) -> Promise<import result>
 *   buildTurnsFromPackageSnapshot(snapshotJson) -> [turns]   (pure)
 *   renderArchiveImporterCard(container, options)
 *   mountArchiveImporterCard(healthContainer, options)
 *
 * Contracts: release-evidence/2026-06-24/saved-chat-archive-phase-h0-recovery-import-export-contract.md
 *            release-evidence/2026-06-24/saved-chat-archive-phase-h4-verification-gated-import-recovery.md
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  if (H2O.Studio.archiveImporter && H2O.Studio.archiveImporter.__installed) return;

  var MODULE_VERSION = '0.1.0-phase-h-4';
  var APP_LOCAL_DATA = 15;                 /* Tauri BaseDirectory.AppLocalData */
  var PACKAGE_ROOT = 'archive/packages';
  var DEFAULT_MODE = 'import-as-new';
  var RECOVERED_TITLE_PREFIX = 'Recovered: ';
  var SNAPSHOT_READ_CAP = 8 * 1024 * 1024; /* snapshot.json read cap (8 MiB) */

  function detectTauri() {
    try {
      if (typeof global.__TAURI_INTERNALS__ !== 'undefined') return true;
      if (typeof global.__TAURI__ !== 'undefined') return true;
    } catch (_) { /* swallow */ }
    return false;
  }

  function cleanString(v) { return String(v == null ? '' : v).trim(); }
  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function safeObject(v) { return isObject(v) ? v : {}; }
  function asArray(v) { return Array.isArray(v) ? v : []; }
  function isFiniteNumber(v) { return typeof v === 'number' && isFinite(v); }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* The store maps the snapshots.id column to the JS key `snapshotId`
   * (store/snapshots.tauri.js column map), so a store snapshot object exposes
   * its id as `.snapshotId`. Read that (with `.id` as a defensive fallback). */
  function snapshotRowId(snap) {
    var s = safeObject(snap);
    return cleanString(s.snapshotId) || cleanString(s.id);
  }

  function getInspector() {
    var ins = H2O.Studio && H2O.Studio.archiveInspector;
    return (ins && typeof ins.inspectPackage === 'function') ? ins : null;
  }
  /* M10 P3.6b: portable packages are verified by TRUSTED NATIVE code — the same
   * semantic verifier the archive path uses. There is deliberately no fallback
   * to the legacy JS byte validator: an unavailable trusted verifier means the
   * import is refused, not decided by a weaker second opinion. */
  function getPortableVerifier() {
    var ingestion = (H2O.Studio && H2O.Studio.ingestion) || {};
    return typeof ingestion.verifySavedChatPortablePackageV1 === 'function'
      ? ingestion.verifySavedChatPortablePackageV1 : null;
  }
  function getPortableZip() {
    var ingestion = (H2O.Studio && H2O.Studio.ingestion) || {};
    var portable = ingestion.savedChatPortableZip;
    return portable && portable.__installed === true &&
      typeof portable.readPortablePackageZip === 'function' ? portable : null;
  }
  function getStores() { return (H2O.Studio && H2O.Studio.store) || {}; }
  function getSnapshotsStore() {
    var s = getStores().snapshots;
    return (s && typeof s.create === 'function' && typeof s.get === 'function'
      && typeof s.listByChat === 'function') ? s : null;
  }
  function getChatsStore() {
    var c = getStores().chats;
    return (c && typeof c.upsert === 'function' && typeof c.get === 'function') ? c : null;
  }
  function isDesktopCapable() {
    return detectTauri() && !!getInspector() && !!getSnapshotsStore() && !!getChatsStore();
  }

  function getInvoke() {
    try {
      var internals = global.__TAURI_INTERNALS__;
      if (internals && typeof internals.invoke === 'function') return internals.invoke.bind(internals);
    } catch (_) { /* ignore */ }
    try {
      var tauri = global.__TAURI__;
      if (tauri && tauri.core && typeof tauri.core.invoke === 'function') return tauri.core.invoke.bind(tauri.core);
      if (tauri && typeof tauri.invoke === 'function') return tauri.invoke.bind(tauri);
    } catch (_) { /* ignore */ }
    return null;
  }

  function joinPath() {
    var parts = [];
    for (var i = 0; i < arguments.length; i += 1) {
      var part = cleanString(arguments[i]).replace(/^\/+|\/+$/g, '');
      if (part) parts.push(part);
    }
    return parts.join('/');
  }

  function packageDirNameForPath(packagePath) {
    var p = cleanString(packagePath).replace(/[\/\\]+$/g, '');
    var idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return idx >= 0 ? p.slice(idx + 1) : p;
  }

  /* Safety scope: only operate on packages already inside archive/packages,
   * ending in .h2ochat. No arbitrary file paths. */
  function packagePathIsScoped(packagePath) {
    var p = cleanString(packagePath).replace(/[\/\\]+$/g, '');
    return p.indexOf(PACKAGE_ROOT + '/') === 0 && /\.h2ochat$/.test(packageDirNameForPath(p));
  }

  function decodeToText(value) {
    if (typeof value === 'string') return value;
    var bytes = value;
    if (value && value.data && (Array.isArray(value.data) || value.data instanceof Uint8Array)) bytes = value.data;
    try {
      var arr = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(asArray(bytes));
      if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(arr);
      var out = ''; for (var i = 0; i < arr.length; i += 1) out += String.fromCharCode(arr[i]);
      return out;
    } catch (_) { return ''; }
  }

  function bytesFor(value) {
    if (value instanceof Uint8Array) return value;
    if (value && value.data && (Array.isArray(value.data) || value.data instanceof Uint8Array)) value = value.data;
    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return new Uint8Array(value);
    if (value && typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (Array.isArray(value)) return Uint8Array.from(value);
    throw new Error('package byte input is invalid');
  }

  /* Read a package-relative text file via the existing bounded archive fs scope
   * (baseDir AppLocalData; path under archive/packages). Read-only. Used to read
   * snapshot.json (the recovery payload). Never reads chat.html. */
  function safeParseJson(text) {
    try { var v = JSON.parse(text); return isObject(v) ? v : null; } catch (_) { return null; }
  }

  /* Single governed saved-chat package codec authority (M03 T02/T03). This
   * module never implements gzip decoding, magic detection, physical/logical
   * hashing or descriptor verification; it only consumes verified logical bytes. */
  function savedChatPackageCodecV3() {
    var codec = H2O.Studio && H2O.Studio.ingestion && H2O.Studio.ingestion.savedChatPackageCodec;
    if (!codec || codec.__installed !== true ||
        typeof codec.readVerifiedPackageMember !== 'function' ||
        !isFiniteNumber(codec.LOGICAL_SNAPSHOT_CAP_BYTES)) {
      return null;
    }
    return codec;
  }

  /* ── Trusted archive-state binding ────────────────────────────────────────
   *
   * `packagePath` is an ADDRESS, never proof. Between the moment trusted
   * verification rules on a package and the moment its bytes are read, the
   * bytes at that address can change. Sourcing the expected digest, length or
   * encoding from a package file read after that ruling lets a substituted
   * package describe — and therefore validate — itself, and for import the
   * consequence is content persisted under a fresh recovered id whose
   * provenance falsely attributes it to the verified package.
   *
   * So the expectations come from the trusted archive-integrity enumeration
   * instead: the verifier's own measurements of the package it examined. The
   * package is never allowed to state what it should hash to. This module adds
   * no verification of its own — it consumes existing trusted facts and the
   * existing governed codec.
   *
   * This applies to the ARCHIVE filesystem path only. The portable ZIP path
   * verifies one in-memory contained entry set and then reads its manifest and
   * snapshot from that same immutable set, so it has no second-read window and
   * is deliberately left unchanged. */
  var CLASS_VERIFIED_GENERATION = 'verified-generation';
  var CLASS_LEGACY_PACKAGE = 'legacy-package';
  var FAMILY_V3 = 'v3';

  function getTrustedIntegrityFn() {
    var ing = (H2O.Studio && H2O.Studio.ingestion) || {};
    return (typeof ing.readSavedChatArchiveIntegrityV1 === 'function')
      ? ing.readSavedChatArchiveIntegrityV1 : null;
  }
  function getPartitionFn() {
    var mapping = (H2O.Studio && H2O.Studio.archiveHealthMapping) || null;
    return (mapping && typeof mapping.partitionOccupants === 'function')
      ? mapping.partitionOccupants : null;
  }

  /* Representation normalization only; nothing is recomputed. */
  function bareHash(value) {
    var text = cleanString(value).toLowerCase();
    return text.indexOf('sha256-') === 0 ? text.slice(7) : text;
  }

  function trustedOccupantFor(packagePath) {
    var readIntegrity = getTrustedIntegrityFn();
    var partition = getPartitionFn();
    if (!readIntegrity || !partition) return Promise.resolve(null);
    return Promise.resolve()
      .then(function () { return readIntegrity(); })
      .then(function (envelope) {
        var occupants = asArray(safeObject(partition(safeObject(envelope).occupants)).packageOccupants);
        for (var i = 0; i < occupants.length; i += 1) {
          var occupant = safeObject(occupants[i]);
          if (cleanString(occupant.path) !== packagePath) continue;
          var klass = cleanString(occupant.class);
          if (klass !== CLASS_VERIFIED_GENERATION && klass !== CLASS_LEGACY_PACKAGE) return null;
          return occupant;
        }
        return null;
      }, function () { return null; });
  }

  /* STRICT: both sides are trusted output, so a missing identity is a failure
   * to bind. Two empty values must never compare equal. */
  function trustedStateMatches(inspection, occupant) {
    var inspected = bareHash(safeObject(safeObject(inspection).identity).contentHash);
    var enumerated = bareHash(safeObject(occupant).contentHash);
    if (!inspected || !enumerated) return false;
    return inspected === enumerated;
  }

  /* Complete-or-null: a partial anchor set is a set of checks that would
   * silently not happen. */
  function trustedMemberAnchors(occupant) {
    var o = safeObject(occupant);
    var encoding = cleanString(o.snapshotEncoding);
    var physicalSha = cleanString(o.snapshotPhysicalSha256);
    var logicalSha = cleanString(o.logicalSnapshotSha256);
    var physicalLength = o.snapshotPhysicalByteLength;
    var logicalLength = o.logicalSnapshotByteLength;
    var family = cleanString(o.constructionFamily);
    if (!family || !encoding || !physicalSha || !logicalSha) return null;
    if (!isFiniteNumber(physicalLength) || physicalLength < 0) return null;
    if (!isFiniteNumber(logicalLength) || logicalLength < 0) return null;
    return {
      family: family,
      encoding: encoding,
      physicalSha256: physicalSha,
      physicalByteLength: physicalLength,
      logicalSha256: logicalSha,
      logicalByteLength: logicalLength,
    };
  }

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

  /* Read the ARCHIVE-path snapshot BOUND to the trusted package state.
   *
   * The read regime is chosen by the TRUSTED construction family, never by
   * anything the package says about itself, so a package trusted as v3 can
   * never fall through to the weaker plain read by claiming otherwise. v3 goes
   * through the governed verified-member path against the trusted descriptor;
   * v1/v2 compare the bounded reader's own returned physical digest AND length
   * against the trusted measurements before a single byte is parsed.
   *
   * Every failure yields null, which the existing callers already treat as a
   * hard refusal — no new policy state is introduced. */
  function readBoundPackageSnapshotJson(packagePath, inspection) {
    var codec = savedChatPackageCodecV3();
    if (!codec || typeof codec.readBoundedPackageMemberBytes !== 'function') return Promise.resolve(null);
    return trustedOccupantFor(packagePath).then(function (occupant) {
      if (!occupant || !trustedStateMatches(inspection, occupant)) return null;
      var anchors = trustedMemberAnchors(occupant);
      if (!anchors) return null;
      var cap = codec.LOGICAL_SNAPSHOT_CAP_BYTES;
      if (anchors.family === FAMILY_V3) {
        return Promise.resolve(codec.readVerifiedPackageMember({
          packagePath: packagePath,
          descriptor: trustedSnapshotDescriptor(anchors),
          expectedPath: 'snapshot.json',
          physicalByteCap: cap,
          logicalByteCap: cap,
        })).then(function (verified) {
          return safeParseJson(decodeToText(safeObject(verified).logicalBytes));
        }, function () { return null; });
      }
      return Promise.resolve(codec.readBoundedPackageMemberBytes({
        packagePath: packagePath,
        memberPath: 'snapshot.json',
        physicalByteCap: cap,
      })).then(function (bounded) {
        var read = safeObject(bounded);
        if (bareHash(read.physicalSha256) !== bareHash(anchors.physicalSha256)) return null;
        if (read.physicalByteLength !== anchors.physicalByteLength) return null;
        return safeParseJson(decodeToText(read.storedBytes));
      }, function () { return null; });
    }, function () { return null; });
  }

  async function readPackageSnapshotJsonFromBytes(manifestInput, storedInput) {
    var manifest = safeObject(manifestInput);
    var storedBytes = bytesFor(storedInput);
    var descriptor = safeObject(safeObject(manifest.files).snapshot);
    if (manifest.schemaVersion === 3) {
      var codec = savedChatPackageCodecV3();
      if (!codec) throw new Error('governed saved-chat package codec unavailable');
      var verified = await codec.verifyPackageMemberBytes({
        storedBytes: storedBytes,
        descriptor: descriptor,
        expectedPath: 'snapshot.json',
        physicalByteCap: codec.LOGICAL_SNAPSHOT_CAP_BYTES,
        logicalByteCap: codec.LOGICAL_SNAPSHOT_CAP_BYTES,
      });
      return safeParseJson(decodeToText(safeObject(verified).logicalBytes));
    }
    if (storedBytes.byteLength > SNAPSHOT_READ_CAP) throw new Error('snapshot.json exceeds importer read cap');
    return safeParseJson(decodeToText(storedBytes));
  }

  function firstTypedPartBody(parts, type, field) {
    var list = asArray(parts);
    for (var i = 0; i < list.length; i += 1) {
      var part = safeObject(list[i]);
      if (part.type === type && typeof part[field] === 'string') return part[field];
    }
    return '';
  }

  /* V3 typed parts are authoritative. Legacy packages retain their historical
   * scalar-text interpretation and empty outerHtml, even when they also carry
   * typed parts, so this migration does not change v1/v2 recovery semantics. */
  function packageMessageBodies(snapshot, message) {
    var snap = safeObject(snapshot);
    var msg = safeObject(message);
    if (snap.schemaVersion === 3) {
      return {
        text: firstTypedPartBody(msg.content, 'text', 'text'),
        outerHtml: firstTypedPartBody(msg.content, 'html', 'html'),
      };
    }
    return {
      text: (typeof msg.contentText === 'string') ? msg.contentText : '',
      outerHtml: '',
    };
  }

  /* ── Pure mapping: package snapshot.json messages -> store snapshot turns ────
   * Recovery keeps canonical content parts + author/id/parentId/createdAt in
   * turn meta. V3 additionally restores exact governed typed text/HTML bodies;
   * v1/v2 keep the historical scalar-text/empty-outerHtml behavior. Shape
   * matches store.snapshots.create({ turns: [] }). */
  function buildTurnsFromPackageSnapshot(snapshotJson) {
    var snap = safeObject(snapshotJson);
    var messages = asArray(snap.messages);
    return messages.map(function (msgRaw, i) {
      var msg = safeObject(msgRaw);
      var turnIdx = isFiniteNumber(msg.turnIndex) ? Math.floor(msg.turnIndex) : i;
      var role = cleanString(msg.role) || cleanString(msg.author) || 'assistant';
      var bodies = packageMessageBodies(snap, msg);
      var meta = {};
      if (msg.id != null) meta.sourceMessageId = cleanString(msg.id);
      if (msg.parentId != null) meta.parentId = cleanString(msg.parentId);
      if (msg.author != null) meta.author = cleanString(msg.author);
      if (msg.createdAt != null) meta.createdAt = cleanString(msg.createdAt);
      if (msg.content != null) meta.content = msg.content;       /* portable content parts */
      if (Array.isArray(msg.assetRefs) && msg.assetRefs.length) meta.assetRefs = msg.assetRefs;
      if (isObject(msg.metadata)) meta.messageMetadata = msg.metadata;
      return { turnIdx: turnIdx, role: role, text: bodies.text, outerHtml: bodies.outerHtml, meta: meta };
    });
  }

  function packageIdentity(inspection, snapshotJson) {
    var ins = safeObject(inspection);
    var id = safeObject(ins.identity);
    var snap = safeObject(snapshotJson);
    return {
      chatId: cleanString(id.chatId) || cleanString(snap.chatId),
      snapshotId: cleanString(id.snapshotId) || cleanString(snap.snapshotId),
      title: cleanString(snap.title) || cleanString(id.title),
      contentHash: cleanString(id.contentHash),
      /* M05 §D — the EXACT generation this operation is bound to. `contentHash`
       * is the inspector's RECOMPUTED hash, so for a `generation` package it is
       * also the generation identifier in the basename. This flow is driven by
       * an explicitly selected packagePath and must never substitute a newer
       * sibling generation, a "latest", or a BEST-HISTORICAL pick for it. */
      packageKind: cleanString(id.packageKind) || 'unusable',
      nameClassification: cleanString(id.nameClassification) || 'unclassified',
      contentHashVerified: id.contentHashVerified === true,
      manifestClaimedContentHash: cleanString(id.manifestClaimedContentHash),
      digest: cleanString(safeObject(snap.metadata).digest),
      capturedAt: cleanString(snap.capturedAt),
      messageCount: asArray(snap.messages).length || (isFiniteNumber(id.messageCount) ? id.messageCount : 0),
      schemaVersion: id.schemaVersion == null ? null : id.schemaVersion,
      payloadVersion: id.payloadVersion == null ? null : id.payloadVersion,
    };
  }

  /* Map a verification status into a non-verified dry-run decision. verified ->
   * null (continue to store-state checks).
   *
   * M10 P3.6b: `unsupported-version` is gone. No trusted fact proves it — the
   * native verifier refuses an incoherent version triple as structural
   * incoherence, which is not the same claim, so asserting it would be putting
   * words in the verifier's mouth. Every trusted refusal about the PACKAGE is
   * `corrupted`; only a failure to obtain a verdict at all is `rejected`. */
  function nonVerifiedDecision(inspectStatus) {
    var s = cleanString(inspectStatus);
    if (s === 'verified') return null;
    if (s === 'hash-mismatch' || s === 'corrupted' || s === 'incomplete'
        || s === 'unreadable' || s === 'identity-mismatch'
        || s === 'unsupported-encoding') return 'corrupted';
    return 'rejected'; /* read-error or unknown */
  }

  function dryRunResult(packagePath, decision, identity, store, reason, inspectStatus) {
    return {
      ok: decision === 'import-ready' || decision === 'already-imported',
      decision: decision,
      status: decision,
      packagePath: cleanString(packagePath) || null,
      packageDirName: packagePath ? packageDirNameForPath(packagePath) : null,
      mutated: false,
      identity: identity || { chatId: '', snapshotId: '', title: '', contentHash: '', digest: '', capturedAt: '', messageCount: 0, schemaVersion: null, payloadVersion: null },
      store: store || { snapshotExists: false, chatExists: false, digestMatches: false, existingSnapshotId: '', existingChatId: '' },
      reason: reason || '',
      inspectStatus: cleanString(inspectStatus),
    };
  }

  async function loadArchiveCandidate(packagePath) {
    var inspection = safeObject(await getInspector().inspectPackage({ packagePath: packagePath }));
    var snapshotJson = await readBoundPackageSnapshotJson(packagePath, inspection);
    return {
      sourceKind: 'archive-package',
      sourceName: packageDirNameForPath(packagePath),
      packagePath: packagePath,
      packageDirName: packageDirNameForPath(packagePath),
      inspection: inspection,
      snapshotJson: snapshotJson,
      identity: packageIdentity(inspection, snapshotJson),
    };
  }

  /* Trusted native wire carries bare lowercase hex. The importer's outward
   * identity has always exposed the prefixed form; this formats the already
   * trusted value and hashes nothing. */
  function prefixedHash(value) {
    var text = cleanString(value).toLowerCase();
    if (!text) return '';
    return text.indexOf('sha256-') === 0 ? text : 'sha256-' + text;
  }

  var SCHEMA_VERSION_BY_FAMILY = { v1: 1, v2: 2, v3: 3 };
  var PAYLOAD_VERSION_BY_FAMILY = { v1: null, v2: 2, v3: 3 };

  function portableSourceName(value) {
    var name = cleanString(value) || 'portable-saved-chat.h2ochat.zip';
    if (!/^[A-Za-z0-9._ -]+\.h2ochat\.zip$/.test(name) || name.indexOf('..') >= 0 || /[\\/]/.test(name)) {
      throw new Error('portable ZIP sourceName must be a safe .h2ochat.zip leaf');
    }
    return name;
  }

  /* Canonical container entry -> native member key. Anything outside this
   * inventory, including an `assets/` entry that is not canonically named, is
   * reported to the trusted side as an UNEXPECTED member rather than quietly
   * dropped — the verifier is what decides that such a package is refused. */
  var CANONICAL_MEMBER_BY_ENTRY = {
    'manifest.json': 'manifest',
    'snapshot.json': 'snapshot',
    'chat.md': 'markdown',
    'chat.html': 'html',
  };
  var CANONICAL_ASSET_ENTRY = /^assets\/sha256-[0-9a-f]{64}\.[a-z0-9]{1,16}$/;

  /* A portable V3 export REGENERATES chat.md / chat.html as human-readable
   * companions, and the container's governed inventory requires them. They are
   * transport artifacts of the export format, not package members: a canonical
   * V3 package carries no persistent renderer, which is exactly what the
   * trusted verifier enforces. Offering them as members would refuse every
   * legitimate portable V3 package.
   *
   * Shaping on the manifest's CLAIMED schemaVersion is safe in both directions,
   * because it can only ever make the verdict stricter:
   *   claims v3, really v1/v2 -> the verifier sees no renderers and refuses
   *                              `required-renderer-missing`;
   *   claims v1/v2, really v3 -> the renderers ARE offered and verified.
   * A lying manifest cannot use this to get a package accepted. */
  function portableVerificationInput(entries, claimedSchemaVersion) {
    var companionsAreMembers = claimedSchemaVersion !== 3;
    var members = { assets: [] };
    var unexpected = [];
    asArray(entries).forEach(function (entry) {
      var name = cleanString(entry && entry.name);
      if (!name) return;
      var canonical = CANONICAL_MEMBER_BY_ENTRY[name];
      if (canonical) {
        if (canonical === 'markdown' || canonical === 'html') {
          if (companionsAreMembers) members[canonical] = entry.bytes;
          return;
        }
        members[canonical] = entry.bytes;
        return;
      }
      if (CANONICAL_ASSET_ENTRY.test(name)) {
        members.assets.push({ key: 'asset:' + name.slice('assets/'.length), bytes: entry.bytes });
        return;
      }
      unexpected.push(name);
    });
    return { members: members, unexpectedMembers: unexpected };
  }

  /* The manifest's own CLAIM, read only to shape the member inventory above.
   * It decides no validity: the trusted verifier re-reads the manifest itself. */
  function claimedSchemaVersion(entries) {
    var entry = asArray(entries).filter(function (e) { return e && e.name === 'manifest.json'; })[0];
    var manifest = safeParseJson(decodeToText(entry && entry.bytes));
    var claimed = safeObject(manifest).schemaVersion;
    return typeof claimed === 'number' ? claimed : null;
  }

  /* A trusted refusal is a statement about the PACKAGE; only a failure to reach
   * a verdict at all is a read error. Native codes are never re-specialised
   * here — the importer does not own hash-mismatch granularity. */
  function portableStatusFor(trusted) {
    if (safeObject(trusted).verified === true) return 'verified';
    var code = cleanString(safeObject(safeObject(trusted).refusal).code);
    if (code === 'portable-session-unknown') return 'rejected';
    return 'corrupted';
  }

  async function loadPortableCandidate(zipBytes, sourceName) {
    var portable = getPortableZip();
    var verify = getPortableVerifier();
    if (!portable || !verify) throw new Error('portable ZIP or trusted portable verification unavailable');
    var contained = await portable.readPortablePackageZip(zipBytes);
    var input = portableVerificationInput(contained.entries, claimedSchemaVersion(contained.entries));

    /* TRUSTED VERIFICATION FIRST. Nothing about this package is decoded,
     * parsed or believed until native code has ruled on it — a refused package
     * must never reach the snapshot decoder. */
    var trusted = safeObject(await verify({
      packageDirName: contained.packageDirName,
      members: input.members,
      unexpectedMembers: input.unexpectedMembers,
    }));
    var status = portableStatusFor(trusted);

    var identity = {
      chatId: '', snapshotId: '', title: '', contentHash: '',
      manifestClaimedContentHash: '', contentHashVerified: false,
      schemaVersion: null, payloadVersion: null,
      nameClassification: 'unclassified', packageKind: 'unusable', messageCount: 0,
    };
    var snapshotJson = null;

    if (status === 'verified') {
      /* Only now, and only from TRUSTED identity. The snapshot is decoded via
       * the governed shared codec path; a decode failure here is an import/read
       * error, never a second semantic verdict. */
      var manifestEntry = asArray(contained.entries).filter(function (entry) {
        return entry.name === 'manifest.json';
      })[0];
      var snapshotEntry = asArray(contained.entries).filter(function (entry) {
        return entry.name === 'snapshot.json';
      })[0];
      var manifest = safeParseJson(decodeToText(manifestEntry && manifestEntry.bytes));
      snapshotJson = manifest && snapshotEntry
        ? await readPackageSnapshotJsonFromBytes(manifest, snapshotEntry.bytes) : null;

      var classification = cleanString(trusted.nameClassification) || 'unclassified';
      identity = {
        chatId: cleanString(trusted.chatId),
        snapshotId: cleanString(trusted.snapshotId),
        /* Presentation only — the title is read from the decoded snapshot and
         * is not a verification fact. */
        title: cleanString(snapshotJson && snapshotJson.title),
        /* The trusted wire is bare hex; the importer's outward identity keeps
         * the prefixed form every existing consumer already reads. */
        contentHash: prefixedHash(trusted.contentHash),
        manifestClaimedContentHash: cleanString(manifest && manifest.contentHash),
        contentHashVerified: true,
        schemaVersion: SCHEMA_VERSION_BY_FAMILY[cleanString(trusted.constructionFamily)] || null,
        payloadVersion: PAYLOAD_VERSION_BY_FAMILY[cleanString(trusted.constructionFamily)] || null,
        nameClassification: classification,
        packageKind: classification === 'generation' ? 'generation' :
          (classification === 'legacy' ? 'legacy' : 'unusable'),
        messageCount: asArray(snapshotJson && snapshotJson.messages).length,
      };
    }

    var refusalCode = cleanString(safeObject(trusted.refusal).code);
    var inspection = {
      status: status,
      identity: identity,
      blockers: refusalCode ? [{ code: refusalCode }] : [],
    };
    return {
      sourceKind: 'portable-zip',
      sourceName: portableSourceName(sourceName),
      packagePath: '',
      packageDirName: contained.packageDirName,
      inspection: inspection,
      snapshotJson: snapshotJson,
      identity: packageIdentity(inspection, snapshotJson),
    };
  }

  /* Shared non-mutating decision core. Archive paths and verified ZIP byte
   * sources both arrive here only after their respective verification adapters. */
  function dryRunCandidate(candidate) {
    var source = safeObject(candidate);
    var packagePath = cleanString(source.packagePath);
    var inspection = safeObject(source.inspection);
    var identity = safeObject(source.identity);
    var inspectStatus = cleanString(inspection.status);
    var early = nonVerifiedDecision(inspectStatus);
    if (early) {
      var refused = dryRunResult(packagePath, early, identity, null, 'inspector status: ' + inspectStatus, inspectStatus);
      refused.sourceKind = cleanString(source.sourceKind);
      refused.sourceName = cleanString(source.sourceName);
      return Promise.resolve(refused);
    }
    /* ARCHIVE PATH ONLY: the snapshot could not be bound to the trusted package
     * state, so there is nothing here that may be reported as importable.
     * Execution refuses this case too, but a dry-run that still said
     * `import-ready` would arm an operator confirmation for a package whose
     * content is unproven. Existing `rejected` vocabulary; no new decision
     * state. The portable path is untouched: it reads from one already-verified
     * in-memory entry set and has no second-read window. */
    if (cleanString(source.sourceKind) === 'archive-package' && !isObject(source.snapshotJson)) {
      var unbound = dryRunResult(packagePath, 'rejected', identity, null,
        'snapshot content could not be bound to the trusted package state', inspectStatus);
      unbound.sourceKind = cleanString(source.sourceKind);
      unbound.sourceName = cleanString(source.sourceName);
      return Promise.resolve(unbound);
    }
    var snapStore = getSnapshotsStore();
    var chatStore = getChatsStore();
    return Promise.resolve(snapStore.get(identity.snapshotId)).catch(function () { return null; })
      .then(function (existingCombined) {
        var existingSnap = safeObject(existingCombined).snapshot;
        if (existingSnap && snapshotRowId(existingSnap)) {
          var storeDigest = cleanString(existingSnap.digest) || cleanString(safeObject(existingSnap.meta).digest);
          var digestMatches = !!identity.digest && !!storeDigest && storeDigest === identity.digest;
          var sameContent = digestMatches || !identity.digest || !storeDigest;
          var store = { snapshotExists: true, chatExists: true, digestMatches: digestMatches, existingSnapshotId: snapshotRowId(existingSnap), existingChatId: cleanString(existingSnap.chatId) };
          var existing = dryRunResult(packagePath, sameContent ? 'already-imported' : 'conflict-snapshot-id', identity, store,
            sameContent ? 'snapshotId already present in store' : 'snapshotId present with a different content digest; will not overwrite', inspectStatus);
          existing.sourceKind = cleanString(source.sourceKind);
          existing.sourceName = cleanString(source.sourceName);
          return existing;
        }
        return Promise.all([
          Promise.resolve(chatStore.get(identity.chatId)).catch(function () { return null; }),
          Promise.resolve(snapStore.listByChat(identity.chatId)).catch(function () { return []; }),
        ]).then(function (pair) {
          var existingChat = pair[0];
          var snapsForChat = asArray(pair[1]);
          var chatExists = !!(existingChat && (cleanString(safeObject(existingChat).id) || cleanString(safeObject(existingChat).chatId))) || snapsForChat.length > 0;
          var store = { snapshotExists: false, chatExists: chatExists, digestMatches: false, existingSnapshotId: '', existingChatId: chatExists ? identity.chatId : '' };
          var result = dryRunResult(packagePath, chatExists ? 'conflict-chat-id' : 'import-ready', identity, store,
            chatExists ? 'chatId already present; will not modify the existing chat' : 'verified and not present in store', inspectStatus);
          result.sourceKind = cleanString(source.sourceKind);
          result.sourceName = cleanString(source.sourceName);
          return result;
        });
      });
  }

  /* ── Step 1: NON-MUTATING dry run ─────────────────────────────────────────── */
  function dryRunImportPackage(options) {
    var opts = safeObject(options);
    var packagePath = cleanString(opts.packagePath);
    if (!packagePath) return Promise.resolve(dryRunResult(null, 'rejected', null, null, 'no package path', ''));
    if (!isDesktopCapable()) return Promise.resolve(dryRunResult(packagePath, 'rejected', null, null, 'desktop-only', ''));
    if (!packagePathIsScoped(packagePath)) return Promise.resolve(dryRunResult(packagePath, 'rejected', null, null, 'path-not-scoped', ''));
    return loadArchiveCandidate(packagePath).then(dryRunCandidate).catch(function (err) {
      return dryRunResult(packagePath, 'rejected', null, null, String((err && err.message) || err || 'dry-run threw'), '');
    });
  }

  function dryRunImportZip(options) {
    var opts = safeObject(options);
    if (!isDesktopCapable() || !getPortableZip() || !getPortableVerifier()) {
      return Promise.resolve(dryRunResult(null, 'rejected', null, null, 'desktop-only or portable ZIP unavailable', ''));
    }
    return loadPortableCandidate(opts.zipBytes, opts.sourceName).then(dryRunCandidate).catch(function (err) {
      var refused = dryRunResult(null, 'rejected', null, null,
        cleanString(err && err.code) || String((err && err.message) || err || 'ZIP dry-run threw'), '');
      refused.sourceKind = 'portable-zip';
      refused.sourceName = cleanString(opts.sourceName);
      return refused;
    });
  }

  /* Fresh, collision-checked recovered chat id. NEVER derived from the package's
   * original ids, so an import can never overwrite an existing chat/snapshot. */
  function generateRecoveredChatId() {
    var rnd = '';
    try { if (global.crypto && typeof global.crypto.randomUUID === 'function') rnd = global.crypto.randomUUID(); } catch (_) { /* ignore */ }
    if (!rnd) rnd = 'r' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    return 'recovered_' + rnd;
  }
  function ensureFreshRecoveredChatId(chatStore) {
    var attempt = 0;
    function tryOnce() {
      var id = generateRecoveredChatId();
      return Promise.resolve(chatStore.get(id)).catch(function () { return null; })
        .then(function (existing) {
          if (!existing || !cleanString(safeObject(existing).id)) return id;
          attempt += 1;
          if (attempt >= 5) return null;
          return tryOnce();
        });
    }
    return tryOnce();
  }

  function importResult(packagePath, status, decision, recovered, reason) {
    return {
      ok: status === 'imported' || status === 'already-imported',
      status: status,
      decision: cleanString(decision),
      packagePath: cleanString(packagePath) || null,
      recovered: recovered || null,
      reason: reason || '',
    };
  }

  function importCandidate(candidate, dry, mode) {
    var source = safeObject(candidate);
    var packagePath = cleanString(source.packagePath);
    if (mode === 'restore' || mode === 'relink') return Promise.resolve(importResult(packagePath, 'rejected', '', null, 'restore-relink-deferred'));
    if (mode !== DEFAULT_MODE) return Promise.resolve(importResult(packagePath, 'rejected', '', null, 'unsupported-mode: ' + mode));
    var snapStore = getSnapshotsStore();
    var chatStore = getChatsStore();
    return Promise.resolve(dry).then(function (dryResult) {
      var decision = cleanString(dryResult.decision);
      /* documented safe no-op: the snapshot is already in the store. */
      if (decision === 'already-imported') {
        return importResult(packagePath, 'already-imported', decision, {
          newChatId: '', newSnapshotId: '',
          originalChatId: dryResult.identity.chatId, originalSnapshotId: dryResult.identity.snapshotId,
        }, 'snapshot already present in store; no write performed');
      }
      /* hard gate: only import-ready proceeds to a write. */
      if (decision !== 'import-ready') {
        var status = (decision === 'conflict-chat-id' || decision === 'conflict-snapshot-id') ? 'conflict' : 'rejected';
        return importResult(packagePath, status, decision, null, dryResult.reason || ('not import-ready: ' + decision));
      }
      var identity = safeObject(source.identity);
      var snapshotJson = source.snapshotJson;
      var turns = buildTurnsFromPackageSnapshot(snapshotJson);
      if (!turns.length) {
        /* no partial / empty import */
        return importResult(packagePath, 'rejected', decision, null, 'no turns to import (empty payload; refusing partial import)');
      }
      var title = cleanString(identity.title) || cleanString(safeObject(snapshotJson).title) || 'Recovered chat';
      var recoveredTitle = RECOVERED_TITLE_PREFIX + title;
      var provenance = {
        recoveredFromPackage: true,
        source: source.sourceKind === 'portable-zip' ? 'h2ochat-zip-recovery' : 'h2ochat-package-recovery',
        importer: source.sourceKind === 'portable-zip' ? 'archive-importer-m08' : 'archive-importer-h4',
        mode: DEFAULT_MODE,
        originalChatId: identity.chatId,
        originalSnapshotId: identity.snapshotId,
        contentHash: identity.contentHash,
        digest: identity.digest,
        packageDirName: cleanString(source.packageDirName),
        originalCapturedAt: identity.capturedAt,
        recoveredAt: new Date().toISOString(),
      };
      if (source.sourceKind === 'archive-package') provenance.packagePath = packagePath;
      if (source.sourceKind === 'portable-zip') provenance.portableZipName = cleanString(source.sourceName);

      return ensureFreshRecoveredChatId(chatStore).then(function (freshChatId) {
        if (!freshChatId) return importResult(packagePath, 'rejected', decision, null, 'could not allocate a fresh recovered chat id');
        /* hard no-overwrite assertion: never reuse the package's original ids. */
        if (freshChatId === identity.chatId || freshChatId === identity.snapshotId) {
          return importResult(packagePath, 'rejected', decision, null, 'refusing to reuse original id');
        }

        /* (a) recovered chat — fresh id => INSERT (never UPDATE). */
        var chatPatch = {
          chatId: freshChatId,
          title: recoveredTitle,
          isSaved: true,
          isLinked: false,
          meta: { recovered: provenance },
        };
        return Promise.resolve(chatStore.upsert(chatPatch)).then(function () {
          /* (b) recovered snapshot — NO snapshotId in the patch => the store
           * generates a fresh id => INSERT (never an update). The
           * overwrite-by-id store primitive is intentionally never used. */
          var snapPatch = {
            chatId: freshChatId,
            title: recoveredTitle,
            messageCount: turns.length,
            turns: turns,
            meta: { recovered: provenance },
          };
          return Promise.resolve(snapStore.create(snapPatch)).then(function (combined) {
            var newSnapshotId = snapshotRowId(safeObject(combined).snapshot);
            return importResult(packagePath, 'imported', decision, {
              newChatId: freshChatId,
              newSnapshotId: newSnapshotId,
              originalChatId: identity.chatId,
              originalSnapshotId: identity.snapshotId,
              messageCount: turns.length,
            }, 'recovered as a new chat + snapshot');
          });
        });
      });
    }).catch(function (err) {
      return importResult(packagePath, 'rejected', '', null, String((err && err.message) || err || 'import threw'));
    });
  }

  /* ── Step 2: EXPLICIT, verification-gated import ───────────────────────────── */
  function importVerifiedPackage(options) {
    var opts = safeObject(options);
    var packagePath = cleanString(opts.packagePath);
    var mode = cleanString(opts.mode) || DEFAULT_MODE;
    if (!packagePath) return Promise.resolve(importResult(null, 'rejected', '', null, 'no package path'));
    if (!isDesktopCapable()) return Promise.resolve(importResult(packagePath, 'rejected', '', null, 'desktop-only'));
    if (!packagePathIsScoped(packagePath)) return Promise.resolve(importResult(packagePath, 'rejected', '', null, 'path-not-scoped'));
    return dryRunImportPackage({ packagePath: packagePath }).then(function (dry) {
      if (cleanString(dry.decision) !== 'import-ready' && cleanString(dry.decision) !== 'already-imported') {
        return importCandidate({ packagePath: packagePath }, dry, mode);
      }
      /* Re-open and re-verify at the write gate; both adapters use this same
       * candidate-to-mutation core. */
      return loadArchiveCandidate(packagePath).then(function (candidate) {
        if (cleanString(candidate.inspection && candidate.inspection.status) !== 'verified') {
          return importResult(packagePath, 'rejected', cleanString(dry.decision), null, 'package no longer verified at write time');
        }
        return dryRunCandidate(candidate).then(function (writeGateDryRun) {
          return importCandidate(candidate, writeGateDryRun, mode);
        });
      });
    }).catch(function (err) {
      return importResult(packagePath, 'rejected', '', null, String((err && err.message) || err || 'import threw'));
    });
  }

  function importVerifiedZip(options) {
    var opts = safeObject(options);
    var mode = cleanString(opts.mode) || DEFAULT_MODE;
    if (!isDesktopCapable() || !getPortableZip() || !getPortableVerifier()) {
      return Promise.resolve(importResult(null, 'rejected', '', null, 'desktop-only or portable ZIP unavailable'));
    }
    return dryRunImportZip(opts).then(function (dry) {
      if (cleanString(dry.decision) !== 'import-ready' && cleanString(dry.decision) !== 'already-imported') {
        return importCandidate({}, dry, mode);
      }
      /* Re-decode and re-run the shared package verifier immediately before
       * mutation, exactly mirroring the archive-path double gate. */
      return loadPortableCandidate(opts.zipBytes, opts.sourceName).then(function (candidate) {
        if (cleanString(candidate.inspection && candidate.inspection.status) !== 'verified') {
          return importResult(null, 'rejected', cleanString(dry.decision), null, 'ZIP package no longer verified at write time');
        }
        return dryRunCandidate(candidate).then(function (writeGateDryRun) {
          return importCandidate(candidate, writeGateDryRun, mode);
        });
      });
    }).catch(function (err) {
      return importResult(null, 'rejected', '', null,
        cleanString(err && err.code) || String((err && err.message) || err || 'ZIP import threw'));
    });
  }

  /* ── UI: adjacent recovery card (Desktop-only, explicit, no global button) ── */

  var TEXT = {
    title: 'Recover Saved Chat Archive Package',
    eyebrow: 'Import / recovery · Desktop only · verification-gated',
    intro: 'Dry-run, then explicitly import a verified .h2ochat package as a NEW recovered chat + snapshot. No overwrite: existing chats/snapshots are never modified. Restore/relink onto original ids is deferred.',
    unavailable: 'This import/recovery action is available in Desktop Studio only.',
    loadButton: 'Load packages',
    loadingList: 'Loading packages…',
    noPackages: 'No saved chat packages found in the archive.',
    selectPlaceholder: 'Select a package…',
    dryRunButton: 'Dry-run',
    dryRunBusy: 'Checking…',
    importButton: 'Import (recover as new)',
    importBusy: 'Importing…',
    pickFirst: 'Load and select a package first.',
    importHint: 'Import is enabled only after a dry-run returns import-ready.',
  };

  var STATUS_PRESENTATION = {
    'verified': { tone: 'ok', label: 'Verified' },
    'import-ready': { tone: 'ok', label: 'Import-ready', note: 'Verified and not present in the store. Safe to import as a new recovered chat + snapshot.' },
    'already-imported': { tone: 'neutral', label: 'Already imported', note: 'This snapshot is already in the store. Import is a no-op; nothing is written or overwritten.' },
    'conflict-chat-id': { tone: 'warn', label: 'Conflict (chat exists)', note: 'A chat with this id already exists. The existing chat will not be modified; import is blocked.' },
    'conflict-snapshot-id': { tone: 'warn', label: 'Conflict (snapshot id)', note: 'A snapshot with this id exists with different content. It will not be overwritten; import is blocked.' },
    'conflict': { tone: 'warn', label: 'Conflict', note: 'Existing state conflicts with this package. Nothing was modified.' },
    'corrupted': { tone: 'block', label: 'Corrupted', note: 'The package failed verification. It is not safe to import.' },
    'imported': { tone: 'ok', label: 'Imported', note: 'Recovered as a NEW chat + snapshot with provenance. No existing row was overwritten.' },
    'rejected': { tone: 'block', label: 'Rejected', note: 'Import was refused.' },
  };

  var PILL_TONES = {
    ok: 'background:rgba(46,160,67,.18);color:#3fb950;border:1px solid rgba(46,160,67,.35)',
    warn: 'background:rgba(210,153,34,.18);color:#d29922;border:1px solid rgba(210,153,34,.35)',
    block: 'background:rgba(248,81,73,.16);color:#f85149;border:1px solid rgba(248,81,73,.35)',
    neutral: 'background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.14)',
  };

  function pillHtml(label, tone) {
    var style = PILL_TONES[tone] || PILL_TONES.neutral;
    return '<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;' + style + '">' + escapeHtml(label) + '</span>';
  }

  function listPackagesViaInspector() {
    var ins = getInspector();
    if (!ins || typeof ins.listPackages !== 'function') return Promise.resolve([]);
    return Promise.resolve(ins.listPackages({})).then(function (rows) { return asArray(rows); }, function () { return []; });
  }

  function renderArchiveImporterCard(container, options) {
    if (!container || typeof container !== 'object') return null;
    if (typeof document === 'undefined') return null;
    var opts = options || {};
    var dryRun = (typeof opts.dryRunImportPackage === 'function') ? opts.dryRunImportPackage : dryRunImportPackage;
    var doImport = (typeof opts.importVerifiedPackage === 'function') ? opts.importVerifiedPackage : importVerifiedPackage;
    var listFn = (typeof opts.listPackages === 'function') ? opts.listPackages : listPackagesViaInspector;
    var desktop = (typeof opts.isDesktop === 'boolean') ? opts.isDesktop : isDesktopCapable();

    var card = {
      desktop: desktop, busy: false, listBusy: false, listLoaded: false,
      options: [], packagePath: '', lastDry: null, lastImport: null,
    };

    function canImport() {
      return !!card.lastDry && card.lastDry.packagePath === card.packagePath
        && (card.lastDry.decision === 'import-ready' || card.lastDry.decision === 'already-imported');
    }

    function syncPathFromSelect() {
      var sel = container.querySelector('[data-archive-importer-select="1"]');
      if (sel && typeof sel.value === 'string') card.packagePath = sel.value.trim();
    }

    function optionsHtml() {
      if (!card.desktop) return '';
      var rows = asArray(card.options);
      var hint = '';
      if (card.listBusy) hint = '<div style="opacity:.6;font-size:12px;margin-top:6px">' + escapeHtml(TEXT.loadingList) + '</div>';
      else if (card.listLoaded && !rows.length) hint = '<div style="opacity:.6;font-size:12px;margin-top:6px">' + escapeHtml(TEXT.noPackages) + '</div>';
      var select = '';
      if (rows.length) {
        select = '<select data-archive-importer-select="1" style="margin-top:6px;width:100%;padding:7px;border-radius:6px;background:rgba(0,0,0,.18);border:1px solid rgba(255,255,255,.14);color:inherit;font:inherit">'
          + '<option value="">' + escapeHtml(TEXT.selectPlaceholder) + '</option>';
        rows.forEach(function (row) {
          var r = safeObject(row);
          var label = cleanString(r.packageDirName) + (cleanString(r.status) ? '  [' + cleanString(r.status) + ']' : '');
          select += '<option value="' + escapeHtml(cleanString(r.packagePath)) + '"' + (cleanString(r.packagePath) === card.packagePath ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
        });
        select += '</select>';
      }
      return hint + select;
    }

    function identityRow(key, value) {
      if (!cleanString(value)) return '';
      return '<div style="display:flex;gap:8px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;word-break:break-all;user-select:text">'
        + '<span style="opacity:.55;min-width:120px">' + escapeHtml(key) + '</span><span>' + escapeHtml(value) + '</span></div>';
    }

    function decisionBlockHtml(result, kind) {
      if (!result) return '';
      var status = cleanString(result.status) || cleanString(result.decision);
      var preset = STATUS_PRESENTATION[status] || { tone: 'neutral', label: status, note: '' };
      var id = safeObject(result.identity);
      var rec = safeObject(result.recovered);
      var idHtml = ''
        + identityRow('package', result.packageDirName || packageDirNameForPath(result.packagePath))
        + identityRow('chatId', id.chatId || rec.originalChatId)
        + identityRow('snapshotId', id.snapshotId || rec.originalSnapshotId)
        + identityRow('title', id.title)
        + identityRow('contentHash', id.contentHash)
        + identityRow('recovered chatId', rec.newChatId)
        + identityRow('recovered snapshotId', rec.newSnapshotId);
      return '<div data-archive-importer-' + kind + '="1" data-archive-importer-status="' + escapeHtml(status) + '" style="margin-top:10px;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:10px;background:rgba(255,255,255,.025)">'
        + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' + pillHtml(preset.label, preset.tone) + '<span style="opacity:.6;font-size:12px">' + escapeHtml(kind === 'dry' ? 'dry-run' : 'import') + ' · ' + escapeHtml(status) + '</span></div>'
        + (preset.note ? '<div style="opacity:.78;font-size:12px;margin-top:5px">' + escapeHtml(preset.note) + '</div>' : '')
        + (cleanString(result.reason) ? '<div style="opacity:.6;font-size:11px;margin-top:4px">' + escapeHtml(result.reason) + '</div>' : '')
        + '<div style="margin-top:8px;display:flex;flex-direction:column;gap:4px">' + idHtml + '</div>'
        + '</div>';
    }

    function render() {
      var disabledLoad = (!card.desktop || card.listBusy || card.busy) ? ' disabled' : '';
      var disabledDry = (!card.desktop || card.busy || card.listBusy) ? ' disabled' : '';
      var importEnabled = card.desktop && !card.busy && !card.listBusy && canImport();
      var disabledImport = importEnabled ? '' : ' disabled';
      var loadStyle = 'padding:8px 14px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);color:inherit;font:inherit;' + (disabledLoad ? 'opacity:.5;cursor:default;' : '');
      var dryStyle = 'padding:8px 14px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);color:inherit;font:inherit;' + (disabledDry ? 'opacity:.5;cursor:default;' : '');
      var importStyle = 'padding:8px 14px;border-radius:6px;cursor:pointer;background:rgba(46,160,67,.16);border:1px solid rgba(46,160,67,.4);color:inherit;font:inherit;' + (importEnabled ? '' : 'opacity:.45;cursor:default;');
      var bodyHtml;
      if (!card.desktop) {
        bodyHtml = '<div style="opacity:.7;font-size:12px;margin-top:8px">' + escapeHtml(TEXT.unavailable) + '</div>';
      } else {
        bodyHtml = ''
          + optionsHtml()
          + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px">'
          + '<button type="button" data-archive-importer-dry="1" style="' + dryStyle + '"' + disabledDry + '>' + escapeHtml(card.busy === 'dry' ? TEXT.dryRunBusy : TEXT.dryRunButton) + '</button>'
          + '<button type="button" data-archive-importer-import="1" style="' + importStyle + '"' + disabledImport + '>' + escapeHtml(card.busy === 'import' ? TEXT.importBusy : TEXT.importButton) + '</button>'
          + '<button type="button" data-archive-importer-load="1" style="' + loadStyle + '"' + disabledLoad + '>' + escapeHtml(TEXT.loadButton) + '</button>'
          + '</div>'
          + '<div style="opacity:.55;font-size:11px;margin-top:6px">' + escapeHtml(TEXT.importHint) + '</div>'
          + decisionBlockHtml(card.lastDry, 'dry')
          + decisionBlockHtml(card.lastImport, 'import');
      }
      container.innerHTML = ''
        + '<section data-archive-importer-card="1" style="border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:12px;background:rgba(255,255,255,.02)">'
        + '<div style="font-size:11px;letter-spacing:.04em;text-transform:uppercase;opacity:.6">' + escapeHtml(TEXT.eyebrow) + '</div>'
        + '<div style="font-weight:600;margin-top:2px">' + escapeHtml(TEXT.title) + '</div>'
        + '<div style="opacity:.7;font-size:12px;margin-top:4px">' + escapeHtml(TEXT.intro) + '</div>'
        + bodyHtml
        + '</section>';

      var dryBtn = container.querySelector('[data-archive-importer-dry="1"]');
      if (dryBtn && card.desktop && !card.busy && !card.listBusy) dryBtn.addEventListener('click', doDryRun, { once: true });
      var importBtn = container.querySelector('[data-archive-importer-import="1"]');
      if (importBtn && importEnabled) importBtn.addEventListener('click', doImportClick, { once: true });
      var loadBtn = container.querySelector('[data-archive-importer-load="1"]');
      if (loadBtn && card.desktop && !card.listBusy && !card.busy) loadBtn.addEventListener('click', doLoad, { once: true });
      var sel = container.querySelector('[data-archive-importer-select="1"]');
      if (sel) sel.addEventListener('change', function (ev) {
        var t = ev && ev.target;
        card.packagePath = (t && typeof t.value === 'string') ? t.value.trim() : '';
        card.lastDry = null; card.lastImport = null; /* selecting a new package clears the gate */
        render();
      });
    }

    function doLoad() {
      if (card.listBusy || card.busy || !card.desktop) return;
      card.listBusy = true; render();
      Promise.resolve(listFn({})).then(function (rows) {
        card.listBusy = false; card.listLoaded = true; card.options = asArray(rows); render();
      }, function () { card.listBusy = false; card.listLoaded = true; card.options = []; render(); });
    }

    function doDryRun() {
      if (card.busy || !card.desktop) return;
      syncPathFromSelect();
      if (!card.packagePath) { card.lastDry = dryRunResult(null, 'rejected', null, null, 'select a package first', ''); render(); return; }
      card.busy = 'dry'; card.lastDry = null; card.lastImport = null; render();
      Promise.resolve(dryRun({ packagePath: card.packagePath })).then(function (res) {
        card.busy = false; card.lastDry = (res && typeof res === 'object') ? res : dryRunResult(card.packagePath, 'rejected', null, null, 'no result', ''); render();
      }, function (err) {
        card.busy = false; card.lastDry = dryRunResult(card.packagePath, 'rejected', null, null, String((err && err.message) || err || 'dry-run threw'), ''); render();
      });
    }

    function doImportClick() {
      if (card.busy || !card.desktop || !canImport()) return;
      syncPathFromSelect();
      card.busy = 'import'; card.lastImport = null; render();
      Promise.resolve(doImport({ packagePath: card.packagePath, mode: DEFAULT_MODE })).then(function (res) {
        card.busy = false; card.lastImport = (res && typeof res === 'object') ? res : importResult(card.packagePath, 'rejected', '', null, 'no result'); render();
      }, function (err) {
        card.busy = false; card.lastImport = importResult(card.packagePath, 'rejected', '', null, String((err && err.message) || err || 'import threw')); render();
      });
    }

    render();
    return { getState: function () { return card; }, dryRun: doDryRun, doImport: doImportClick, load: doLoad };
  }

  /* Mount the importer card as a SIBLING below the read-only Archive Health /
   * Inspector cards, so health re-renders never wipe it. Idempotent. */
  function mountArchiveImporterCard(healthContainer, options) {
    if (typeof document === 'undefined') return null;
    if (!healthContainer || typeof healthContainer !== 'object') return null;
    var parent = healthContainer.parentNode;
    if (!parent || typeof parent.insertBefore !== 'function') return null;
    var box = (typeof parent.querySelector === 'function') ? parent.querySelector('[data-archive-importer-mount="1"]') : null;
    if (!box) {
      box = document.createElement('div');
      box.setAttribute('data-archive-importer-mount', '1');
      box.style.marginTop = '12px';
      parent.appendChild(box);
    }
    return renderArchiveImporterCard(box, options || {});
  }

  H2O.Studio.archiveImporter = {
    __installed: true,
    __version: MODULE_VERSION,
    detectTauri: detectTauri,
    isDesktopCapable: isDesktopCapable,
    dryRunImportPackage: dryRunImportPackage,
    importVerifiedPackage: importVerifiedPackage,
    dryRunImportZip: dryRunImportZip,
    importVerifiedZip: importVerifiedZip,
    buildTurnsFromPackageSnapshot: buildTurnsFromPackageSnapshot,
    renderArchiveImporterCard: renderArchiveImporterCard,
    mountArchiveImporterCard: mountArchiveImporterCard,
  };
})(typeof window !== 'undefined' ? window : globalThis);
