/* H2O Studio — renderer hygiene observation (M10 P3.5b)
 *
 * Renderer hygiene is DRIFT, never an integrity verdict.
 *
 * Trusted Rust integrity (P1) is the sole authority on whether a package is
 * valid. This module reads the same package's snapshot member a second time
 * for a strictly cosmetic question — did renderer-era residue survive into a
 * package that verifies perfectly? — and can only ever produce warnings beside
 * the trusted classification. It cannot block, cannot fail a package, cannot
 * contribute a blocker code, and cannot move the aggregate state on its own.
 *
 * It therefore performs NO validation:
 *   - it never hashes, and never compares a digest;
 *   - it never calls verifyPackageMemberBytes or readVerifiedPackageMember;
 *   - it owns no gzip implementation. V3/gzip snapshots are decoded by the
 *     codec's single existing bounded NON-VERIFYING decoder (P3.5.4), which is
 *     the same bounded path a reader uses, minus the verification.
 *
 * Family rule:
 *   trusted indeterminate  -> SKIP. Trusted integrity already refused this
 *                             occupant; a renderer read must not tell a second
 *                             story about it, in either direction.
 *   trusted valid (any family, identity or gzip) -> OBSERVE.
 *
 * V3 is deliberately IN scope. V3 forbids persistent renderer MEMBERS, but the
 * residue this module looks for lives inside snapshot content, which V3
 * packages still carry. A V3 package with data:image residue is a real, valid,
 * drifting package — exactly the case that must surface as drift.
 *
 * ABSENT IS NOT ZERO. If the member cannot be read, cannot be decoded, or the
 * facts needed to bound the decode are missing, the observation reports itself
 * unavailable with a reason. It never reports a clean zero it did not measure,
 * and a package that disappears between the trusted scan and this read is a
 * race, not a finding.
 *
 * Public API (H2O.Studio.ingestion):
 *   observeSavedChatRendererHygieneV1(occupantFacts) -> Promise<observation>
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.ingestion = H2O.Studio.ingestion || {};
  if (H2O.Studio.ingestion.observeSavedChatRendererHygieneV1) return;

  var MODULE_VERSION = '0.1.0-m10-p3-5b';
  var SNAPSHOT_MEMBER = 'snapshot.json';
  var CLASS_VERIFIED = 'verified-generation';
  var CLASS_LEGACY = 'legacy-package';

  /* Drift codes. `renderer-data-image-residue` REPLACES the retired legacy
   * blocker code `data-image-residue-v2`: the old name asserted a v2-only
   * scope and rode in a blocker bucket, and this observation is neither. */
  var CODE_DATA_IMAGE = 'renderer-data-image-residue';
  var CODE_ASSET_REF_DRIFT = 'renderer-asset-ref-not-in-trusted-manifest';

  var DATA_IMAGE_PATTERN = /data:image\//i;
  var SHA_TOKEN_PATTERN = /sha256-([0-9a-f]{64})/gi;

  function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function asArray(value) { return Array.isArray(value) ? value : []; }
  function cleanString(value) { return String(value == null ? '' : value).trim(); }
  function isFiniteNumber(value) { return typeof value === 'number' && isFinite(value); }

  /* Trusted integrity projects asset SHAs as bare lowercase hex, while renderer
   * content references them in the `sha256-` prefixed form. Compare on the bare
   * form so a representation difference is never mistaken for drift. */
  function bareHash(value) {
    var text = cleanString(value).toLowerCase();
    return text.indexOf('sha256-') === 0 ? text.slice(7) : text;
  }

  function issue(code, message, detail) {
    var entry = { code: code, message: message };
    if (detail !== undefined) entry.detail = detail;
    return entry;
  }

  function skipped(reason) {
    return { applicable: false, observed: false, reason: reason, warnings: [] };
  }

  /* Unavailable is a first-class outcome: it says a real observation was
   * attempted and could not be completed, which is materially different from
   * "observed, and clean". */
  function unavailable(reason, detail) {
    var result = { applicable: true, observed: false, reason: reason, warnings: [] };
    if (detail !== undefined) result.detail = detail;
    return result;
  }

  function codecOrNull() {
    try {
      var codec = H2O.Studio.ingestion.savedChatPackageCodec;
      return (codec && typeof codec.readBoundedPackageMemberBytes === 'function' &&
              typeof codec.decodeGzipBounded === 'function') ? codec : null;
    } catch (_) { return null; }
  }

  function decodeText(bytes) {
    try { return new global.TextDecoder('utf-8', { fatal: false }).decode(bytes); }
    catch (_) { return null; }
  }

  function isTrustedValid(occupant) {
    var klass = cleanString(occupant.class);
    return klass === CLASS_VERIFIED || klass === CLASS_LEGACY;
  }

  /* A read failure that means "the package is no longer there" is a race with
   * the trusted scan, not evidence about the package. */
  function reasonForReadError(error) {
    var code = cleanString(error && error.code);
    if (code === 'saved-chat-member-read-failed' ||
        code === 'saved-chat-member-invalid-file-type') {
      return 'renderer-hygiene-package-unreadable';
    }
    if (code === 'saved-chat-member-read-unavailable') {
      return 'renderer-hygiene-transport-unavailable';
    }
    return code ? 'renderer-hygiene-read-failed' : 'renderer-hygiene-read-failed';
  }

  function collectAssetRefDrift(text, trustedShas) {
    var trusted = Object.create(null);
    for (var t = 0; t < trustedShas.length; t += 1) {
      var normalized = bareHash(trustedShas[t]);
      if (normalized) trusted[normalized] = true;
    }
    var seen = Object.create(null);
    var drift = [];
    var match;
    SHA_TOKEN_PATTERN.lastIndex = 0;
    while ((match = SHA_TOKEN_PATTERN.exec(text)) !== null) {
      var sha = String(match[1]).toLowerCase();
      if (seen[sha]) continue;
      seen[sha] = true;
      if (!trusted[sha]) drift.push(sha);
    }
    return drift;
  }

  async function observeSavedChatRendererHygieneV1(occupantFacts) {
    var occupant = isObject(occupantFacts) ? occupantFacts : {};
    var packagePath = cleanString(occupant.packagePath || occupant.path);
    if (!packagePath) return skipped('renderer-hygiene-no-package-path');

    /* Family rule. Anything trusted integrity refused is out of scope. */
    if (!isTrustedValid(occupant)) return skipped('trusted-integrity-indeterminate');

    var codec = codecOrNull();
    if (!codec) return unavailable('renderer-hygiene-codec-unavailable');

    var encoding = cleanString(occupant.snapshotEncoding).toLowerCase() || 'identity';
    if (encoding !== 'identity' && encoding !== 'gzip') {
      return unavailable('renderer-hygiene-encoding-unsupported', { encoding: encoding });
    }

    var physicalCap = isFiniteNumber(occupant.snapshotPhysicalByteLength) && occupant.snapshotPhysicalByteLength >= 0
      ? Math.max(1, occupant.snapshotPhysicalByteLength)
      : codec.LOGICAL_SNAPSHOT_CAP_BYTES;

    var bounded;
    try {
      bounded = await codec.readBoundedPackageMemberBytes({
        packagePath: packagePath,
        memberPath: SNAPSHOT_MEMBER,
        physicalByteCap: physicalCap,
      });
    } catch (error) {
      return unavailable(reasonForReadError(error), { code: cleanString(error && error.code) });
    }

    var logicalBytes = bounded && bounded.storedBytes;
    if (encoding === 'gzip') {
      /* The decode bound must come from a TRUSTED fact. Guessing a cap here
       * would be this module inventing a package fact of its own. */
      if (!isFiniteNumber(occupant.logicalSnapshotByteLength) || occupant.logicalSnapshotByteLength < 0) {
        return unavailable('renderer-hygiene-logical-length-unavailable');
      }
      try {
        logicalBytes = await codec.decodeGzipBounded(
          bounded.storedBytes,
          occupant.logicalSnapshotByteLength,
          codec.LOGICAL_SNAPSHOT_CAP_BYTES,
        );
      } catch (error) {
        return unavailable('renderer-hygiene-decode-failed', { code: cleanString(error && error.code) });
      }
    }

    var text = decodeText(logicalBytes);
    if (typeof text !== 'string') return unavailable('renderer-hygiene-decode-failed');

    var warnings = [];
    var dataImage = DATA_IMAGE_PATTERN.test(text);
    if (dataImage) {
      warnings.push(issue(
        CODE_DATA_IMAGE,
        'package snapshot content still contains inline data:image renderer residue',
        { member: SNAPSHOT_MEMBER },
      ));
    }

    /* Asset-ref drift is measured against the TRUSTED manifest projection, so
     * this module never re-reads or re-derives the manifest itself. Where the
     * trusted asset set is absent the comparison is simply not made. */
    var assetRefDrift = [];
    var assetRefsComparable = Array.isArray(occupant.assetShas);
    if (assetRefsComparable) {
      assetRefDrift = collectAssetRefDrift(text, asArray(occupant.assetShas));
      if (assetRefDrift.length) {
        warnings.push(issue(
          CODE_ASSET_REF_DRIFT,
          'snapshot content references an asset the trusted manifest does not list',
          { count: assetRefDrift.length, sha256: assetRefDrift.slice(0, 8) },
        ));
      }
    }

    return {
      applicable: true,
      observed: true,
      encoding: encoding,
      constructionFamily: cleanString(occupant.constructionFamily) || null,
      findings: {
        dataImageResidue: dataImage,
        assetRefDrift: assetRefDrift,
        assetRefsComparable: assetRefsComparable,
      },
      warnings: warnings,
    };
  }

  H2O.Studio.ingestion.observeSavedChatRendererHygieneV1 = observeSavedChatRendererHygieneV1;
  H2O.Studio.ingestion.SAVED_CHAT_RENDERER_HYGIENE_VERSION = MODULE_VERSION;
  H2O.Studio.ingestion.SAVED_CHAT_RENDERER_HYGIENE_CODES = Object.freeze({
    dataImageResidue: CODE_DATA_IMAGE,
    assetRefDrift: CODE_ASSET_REF_DRIFT,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
