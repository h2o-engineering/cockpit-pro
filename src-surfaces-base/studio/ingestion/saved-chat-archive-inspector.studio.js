/* H2O Studio — Saved Chat Archive Inspector (Desktop, Phase H.2)
 *
 * Chat Saving Architecture Phase H.2. A focused, Desktop-only, READ-ONLY package
 * inspector card, mounted adjacent to the read-only Archive Health diagnostics
 * card. It lets a human select one already-written `.h2ochat` package from the
 * known archive/packages directory and verify it:
 *   - M10 P3.5a: package validity now comes from the TRUSTED Rust authority via
 *     H2O.Studio.ingestion.readSavedChatArchiveIntegrityV1(), with the canonical
 *     occupant partition shared from archiveHealthMapping. The legacy JavaScript
 *     archive verifier is no longer consulted, and there is no fallback to it,
 *   - reads manifest.json (identity) and chat.md (title + a short, ESCAPED text
 *     preview) read-only via the existing bounded archive fs scope. These reads
 *     are PREVIEW ONLY and never decide package validity,
 *   - maps the trusted verdict to a granular status:
 *     verified / incomplete / unreadable / identity-mismatch / hash-mismatch /
 *     unsupported-encoding / corrupted / read-error.
 *
 * Boundaries (H.2 — read-only):
 *   - Desktop/Tauri only. On Chrome the diagnostics API is absent, so the card is
 *     disabled with an "available in Desktop Studio only" message.
 *   - READ-ONLY. No snapshots.create / upsert, no DB insert/update, no package
 *     write/overwrite, no import. It only reads package files + reuses the
 *     read-only validator.
 *   - It inspects ONLY packages already inside archive/packages (scoped path
 *     guard); no arbitrary file paths, no new capability.
 *   - It reads chat.md (markdown text) for the preview and renders it ESCAPED. It
 *     NEVER reads or injects chat.html, never executes package HTML.
 *   - No scanner / materializer / writer call. No watcher/poller/daemon. No
 *     Chrome runtime, no sync/WebDAV/cloud/native messaging.
 *
 * Public API (H2O.Studio.archiveInspector):
 *   isDesktopCapable() -> boolean
 *   listPackages() -> Promise<[{ packagePath, packageDirName, status }]>
 *   inspectPackage({ packagePath }) -> Promise<inspection result>
 *   renderArchiveInspectorCard(container, options)
 *   mountArchiveInspectorCard(healthContainer, options)
 *
 * Contracts: release-evidence/2026-06-24/saved-chat-archive-phase-h0-recovery-import-export-contract.md
 *            release-evidence/2026-06-24/saved-chat-archive-phase-h1-recovery-import-export-validator.md
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  if (H2O.Studio.archiveInspector && H2O.Studio.archiveInspector.__installed) return;

  var MODULE_VERSION = '0.1.0-phase-h-2';
  var APP_LOCAL_DATA = 15;                 /* Tauri BaseDirectory.AppLocalData */
  var PACKAGE_ROOT = 'archive/packages';
  var SUPPORTED_SCHEMA_VERSIONS = [1, 2, 3];
  var PREVIEW_MAX_CHARS = 600;
  var MARKDOWN_READ_CAP = 64 * 1024;       /* preview read cap */

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

  function getIngestion() { return (H2O.Studio && H2O.Studio.ingestion) || {}; }
  /* M10 P3.5a: archive package truth comes from the trusted Rust authority.
   * The Inspector reads the trusted envelope DIRECTLY — not through the Archive
   * Health facade — because it needs per-package facts, not Health aggregation.
   * There is no fallback to the legacy archive verifier. */
  function getTrustedIntegrityFn() {
    var ing = getIngestion();
    return (typeof ing.readSavedChatArchiveIntegrityV1 === 'function')
      ? ing.readSavedChatArchiveIntegrityV1 : null;
  }
  function getPartitionFn() {
    var mapping = (H2O.Studio && H2O.Studio.archiveHealthMapping) || null;
    return (mapping && typeof mapping.partitionOccupants === 'function')
      ? mapping.partitionOccupants : null;
  }
  /* The canonical version triple, from the trusted construction family. */
  var SCHEMA_VERSION_BY_FAMILY = { v1: 1, v2: 2, v3: 3 };
  var PAYLOAD_VERSION_BY_FAMILY = { v1: null, v2: 2, v3: 3 };
  /* PRESENTATION ONLY. The trusted occupant carries the contentHash as bare
   * canonical hex; every outward Inspector consumer (exporter, relink's
   * expectedDigest comparison, the export/share contract) has always read the
   * `sha256-` prefixed form. This formats the already-trusted value and does not
   * hash, re-hash, canonicalize or compare anything — trusted Rust remains the
   * sole contentHash authority. */
  function prefixedHash(value) {
    var text = cleanString(value).toLowerCase();
    if (!text) return '';
    return text.indexOf('sha256-') === 0 ? text : 'sha256-' + text;
  }
  function isDesktopCapable() {
    return detectTauri() && !!getTrustedIntegrityFn() && !!getPartitionFn();
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

  /* Safety scope: only inspect packages already inside archive/packages, ending
   * in .h2ochat. No arbitrary file paths. */
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

  /* Read a package-relative text file via the existing bounded archive fs scope
   * (baseDir AppLocalData; path under archive/packages). Read-only. */
  function readPackageTextFile(packagePath, leaf) {
    var invoke = getInvoke();
    if (!invoke) return Promise.reject(new Error('tauri invoke unavailable for fs read_file'));
    if (!packagePathIsScoped(packagePath)) return Promise.reject(new Error('package path not scoped to ' + PACKAGE_ROOT));
    var rel = joinPath(packagePath, leaf);
    return Promise.resolve(invoke('plugin:fs|read_file', { path: rel, options: { baseDir: APP_LOCAL_DATA } }))
      .then(decodeToText);
  }

  function safeParseJson(text) {
    try { var v = JSON.parse(text); return isObject(v) ? v : null; } catch (_) { return null; }
  }

  var TEXT = {
    title: 'Inspect Saved Chat Archive Package',
    eyebrow: 'Read-only inspector · Desktop only',
    intro: 'Verify and preview a saved chat package (.h2ochat) from the Desktop archive. Read-only: it never imports, writes, or overwrites packages or the store.',
    unavailable: 'This read-only inspector is available in Desktop Studio only.',
    loadButton: 'Load packages',
    loadingList: 'Loading packages…',
    noPackages: 'No saved chat packages found in the archive.',
    selectPlaceholder: 'Select a package to inspect…',
    inspectButton: 'Inspect package',
    busy: 'Inspecting…',
    pickFirst: 'Load and select a package first.',
  };

  /* M10 P3.5a final taxonomy. Every label below a verified package is derived
   * from TRUSTED Rust classification, so each renders as a problem rather than a
   * benign warning — `unsupported-encoding` moved from warn to block for exactly
   * that reason. `missing-files` and `unsupported-version` are RETIRED: the
   * canonical Partial reason means missing OR unreadable required members, and a
   * version-triple refusal is a trusted integrity refusal, not a support gap. */
  var STATUS_PRESENTATION = {
    'verified': { tone: 'ok', label: 'Verified', note: 'Trusted verification accepted this package: its stored bytes match the identity it is stored under.' },
    'corrupted': { tone: 'block', label: 'Corrupted', note: 'Trusted verification refused this package. It is not safe to import.' },
    'incomplete': { tone: 'block', label: 'Incomplete', note: 'A required member of this package is missing or could not be read, so it could not be verified.' },
    'unreadable': { tone: 'block', label: 'Unreadable', note: 'Trusted verification could not read this package at all.' },
    'identity-mismatch': { tone: 'block', label: 'Identity mismatch', note: 'The package verified, but its proven identity disagrees with the name it is stored under.' },
    'hash-mismatch': { tone: 'block', label: 'Hash mismatch', note: 'A recomputed hash does not match the identity recorded for this package. The content does not verify.' },
    'unsupported-encoding': { tone: 'block', label: 'Unsupported encoding', note: 'The package declares a snapshot encoding this format does not admit.' },
    'read-error': { tone: 'neutral', label: 'Read error', note: 'The package could not be read, is outside the archive packages directory, or trusted integrity was unavailable.' },
  };

  var PILL_TONES = {
    ok: 'background:rgba(46,160,67,.18);color:#3fb950;border:1px solid rgba(46,160,67,.35)',
    warn: 'background:rgba(210,153,34,.18);color:#d29922;border:1px solid rgba(210,153,34,.35)',
    block: 'background:rgba(248,81,73,.16);color:#f85149;border:1px solid rgba(248,81,73,.35)',
    neutral: 'background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.14)',
  };

  function isVersionSupported(schemaVersion, payloadVersion) {
    var sv = isFiniteNumber(schemaVersion) ? schemaVersion : (schemaVersion == null ? 1 : Number(schemaVersion));
    if (SUPPORTED_SCHEMA_VERSIONS.indexOf(sv) === -1) return false;
    if (sv === 1) return payloadVersion == null;
    var pv = isFiniteNumber(payloadVersion) ? payloadVersion : Number(payloadVersion);
    return (sv === 2 && pv === 2) || (sv === 3 && pv === 3);
  }

  function blockerCodes(diag) {
    return asArray(diag && diag.blockers).map(function (b) { return cleanString(b && b.code); }).filter(Boolean);
  }

  /* The EXACT trusted blocker codes that mean "a recomputed hash disagreed".
   * Exact membership only — a `/sha|hash/i` heuristic would invent causality
   * from codes that merely mention a hash. */
  var HASH_MISMATCH_CODES = [
    'generation-content-hash-mismatch',
    'generation-member-sha-mismatch',
    'generation-asset-sha-mismatch',
    'generation-v3-gzip-decoded-sha-mismatch',
    'generation-v3-identity-logical-sha-mismatch',
  ];
  var ENCODING_INVALID_CODE = 'generation-v3-snapshot-encoding-invalid';

  /* Pure: map ONE trusted occupant (plus a local read error) into the
   * inspector's presentation vocabulary. Deterministic and total.
   *
   * INTERNAL. The trusted archive path is the only caller, and the symbol is
   * deliberately not exported. P3.5.6B kept a public legacy-diagnostic mapper
   * beside it as temporary M08 compatibility; P3.6b migrated portable import to
   * trusted native verification, so that bridge is gone and this is the only
   * mapper the Inspector has.
   *
   * Package validity is decided entirely by trusted Rust; this only chooses how
   * to name the trusted verdict. It never derives causality the trusted facts do
   * not support, which is why the canonical `Partial` reason becomes
   * `incomplete` rather than `missing-files`, and why a version-triple refusal
   * falls through to `corrupted` rather than claiming an unsupported version. */
  function mapTrustedInspectStatus(occupant, readError) {
    if (readError) return 'read-error';
    var o = safeObject(occupant);
    var klass = cleanString(o.class);
    if (klass === 'verified-generation' || klass === 'legacy-package') return 'verified';
    if (klass !== 'indeterminate') return 'read-error';

    var reason = cleanString(o.reason);
    if (reason === 'partial') return 'incomplete';
    if (reason === 'unreadable') return 'unreadable';
    if (reason === 'identity-mismatch') return 'identity-mismatch';

    var codes = blockerCodes(o);
    for (var i = 0; i < codes.length; i += 1) {
      if (HASH_MISMATCH_CODES.indexOf(codes[i]) >= 0) return 'hash-mismatch';
      if (codes[i] === ENCODING_INVALID_CODE) return 'unsupported-encoding';
    }
    /* Everything else the trusted authority refused: corrupt without a granular
     * blocker, an unexpected outcome, an incoherent version triple, or an
     * admission-adapter refusal that carries no granular code. */
    return 'corrupted';
  }

  function titleFromMarkdown(md) {
    var m = /^[ \t]*#\s+(.+)$/m.exec(String(md || ''));
    return m ? cleanString(m[1]) : '';
  }

  function previewFromMarkdown(md) {
    var text = String(md || '').replace(/\r/g, '');
    /* drop the leading "# title" heading line for the body preview */
    text = text.replace(/^[ \t]*#\s+.+\n+/, '');
    text = text.slice(0, PREVIEW_MAX_CHARS).trim();
    return text;
  }

  /* Read-only: list packages already in the archive (reuses the diagnostics
   * inventory). Returns [{ packagePath, packageDirName, status }]. */
  function listPackages() {
    var readFn = getTrustedIntegrityFn();
    var partition = getPartitionFn();
    if (!detectTauri() || !readFn || !partition) return Promise.resolve([]);
    return Promise.resolve()
      .then(function () { return readFn(); })
      .then(function (envelope) {
        /* Reserved infrastructure and non-package strays are excluded by the
         * canonical partition; the Inspector never re-implements it. */
        var occupants = asArray(partition(safeObject(envelope).occupants).packageOccupants);
        return occupants.map(function (occupant) {
          var o = safeObject(occupant);
          var packagePath = cleanString(o.path);
          return {
            packagePath: packagePath,
            packageDirName: cleanString(o.name) || packageDirNameForPath(packagePath),
            status: mapTrustedInspectStatus(o, null),
          };
        }).filter(function (o) { return !!o.packagePath && packagePathIsScoped(o.packagePath); });
      })
      .catch(function () { return []; });
  }

  function emptyInspection(packagePath, status, error) {
    return {
      ok: false,
      status: status,
      packagePath: cleanString(packagePath) || null,
      packageDirName: packagePath ? packageDirNameForPath(packagePath) : null,
      identity: { chatId: '', snapshotId: '', title: '', contentHash: '', schemaVersion: null, payloadVersion: null, generatedAt: '', messageCount: null },
      checks: { manifestPresent: false, snapshotPresent: false, markdownPresent: false, htmlPresent: false, assetsDirPresent: false, contentHashOk: false, hashMismatchCount: 0, supportedVersion: false },
      preview: '',
      blockers: [],
      error: error || null,
    };
  }

  /* Read-only inspection of ONE scoped package. Reuses the validator for the
   * authoritative checks; reads manifest.json + chat.md (escaped preview) for
   * display. Never reads chat.html, never writes anything. */
  function inspectPackage(options) {
    var opts = safeObject(options);
    var packagePath = cleanString(opts.packagePath);
    if (!packagePath) return Promise.resolve(emptyInspection(null, 'read-error', 'no package path'));
    if (!isDesktopCapable()) return Promise.resolve(emptyInspection(packagePath, 'read-error', 'desktop-only'));
    if (!packagePathIsScoped(packagePath)) return Promise.resolve(emptyInspection(packagePath, 'read-error', 'path-not-scoped'));
    var readFn = getTrustedIntegrityFn();
    var partition = getPartitionFn();
    if (!readFn || !partition) return Promise.resolve(emptyInspection(packagePath, 'read-error', 'trusted archive integrity unavailable'));

    var occupant = null;
    var envelopeComplete = null;
    var manifest = null;
    var markdown = '';
    var readError = null;

    return Promise.resolve()
      .then(function () { return readFn(); })
      .then(function (envelope) {
        var env = safeObject(envelope);
        envelopeComplete = env.complete === true;
        var occupants = asArray(partition(env.occupants).packageOccupants);
        for (var i = 0; i < occupants.length; i += 1) {
          if (cleanString(safeObject(occupants[i]).path) === packagePath) { occupant = safeObject(occupants[i]); break; }
        }
        /* Not present in the trusted enumeration: there is no trusted verdict to
         * show, so this is a local read failure, never `verified`. */
        if (!occupant) readError = 'not-in-trusted-archive';
      }, function () { readError = 'archive-integrity-unavailable'; })
      /* Direct reads below are PREVIEW ONLY. They never decide validity. */
      .then(function () { return readPackageTextFile(packagePath, 'manifest.json').then(function (t) { manifest = safeParseJson(t); }, function () { manifest = null; }); })
      .then(function () { return readPackageTextFile(packagePath, 'chat.md').then(function (t) { markdown = String(t || '').slice(0, MARKDOWN_READ_CAP); }, function () { markdown = ''; }); })
      .then(function () {
        var d = safeObject(occupant);
        var m = safeObject(manifest);
        var status = mapTrustedInspectStatus(d, readError);
        var family = cleanString(d.constructionFamily);
        var schemaVersion = Object.prototype.hasOwnProperty.call(SCHEMA_VERSION_BY_FAMILY, family)
          ? SCHEMA_VERSION_BY_FAMILY[family]
          : (isFiniteNumber(m.schemaVersion) ? m.schemaVersion : null);
        var payloadVersion = Object.prototype.hasOwnProperty.call(PAYLOAD_VERSION_BY_FAMILY, family)
          ? PAYLOAD_VERSION_BY_FAMILY[family]
          : (m.payloadVersion != null ? m.payloadVersion : null);
        var trustedHash = prefixedHash(d.contentHash);
        return {
          ok: status === 'verified',
          status: status,
          packagePath: packagePath,
          packageDirName: packageDirNameForPath(packagePath),
          identity: {
            chatId: cleanString(d.chatId) || cleanString(m.chatId),
            snapshotId: cleanString(d.snapshotId) || cleanString(m.snapshotId),
            title: titleFromMarkdown(markdown),
            /* RECOMPUTED by the governed validator from stored bytes. The
             * manifest's own claim is shown separately and never substituted
             * for it: a package that lies about its identity must not be able
             * to display a borrowed one. */
            contentHash: trustedHash,
            manifestClaimedContentHash: cleanString(m.contentHash),
            /* Trusted verification recomputed and accepted this identity. */
            contentHashVerified: status === 'verified' && !!trustedHash,
            schemaVersion: schemaVersion,
            payloadVersion: payloadVersion,
            /* Recorded by the writer; presentation metadata only — never
             * currentness or ordering authority. */
            generatedAt: cleanString(m.generatedAt),
            /* M05 §D verified classification (legacy | generation | mismatch |
             * unclassified). Derived from verified identity, never a filename
             * parse. */
            nameClassification: (function () {
              var k = cleanString(d.class);
              if (k === 'verified-generation') return 'generation';
              if (k === 'legacy-package') return 'legacy';
              return cleanString(d.reason) === 'identity-mismatch' ? 'mismatch' : 'unclassified';
            })(),
            packageKind: (function () {
              var k = cleanString(d.class);
              return k === 'verified-generation' ? 'generation' : (k === 'legacy-package' ? 'legacy' : 'unusable');
            })(),
            messageCount: isFiniteNumber(m.messageCount) ? m.messageCount : null,
          },
          checks: {
            /* Member presence is not a trusted fact: canonical `Partial` means
             * missing OR unreadable, so claiming per-file presence would invent
             * specificity. These reflect the PREVIEW reads only. */
            manifestPresent: !!manifest,
            snapshotPresent: null,
            markdownPresent: !!markdown,
            htmlPresent: null,
            assetsDirPresent: Array.isArray(d.assetShas) && d.assetShas.length > 0,
            contentHashOk: status === 'verified' && !!trustedHash,
            hashMismatchCount: status === 'hash-mismatch' ? 1 : 0,
            supportedVersion: isVersionSupported(schemaVersion, payloadVersion),
            /* Enumeration completeness, so the card cannot imply the archive was
             * fully enumerated when it was not. */
            archiveEnumerationComplete: envelopeComplete,
          },
          preview: previewFromMarkdown(markdown),
          blockers: blockerCodes(d),
          error: readError,
        };
      })
      .catch(function (err) {
        return emptyInspection(packagePath, 'read-error', String((err && err.message) || err || 'inspection threw'));
      });
  }

  function pillHtml(label, tone) {
    var style = PILL_TONES[tone] || PILL_TONES.neutral;
    return '<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;' + style + '">' + escapeHtml(label) + '</span>';
  }

  function renderArchiveInspectorCard(container, options) {
    if (!container || typeof container !== 'object') return null;
    if (typeof document === 'undefined') return null;
    var opts = options || {};
    var list = (typeof opts.listPackages === 'function') ? opts.listPackages : listPackages;
    var inspect = (typeof opts.inspectPackage === 'function') ? opts.inspectPackage : inspectPackage;
    var desktop = (typeof opts.isDesktop === 'boolean') ? opts.isDesktop : isDesktopCapable();

    var card = {
      desktop: desktop, busy: false, listBusy: false, listLoaded: false,
      options: [], packagePath: '', lastResult: null,
    };

    function syncPathFromSelect() {
      var sel = container.querySelector('[data-archive-inspector-select="1"]');
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
        select = '<select data-archive-inspector-select="1" style="margin-top:6px;width:100%;padding:7px;border-radius:6px;background:rgba(0,0,0,.18);border:1px solid rgba(255,255,255,.14);color:inherit;font:inherit">'
          + '<option value="">' + escapeHtml(TEXT.selectPlaceholder) + '</option>';
        rows.forEach(function (row) {
          var label = row.packageDirName + (row.status ? '  [' + row.status + ']' : '');
          select += '<option value="' + escapeHtml(row.packagePath) + '"' + (row.packagePath === card.packagePath ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
        });
        select += '</select>';
      }
      return hint + select;
    }

    function identityRow(key, value) {
      if (!cleanString(value)) return '';
      return '<div style="display:flex;gap:8px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;word-break:break-all;user-select:text">'
        + '<span style="opacity:.55;min-width:104px">' + escapeHtml(key) + '</span><span>' + escapeHtml(value) + '</span></div>';
    }

    function resultHtml() {
      if (!card.lastResult) return '';
      var r = card.lastResult;
      var preset = STATUS_PRESENTATION[r.status] || { tone: 'neutral', label: r.status, note: '' };
      var id = safeObject(r.identity);
      var ck = safeObject(r.checks);
      var KIND_TEXT = {
        generation: 'immutable generation',
        legacy: 'legacy package (grandfathered)',
        unusable: 'unusable / identity mismatch',
      };
      var idHtml = ''
        /* Recorded location, shown for operator reference only. */
        + identityRow('package', r.packageDirName)
        + identityRow('kind', KIND_TEXT[id.packageKind] || '')
        + identityRow('chatId', id.chatId)
        + identityRow('snapshotId', id.snapshotId)
        + identityRow('title', id.title)
        + identityRow('messageCount', id.messageCount == null ? '' : String(id.messageCount))
        /* The recomputed, verified identity — the only value freshness is ever
         * compared against. */
        + identityRow('contentHash (verified)', id.contentHash)
        /* Shown separately so a divergence is visible rather than hidden by a
         * fallback. */
        + (cleanString(id.manifestClaimedContentHash) && id.manifestClaimedContentHash !== id.contentHash
          ? identityRow('contentHash (claimed)', id.manifestClaimedContentHash + '  ⚠ does not match verified')
          : '')
        + identityRow('schemaVersion', id.schemaVersion == null ? '' : String(id.schemaVersion))
        + identityRow('payloadVersion', id.payloadVersion == null ? '' : String(id.payloadVersion))
        /* Write-time record; never currentness. */
        + identityRow('generatedAt (recorded)', id.generatedAt);
      var checksLine = 'files: '
        + (ck.manifestPresent ? 'manifest✓ ' : 'manifest✗ ')
        + (ck.snapshotPresent ? 'snapshot✓ ' : 'snapshot✗ ')
        + (ck.markdownPresent ? 'chat.md✓ ' : 'chat.md✗ ')
        + (ck.htmlPresent ? 'chat.html✓' : 'chat.html✗')
        + ' · contentHash ' + (ck.contentHashOk ? 'ok' : '—')
        + ' · version ' + (ck.supportedVersion ? 'supported' : 'unsupported');
      var previewHtml = cleanString(r.preview)
        ? '<div style="margin-top:8px"><div style="opacity:.55;font-size:11px;margin-bottom:4px">chat.md preview (read-only)</div>'
          + '<pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;max-height:160px;overflow:auto;background:rgba(0,0,0,.18);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:8px;user-select:text">'
          + escapeHtml(r.preview) + '</pre></div>'
        : '';
      return '<div data-archive-inspector-result="1" data-archive-inspector-status="' + escapeHtml(r.status) + '" style="margin-top:10px;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:10px;background:rgba(255,255,255,.025)">'
        + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' + pillHtml(preset.label, preset.tone) + '<span style="opacity:.6;font-size:12px">' + escapeHtml(r.status) + '</span></div>'
        + (preset.note ? '<div style="opacity:.78;font-size:12px;margin-top:5px">' + escapeHtml(preset.note) + '</div>' : '')
        + '<div style="margin-top:8px;display:flex;flex-direction:column;gap:4px">' + idHtml + '</div>'
        + '<div style="opacity:.7;font-size:11px;margin-top:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace">' + escapeHtml(checksLine) + '</div>'
        + previewHtml
        + '</div>';
    }

    function render() {
      var disabledRun = (!card.desktop || card.busy || card.listBusy) ? ' disabled' : '';
      var disabledLoad = (!card.desktop || card.listBusy || card.busy) ? ' disabled' : '';
      var runStyle = 'padding:8px 14px;border-radius:6px;cursor:pointer;background:rgba(46,160,67,.16);border:1px solid rgba(46,160,67,.4);color:inherit;font:inherit;' + ((!card.desktop || card.busy) ? 'opacity:.5;cursor:default;' : '');
      var loadStyle = 'padding:8px 14px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);color:inherit;font:inherit;' + ((!card.desktop || card.listBusy || card.busy) ? 'opacity:.5;cursor:default;' : '');
      var bodyHtml;
      if (!card.desktop) {
        bodyHtml = '<div style="opacity:.7;font-size:12px;margin-top:8px">' + escapeHtml(TEXT.unavailable) + '</div>';
      } else {
        bodyHtml = ''
          + optionsHtml()
          + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px">'
          + '<button type="button" data-archive-inspector-run="1" style="' + runStyle + '"' + disabledRun + '>' + escapeHtml(card.busy ? TEXT.busy : TEXT.inspectButton) + '</button>'
          + '<button type="button" data-archive-inspector-load="1" style="' + loadStyle + '"' + disabledLoad + '>' + escapeHtml(TEXT.loadButton) + '</button>'
          + '</div>'
          + resultHtml();
      }
      container.innerHTML = ''
        + '<section data-archive-inspector-card="1" style="border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:12px;background:rgba(255,255,255,.02)">'
        + '<div style="font-size:11px;letter-spacing:.04em;text-transform:uppercase;opacity:.6">' + escapeHtml(TEXT.eyebrow) + '</div>'
        + '<div style="font-weight:600;margin-top:2px">' + escapeHtml(TEXT.title) + '</div>'
        + '<div style="opacity:.7;font-size:12px;margin-top:4px">' + escapeHtml(TEXT.intro) + '</div>'
        + bodyHtml
        + '</section>';

      var runBtn = container.querySelector('[data-archive-inspector-run="1"]');
      if (runBtn && card.desktop && !card.busy) runBtn.addEventListener('click', doInspect, { once: true });
      var loadBtn = container.querySelector('[data-archive-inspector-load="1"]');
      if (loadBtn && card.desktop && !card.listBusy && !card.busy) loadBtn.addEventListener('click', doLoad, { once: true });
      var sel = container.querySelector('[data-archive-inspector-select="1"]');
      if (sel) sel.addEventListener('change', function (ev) { var t = ev && ev.target; card.packagePath = (t && typeof t.value === 'string') ? t.value.trim() : ''; });
    }

    function doLoad() {
      if (card.listBusy || card.busy || !card.desktop) return;
      card.listBusy = true; render();
      Promise.resolve(list({})).then(function (rows) {
        card.listBusy = false; card.listLoaded = true; card.options = asArray(rows); render();
      }, function () { card.listBusy = false; card.listLoaded = true; card.options = []; render(); });
    }

    function doInspect() {
      if (card.busy || !card.desktop) return;
      syncPathFromSelect();
      if (!card.packagePath) { card.lastResult = emptyInspection(null, 'read-error', 'select a package first'); render(); return; }
      card.busy = true; card.lastResult = null; render();
      Promise.resolve(inspect({ packagePath: card.packagePath })).then(function (res) {
        card.busy = false; card.lastResult = (res && typeof res === 'object') ? res : emptyInspection(card.packagePath, 'read-error', 'no result'); render();
      }, function (err) {
        card.busy = false; card.lastResult = emptyInspection(card.packagePath, 'read-error', String((err && err.message) || err || 'inspect threw')); render();
      });
    }

    render();
    return { getState: function () { return card; }, inspect: doInspect, load: doLoad };
  }

  /* Mount the inspector card as a SIBLING below the read-only Archive Health
   * card (and the F.2/G.2 operator card), so health re-renders never wipe it.
   * Idempotent. */
  function mountArchiveInspectorCard(healthContainer, options) {
    if (typeof document === 'undefined') return null;
    if (!healthContainer || typeof healthContainer !== 'object') return null;
    var parent = healthContainer.parentNode;
    if (!parent || typeof parent.insertBefore !== 'function') return null;
    var box = (typeof parent.querySelector === 'function') ? parent.querySelector('[data-archive-inspector-mount="1"]') : null;
    if (!box) {
      box = document.createElement('div');
      box.setAttribute('data-archive-inspector-mount', '1');
      box.style.marginTop = '12px';
      parent.insertBefore(box, healthContainer.nextSibling);
    }
    return renderArchiveInspectorCard(box, options || {});
  }

  H2O.Studio.archiveInspector = {
    __installed: true,
    __version: MODULE_VERSION,
    detectTauri: detectTauri,
    isDesktopCapable: isDesktopCapable,
    listPackages: listPackages,
    inspectPackage: inspectPackage,
    renderArchiveInspectorCard: renderArchiveInspectorCard,
    mountArchiveInspectorCard: mountArchiveInspectorCard,
  };
})(typeof window !== 'undefined' ? window : globalThis);
