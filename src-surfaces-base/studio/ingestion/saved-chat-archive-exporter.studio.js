/* H2O Studio — Saved Chat Archive Exporter (Desktop, Phase J.2)
 *
 * Desktop-only, verification-gated export/share action for one `.h2ochat`
 * package. This is deliberately separate from export-bundle.tauri.js, which is
 * the full-library h2o.studio.fullBundle.v2 exporter.
 *
 * Boundaries:
 *   - Source package must inspect as verified via H2O.Studio.archiveInspector.
 *   - Destination is fixed by one native immutable export-root policy.
 *     Ordinary builds use $HOME/H2O Studio Exports/; the debug-only M09 P3
 *     acceptance artifact uses its identifier-scoped AppLocalData directory.
 *   - No OS picker, no arbitrary caller-supplied destination root.
 *   - Manifest-driven copy only; no blind recursive copy.
 *   - No overwrite: existing final destination is rejected.
 *   - Folder export: staged directory, then native atomic create-only publish.
 *   - ZIP export: semantic verification in memory, then one native-owned
 *     exclusive stage/write/identity-check/create-only publication transaction.
 *   - No DB/store writes, no scanner/materializer/importer calls, no Chrome
 *     package-body authority, no sync/WebDAV/cloud/native messaging.
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  if (H2O.Studio.archiveExporter && H2O.Studio.archiveExporter.__installed) return;

  var MODULE_VERSION = '0.1.0-phase-j-2';
  var APP_LOCAL_DATA = 15;
  var HOME_BASE_DIR = 21;
  var EXPORT_ROOT_POLICY_COMMAND = 'h2o_saved_chat_export_root_policy';
  var EXPORT_ROOT_POLICY_SCHEMA = 'h2o.studio.saved-chat-export-root-policy.v1';
  var EXPORT_BASE_HOME = 'home';
  var EXPORT_BASE_APP_LOCAL_DATA = 'appLocalData';
  var PACKAGE_ROOT = 'archive/packages';
  var EXPORT_ROOT = 'H2O Studio Exports';
  var PACKAGE_SUFFIX = '.h2ochat';
  var ZIP_SUFFIX = '.h2ochat.zip';
  var TMP_SUFFIX_PREFIX = '.tmp-';
  var FOLDER_STAGE_TOKEN_BYTES = 16;
  var FOLDER_STAGE_CREATE_ATTEMPTS = 8;
  var ZIP_STAGE_TOKEN_BYTES = 16;
  var ZIP_STAGE_CREATE_ATTEMPTS = 8;
  var SUPPORTED_SCHEMA_VERSIONS = [1, 2, 3];
  var issuedExportRootPolicyTokens = new WeakSet();

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
  function nowIso() { try { return new Date().toISOString(); } catch (_) { return ''; } }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function getInspector() {
    var ins = H2O.Studio && H2O.Studio.archiveInspector;
    return (ins && typeof ins.inspectPackage === 'function') ? ins : null;
  }

  /* Single governed saved-chat package codec authority (M03 T02/T03). This
   * module never implements gzip decoding, magic detection, physical/logical
   * hashing or descriptor verification; it only consumes verified logical bytes. */
  function savedChatPackageCodecV3() {
    var codec = H2O.Studio && H2O.Studio.ingestion && H2O.Studio.ingestion.savedChatPackageCodec;
    if (!codec || codec.__installed !== true ||
        typeof codec.verifyPackageMemberBytes !== 'function' ||
        !isFiniteNumber(codec.LOGICAL_SNAPSHOT_CAP_BYTES)) {
      return null;
    }
    return codec;
  }

  function getPackageRenderers() {
    var ingestion = (H2O.Studio && H2O.Studio.ingestion) || {};
    var renderers = ingestion.savedChatPackageRenderers;
    return renderers && typeof renderers.renderV3ExportCompanions === 'function' ? renderers : null;
  }

  function getPortableZip() {
    var ingestion = (H2O.Studio && H2O.Studio.ingestion) || {};
    var portable = ingestion.savedChatPortableZip;
    return portable && portable.__installed === true &&
      typeof portable.buildPortableZip === 'function' &&
      typeof portable.readPortablePackageZip === 'function' ? portable : null;
  }

  function getPortableVerifier() {
    var ingestion = (H2O.Studio && H2O.Studio.ingestion) || {};
    return typeof ingestion.verifySavedChatPortablePackageV1 === 'function'
      ? ingestion.verifySavedChatPortablePackageV1 : null;
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

  function isDesktopCapable() {
    return detectTauri() && !!getInspector() && !!getInvoke();
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

  function packagePathIsScoped(packagePath) {
    var p = cleanString(packagePath).replace(/[\/\\]+$/g, '');
    return p.indexOf(PACKAGE_ROOT + '/') === 0 && /\.h2ochat$/.test(packageDirNameForPath(p));
  }

  function normalizeSha(value) {
    var text = cleanString(value).toLowerCase();
    if (!text) return '';
    if (/^[0-9a-f]{64}$/.test(text)) return 'sha256-' + text;
    return /^sha256-[0-9a-f]{64}$/.test(text) ? text : '';
  }

  function bytesFor(value) {
    if (value instanceof Uint8Array) return value;
    if (Array.isArray(value)) return Uint8Array.from(value);
    if (value && typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return new Uint8Array(value);
    if (value && typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (typeof value === 'string') return new TextEncoder().encode(value);
    return new Uint8Array(0);
  }

  function decodeToText(raw) {
    if (typeof raw === 'string') return raw;
    return new TextDecoder('utf-8').decode(bytesFor(raw));
  }

  function exportRootPolicyError(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
  }

  function validateExportRootPolicyWire(value) {
    var wire = safeObject(value);
    var keys = Object.keys(wire).sort();
    if (keys.length !== 2 || keys[0] !== 'baseDirectory' || keys[1] !== 'schema' ||
        cleanString(wire.schema) !== EXPORT_ROOT_POLICY_SCHEMA) {
      throw exportRootPolicyError('saved-chat-export-root-policy-invalid-schema', 'saved-chat export-root policy schema is invalid');
    }
    var baseDirectory = cleanString(wire.baseDirectory);
    if (baseDirectory !== EXPORT_BASE_HOME && baseDirectory !== EXPORT_BASE_APP_LOCAL_DATA) {
      throw exportRootPolicyError('saved-chat-export-root-policy-invalid-base-directory', 'saved-chat export-root policy base directory is missing or unknown');
    }
    var token = Object.freeze({ schema: EXPORT_ROOT_POLICY_SCHEMA, baseDirectory: baseDirectory });
    issuedExportRootPolicyTokens.add(token);
    return token;
  }

  async function readSavedChatExportRootPolicy() {
    var invoke = getInvoke();
    if (!invoke) {
      throw exportRootPolicyError('saved-chat-export-root-policy-unavailable', 'tauri invoke unavailable for saved-chat export-root policy');
    }
    try {
      return validateExportRootPolicyWire(await invoke(EXPORT_ROOT_POLICY_COMMAND, {}));
    } catch (error) {
      if (cleanString(error && error.code).indexOf('saved-chat-export-root-policy-invalid-') === 0) throw error;
      throw exportRootPolicyError(
        'saved-chat-export-root-policy-unavailable',
        'saved-chat export-root policy query failed: ' + String((error && error.message) || error || 'invoke failed')
      );
    }
  }

  function requireExportRootPolicyToken(value) {
    if (!value || !issuedExportRootPolicyTokens.has(value)) {
      throw exportRootPolicyError('saved-chat-export-root-policy-token-required', 'a policy token from the trusted read-only export-root command is required');
    }
    return value;
  }

  function exportRootOptions(policyToken, extra) {
    var policy = requireExportRootPolicyToken(policyToken);
    return Object.assign({
      baseDir: policy.baseDirectory === EXPORT_BASE_APP_LOCAL_DATA ? APP_LOCAL_DATA : HOME_BASE_DIR,
    }, extra || {});
  }

  function appLocalOptions(extra) {
    return Object.assign({ baseDir: APP_LOCAL_DATA }, extra || {});
  }

  async function fsExists(path, options) {
    var invoke = getInvoke();
    if (!invoke) throw new Error('tauri invoke unavailable for fs exists');
    if (!options) throw new Error('saved-chat export-root policy options required for fs exists');
    try { return !!(await invoke('plugin:fs|exists', { path: path, options: options })); }
    catch (err) {
      var msg = String((err && err.message) || err).toLowerCase();
      if (msg.indexOf('not found') >= 0 || msg.indexOf('no such') >= 0) return false;
      throw err;
    }
  }

  function fsMkdir(path, options) {
    var invoke = getInvoke();
    if (!invoke) return Promise.reject(new Error('tauri invoke unavailable for fs mkdir'));
    if (!options) return Promise.reject(new Error('saved-chat export-root policy options required for fs mkdir'));
    return invoke('plugin:fs|mkdir', { path: path, options: options });
  }

  function fsRemove(path, options) {
    var invoke = getInvoke();
    if (!invoke) return Promise.reject(new Error('tauri invoke unavailable for fs remove'));
    if (!options) return Promise.reject(new Error('saved-chat export-root policy options required for fs remove'));
    return invoke('plugin:fs|remove', { path: path, options: options });
  }

  function publishFolderCreateOnly(stagedName, finalName) {
    var invoke = getInvoke();
    if (!invoke) return Promise.reject(new Error('tauri invoke unavailable for folder publication'));
    return invoke('h2o_publish_saved_chat_folder_create_only', {
      request: { stagedName: stagedName, finalName: finalName },
    });
  }

  function createFolderStage(finalName, token) {
    var invoke = getInvoke();
    if (!invoke) return Promise.reject(new Error('tauri invoke unavailable for folder staging'));
    return invoke('h2o_create_saved_chat_folder_stage', {
      request: { finalName: finalName, token: token },
    });
  }

  function randomFolderStageToken() {
    if (!global.crypto || typeof global.crypto.getRandomValues !== 'function') {
      throw new Error('crypto.getRandomValues unavailable for folder staging');
    }
    var bytes = new Uint8Array(FOLDER_STAGE_TOKEN_BYTES);
    global.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  async function createOwnedFolderStage(finalName) {
    for (var attempt = 0; attempt < FOLDER_STAGE_CREATE_ATTEMPTS; attempt += 1) {
      var token = randomFolderStageToken();
      var expectedName = finalName + TMP_SUFFIX_PREFIX + token;
      var result = safeObject(await createFolderStage(finalName, token));
      var status = cleanString(result.status);
      if (status === 'stage-exists') continue;
      if (result.ok === true && result.owned === true && status === 'created' &&
          cleanString(result.stagedName) === expectedName) {
        return { stagedName: expectedName, stagedPath: joinPath(EXPORT_ROOT, expectedName) };
      }
      throw new Error('saved-chat-folder-stage-create-failed');
    }
    throw new Error('saved-chat-folder-stage-collision-exhausted');
  }

  function fsReadFile(path, options) {
    var invoke = getInvoke();
    if (!invoke) return Promise.reject(new Error('tauri invoke unavailable for fs read_file'));
    return invoke('plugin:fs|read_file', { path: path, options: options || appLocalOptions() })
      .then(bytesFor);
  }

  function fsWriteFile(path, bytes, options) {
    var invoke = getInvoke();
    if (!invoke) return Promise.reject(new Error('tauri invoke unavailable for fs write_file'));
    if (!options) return Promise.reject(new Error('saved-chat export-root policy options required for fs write_file'));
    return invoke('plugin:fs|write_file', bytesFor(bytes), {
      headers: {
        path: encodeURIComponent(path),
        options: JSON.stringify(options),
      },
    });
  }

  function randomZipStageToken() {
    if (!global.crypto || typeof global.crypto.getRandomValues !== 'function') {
      throw new Error('crypto.getRandomValues unavailable for ZIP staging');
    }
    var bytes = new Uint8Array(ZIP_STAGE_TOKEN_BYTES);
    global.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  function publishZipBytesCreateOnly(finalName, token, expectedSha256, expectedByteLength, bytes) {
    var invoke = getInvoke();
    if (!invoke) return Promise.reject(new Error('tauri invoke unavailable for ZIP publication'));
    return invoke('h2o_publish_saved_chat_zip_bytes_create_only', bytesFor(bytes), {
      headers: {
        options: encodeURIComponent(JSON.stringify({
          finalName: finalName,
          token: token,
          expectedSha256: expectedSha256,
          expectedByteLength: expectedByteLength,
        })),
      },
    });
  }

  async function publishOwnedZipBytes(finalName, expectedSha256, expectedByteLength, bytes) {
    for (var attempt = 0; attempt < ZIP_STAGE_CREATE_ATTEMPTS; attempt += 1) {
      var token = randomZipStageToken();
      var result = safeObject(await publishZipBytesCreateOnly(
        finalName,
        token,
        expectedSha256,
        expectedByteLength,
        bytes
      ));
      if (cleanString(result.status) === 'stage-exists') continue;
      return result;
    }
    throw new Error('saved-chat-zip-stage-collision-exhausted');
  }

  /* Trusted native carries bare lowercase hex; the outward export contract has
   * always used the prefixed form. Formatting only — nothing is hashed here. */
  function prefixedHash(value) {
    var text = cleanString(value).toLowerCase();
    if (!text) return '';
    return text.indexOf('sha256-') === 0 ? text : 'sha256-' + text;
  }

  /* TRANSPORT hashing only (M10 P3.6c): copied-member equality and the ZIP's
   * own published byte identity. It establishes no package semantics. */
  async function sha256Prefixed(bytes) {
    if (!global.crypto || !global.crypto.subtle) throw new Error('crypto.subtle unavailable for export verification');
    var digest = await global.crypto.subtle.digest('SHA-256', bytesFor(bytes));
    var hex = Array.prototype.map.call(new Uint8Array(digest), function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
    return 'sha256-' + hex;
  }

  function sanitizeExportName(rawName, fallbackName) {
    var name = cleanString(rawName) || cleanString(fallbackName);
    name = name.replace(/[\\\/]+/g, '-').replace(/^\.+/, '').replace(/\s+/g, ' ').trim();
    name = name.replace(/[^A-Za-z0-9._ -]/g, '-');
    if (!name || name === '.' || name === '..' || name.indexOf('..') >= 0 || /[\/\\]/.test(name)) {
      name = cleanString(fallbackName);
    }
    if (!/\.h2ochat$/i.test(name)) name += PACKAGE_SUFFIX;
    name = name.replace(/\.h2ochat$/i, PACKAGE_SUFFIX);
    if (!name || name === PACKAGE_SUFFIX || name.indexOf('..') >= 0 || /[\/\\]/.test(name)) {
      throw new Error('invalid exportName');
    }
    return name;
  }

  function sanitizeZipExportName(rawName, fallbackPackageName) {
    var fallback = sanitizeExportName('', fallbackPackageName) + '.zip';
    var name = cleanString(rawName) || fallback;
    name = name.replace(/[\\\/]+/g, '-').replace(/^\.+/, '').replace(/\s+/g, ' ').trim();
    name = name.replace(/[^A-Za-z0-9._ -]/g, '-');
    if (!/\.h2ochat\.zip$/i.test(name)) {
      name = name.replace(/\.h2ochat$/i, '') + ZIP_SUFFIX;
    }
    name = name.replace(/\.h2ochat\.zip$/i, ZIP_SUFFIX);
    if (!name || name === ZIP_SUFFIX || name.indexOf('..') >= 0 || /[\/\\]/.test(name)) {
      throw new Error('invalid ZIP exportName');
    }
    return name;
  }

  function assertSafeRelativePackagePath(path, kind) {
    var p = cleanString(path);
    if (!p) throw new Error(kind + ' path is required');
    if (p.charAt(0) === '/' || p.charAt(0) === '\\' || /^[A-Za-z]:/.test(p)) throw new Error(kind + ' path must be relative');
    if (p.indexOf('..') >= 0 || /\\/.test(p)) throw new Error(kind + ' path must not traverse');
    if (p.split('/').some(function (part) { return !part || part === '.' || part === '..'; })) {
      throw new Error(kind + ' path has unsafe segments');
    }
    return p;
  }

  function safeParseJson(text) {
    try { var v = JSON.parse(text); return isObject(v) ? v : null; } catch (_) { return null; }
  }

  function fileDescriptorFromManifest(manifest, key, fallbackPath) {
    var desc = safeObject(safeObject(manifest.files)[key]);
    var rel = assertSafeRelativePackagePath(cleanString(desc.path) || fallbackPath, key);
    var sha = normalizeSha(desc.sha256);
    if (!sha) throw new Error(key + ' sha256 is required');
    return {
      role: key,
      path: rel,
      sha256: sha,
      byteLength: isFiniteNumber(desc.byteLength) ? desc.byteLength : null,
    };
  }

  function assetDescriptorFromManifest(asset, index) {
    var desc = safeObject(asset);
    var rel = assertSafeRelativePackagePath(cleanString(desc.path), 'asset');
    if (rel.indexOf('assets/') !== 0) throw new Error('asset path must stay under assets/');
    var sha = normalizeSha(desc.sha256);
    if (!sha) throw new Error('asset sha256 is invalid at index ' + index);
    var fileSha = /^assets\/(sha256-[0-9a-f]{64})(?:\.[A-Za-z0-9]+)?$/.exec(rel);
    if (!fileSha || fileSha[1] !== sha) throw new Error('asset path sha mismatch at index ' + index);
    return {
      role: 'asset',
      path: rel,
      sha256: sha,
      byteLength: isFiniteNumber(desc.byteLength) ? desc.byteLength : null,
    };
  }

  function declaredFilesFromManifest(manifest) {
    var files = [
      { role: 'manifest', path: 'manifest.json', sha256: '', byteLength: null },
      fileDescriptorFromManifest(manifest, 'snapshot', 'snapshot.json'),
    ];
    var schemaVersion = isFiniteNumber(manifest.schemaVersion) ? manifest.schemaVersion : Number(manifest.schemaVersion);
    /* Legacy exports copy their governed renderers byte-for-byte. V3 source
     * packages do not declare them; they are derived in the export temp dir. */
    if (schemaVersion === 1 || schemaVersion === 2) {
      files.push(fileDescriptorFromManifest(manifest, 'markdown', 'chat.md'));
      files.push(fileDescriptorFromManifest(manifest, 'html', 'chat.html'));
    }
    asArray(manifest.assets).forEach(function (asset, index) {
      files.push(assetDescriptorFromManifest(asset, index));
    });
    return files;
  }

  async function readManifest(packagePath) {
    var bytes = await fsReadFile(joinPath(packagePath, 'manifest.json'), appLocalOptions());
    var manifest = safeParseJson(decodeToText(bytes));
    if (!manifest) throw new Error('manifest.json is not parseable');
    return { manifest: manifest, bytes: bytes };
  }

  function isSupportedVersion(manifest) {
    var sv = isFiniteNumber(manifest.schemaVersion) ? manifest.schemaVersion : Number(manifest.schemaVersion);
    if (SUPPORTED_SCHEMA_VERSIONS.indexOf(sv) < 0) return false;
    if (sv === 1) return manifest.payloadVersion == null;
    var pv = isFiniteNumber(manifest.payloadVersion) ? manifest.payloadVersion : Number(manifest.payloadVersion);
    return (sv === 2 && pv === 2) || (sv === 3 && pv === 3);
  }

  /* TRANSPORT assurance only (M10 P3.6c). Each copied member is compared to the
   * descriptor the manifest declares for it, which proves the copy moved the
   * bytes faithfully. It no longer recomputes the package contentHash: the
   * exporter's private semantic identity authority is retired, and package
   * validity now comes from the trusted Archive Inspector for the source and
   * from trusted native verification for the assembled portable package. */
  async function verifyCopiedFiles(manifest, copied) {
    var hashes = {};
    for (var i = 0; i < copied.length; i += 1) {
      var item = copied[i];
      var hash = await sha256Prefixed(item.bytes);
      hashes[item.relativePath] = hash;
      if (item.expectedSha && hash !== item.expectedSha) {
        throw new Error('copied file hash mismatch: ' + item.relativePath);
      }
      if (isFiniteNumber(item.expectedByteLength) && item.bytes.byteLength !== item.expectedByteLength) {
        throw new Error('copied file byteLength mismatch: ' + item.relativePath);
      }
    }
    return { hashes: hashes };
  }

  function exportResult(status, data) {
    var d = safeObject(data);
    return {
      ok: status === 'export-ready' || status === 'exported',
      status: status,
      packagePath: cleanString(d.packagePath) || null,
      exportName: cleanString(d.exportName) || null,
      exportRoot: EXPORT_ROOT,
      destinationPath: cleanString(d.destinationPath) || null,
      tempPath: cleanString(d.tempPath) || null,
      inspectionStatus: cleanString(d.inspectionStatus),
      schemaVersion: d.schemaVersion == null ? null : d.schemaVersion,
      payloadVersion: d.payloadVersion == null ? null : d.payloadVersion,
      /* M05 §D — the exact generation being exported. `contentHash` is the
       * inspector's RECOMPUTED hash (for a `generation` package, the generation
       * identifier in its basename), never the manifest's unverified claim.
       * Export copies the operator's explicitly selected packagePath verbatim:
       * it never substitutes a newer sibling generation or a BEST-HISTORICAL
       * pick, so what lands in the export is what was named. */
      contentHash: cleanString(d.contentHash),
      contentHashVerified: d.contentHashVerified === true,
      packageKind: cleanString(d.packageKind) || null,
      fileCount: isFiniteNumber(d.fileCount) ? d.fileCount : 0,
      assetCount: isFiniteNumber(d.assetCount) ? d.assetCount : 0,
      reason: cleanString(d.reason),
      exportedAt: cleanString(d.exportedAt),
    };
  }

  /* The inspector's VERIFIED identity for a package this flow already
   * inspected. Export must name the generation by its recomputed hash: the
   * manifest's own contentHash field is a claim by the artifact about itself.
   * (Reaching here implies contentHashOk, so the two agree today — but naming
   * the claim as the identity would silently become wrong the moment that
   * precondition is relaxed.) */
  function verifiedIdentity(verified) {
    return safeObject(safeObject(safeObject(verified).inspection).identity);
  }

  function resolveExportDestination(options) {
    var opts = safeObject(options);
    var packagePath = cleanString(opts.packagePath);
    var fallback = packageDirNameForPath(packagePath);
    var exportName = sanitizeExportName(opts.exportName, fallback);
    return {
      exportRoot: EXPORT_ROOT,
      exportName: exportName,
      destinationPath: joinPath(EXPORT_ROOT, exportName),
    };
  }

  function resolveZipExportDestination(options) {
    var opts = safeObject(options);
    var packagePath = cleanString(opts.packagePath);
    var packageName = packageDirNameForPath(packagePath);
    var exportName = sanitizeZipExportName(opts.exportName, packageName);
    return {
      exportRoot: EXPORT_ROOT,
      exportName: exportName,
      destinationPath: joinPath(EXPORT_ROOT, exportName),
      packageDirName: packageName,
    };
  }

  async function inspectVerifiedPackage(packagePath) {
    if (!isDesktopCapable()) return { status: 'rejected', reason: 'desktop-only' };
    if (!packagePath || !packagePathIsScoped(packagePath)) return { status: 'rejected', reason: 'path-not-scoped' };
    var inspection = await getInspector().inspectPackage({ packagePath: packagePath });
    var inspectStatus = cleanString(inspection && inspection.status);
    if (inspectStatus !== 'verified') {
      if (inspectStatus === 'unsupported-version') return { status: 'unsupported-version', reason: inspectStatus, inspection: inspection };
      if (inspectStatus === 'unsupported-encoding') return { status: 'unsupported-encoding', reason: inspectStatus, inspection: inspection };
      if (inspectStatus === 'read-error') return { status: 'read-error', reason: inspectStatus, inspection: inspection };
      if (inspectStatus === 'corrupted' || inspectStatus === 'missing-files' || inspectStatus === 'hash-mismatch') {
        return { status: 'corrupted', reason: inspectStatus, inspection: inspection };
      }
      return { status: 'rejected', reason: inspectStatus || 'not-verified', inspection: inspection };
    }
    var manifestRead = await readManifest(packagePath);
    if (!isSupportedVersion(manifestRead.manifest)) return { status: 'unsupported-version', reason: 'unsupported-version', inspection: inspection };
    return { status: 'verified', inspection: inspection, manifest: manifestRead.manifest, manifestBytes: manifestRead.bytes };
  }

  async function dryRunExportPackage(options, policyToken) {
    var opts = safeObject(options);
    var packagePath = cleanString(opts.packagePath);
    try {
      var exportPolicy = policyToken || await readSavedChatExportRootPolicy();
      var exportFsOptions = exportRootOptions(exportPolicy);
      var dest = resolveExportDestination(opts);
      var verified = await inspectVerifiedPackage(packagePath);
      if (verified.status !== 'verified') {
        return exportResult(verified.status, { packagePath: packagePath, exportName: dest.exportName, destinationPath: dest.destinationPath, reason: verified.reason, inspectionStatus: cleanString(verified.inspection && verified.inspection.status) });
      }
      var exists = await fsExists(dest.destinationPath, exportFsOptions);
      if (exists) {
        return exportResult('destination-exists', {
          packagePath: packagePath,
          exportName: dest.exportName,
          destinationPath: dest.destinationPath,
          inspectionStatus: 'verified',
          reason: 'destination already exists',
        });
      }
      var declared = declaredFilesFromManifest(verified.manifest);
      var schemaVersion = isFiniteNumber(verified.manifest.schemaVersion) ? verified.manifest.schemaVersion : Number(verified.manifest.schemaVersion);
      return exportResult('export-ready', {
        packagePath: packagePath,
        exportName: dest.exportName,
        destinationPath: dest.destinationPath,
        inspectionStatus: 'verified',
        schemaVersion: verified.manifest.schemaVersion,
        payloadVersion: verified.manifest.payloadVersion,
        contentHash: cleanString(verifiedIdentity(verified).contentHash),
        contentHashVerified: verifiedIdentity(verified).contentHashVerified === true,
        packageKind: cleanString(verifiedIdentity(verified).packageKind),
        fileCount: declared.length + (schemaVersion === 3 ? 2 : 0),
        assetCount: asArray(verified.manifest.assets).length,
        reason: 'verified and destination available',
      });
    } catch (err) {
      return exportResult('read-error', { packagePath: packagePath, reason: String((err && err.message) || err || 'dry-run failed') });
    }
  }

  async function copyDeclaredFile(packagePath, tempPath, desc, exportPolicy) {
    var sourceRel = joinPath(packagePath, desc.path);
    var destRel = joinPath(tempPath, desc.path);
    var bytes = await fsReadFile(sourceRel, appLocalOptions());
    await fsWriteFile(destRel, bytes, exportRootOptions(exportPolicy));
    return {
      relativePath: desc.path,
      bytes: bytes,
      expectedSha: desc.sha256,
      expectedByteLength: desc.byteLength,
    };
  }

  async function readDeclaredFile(packagePath, desc) {
    return {
      relativePath: desc.path,
      bytes: await fsReadFile(joinPath(packagePath, desc.path), appLocalOptions()),
      expectedSha: desc.sha256,
      expectedByteLength: desc.byteLength,
    };
  }

  async function buildV3DerivedExportCompanions(manifest, copied) {
    var schemaVersion = isFiniteNumber(manifest.schemaVersion) ? manifest.schemaVersion : Number(manifest.schemaVersion);
    if (schemaVersion !== 3) return [];
    var snapshotDescriptor = safeObject(safeObject(manifest.files).snapshot);
    var snapshotCopy = null;
    for (var i = 0; i < copied.length; i += 1) {
      if (copied[i].relativePath === 'snapshot.json') { snapshotCopy = copied[i]; break; }
    }
    if (!snapshotCopy) throw new Error('verified v3 export is missing copied snapshot.json');
    /* M03 T04: the durable snapshot member is copied byte-identically above and
     * is never decoded-and-recompressed. The logical content used to regenerate
     * the human-readable companions is obtained by verifying those SAME already
     * copied bytes through the single governed codec — physical descriptor
     * verification, encoding validation, bounded decode and logical length/SHA
     * verification. Verifying the copied bytes rather than re-reading the source
     * avoids a redundant read and leaves no TOCTOU window between the bytes that
     * were exported and the bytes that were rendered. A governed failure throws,
     * so the staged export is cleaned up and never published. */
    var codec = savedChatPackageCodecV3();
    if (!codec) throw new Error('governed saved-chat package codec unavailable for v3 export');
    var verifiedMember = await codec.verifyPackageMemberBytes({
      storedBytes: snapshotCopy.bytes,
      descriptor: snapshotDescriptor,
      expectedPath: 'snapshot.json',
      physicalByteCap: codec.LOGICAL_SNAPSHOT_CAP_BYTES,
      logicalByteCap: codec.LOGICAL_SNAPSHOT_CAP_BYTES,
    });
    var snapshot = safeParseJson(decodeToText(safeObject(verifiedMember).logicalBytes));
    if (!snapshot || snapshot.schemaVersion !== 3) throw new Error('verified v3 snapshot.json is not renderable');
    var renderers = getPackageRenderers();
    if (!renderers) throw new Error('v3 export renderer capability unavailable');
    var rendered = safeObject(renderers.renderV3ExportCompanions(snapshot));
    if (typeof rendered.markdownText !== 'string' || typeof rendered.htmlText !== 'string') {
      throw new Error('v3 export renderer returned an invalid result');
    }
    var companions = [
      { relativePath: 'chat.md', bytes: new TextEncoder().encode(rendered.markdownText) },
      { relativePath: 'chat.html', bytes: new TextEncoder().encode(rendered.htmlText) },
    ];
    return companions;
  }

  async function writeV3DerivedExportCompanions(manifest, copied, tempPath, exportPolicy) {
    var companions = await buildV3DerivedExportCompanions(manifest, copied);
    for (var ci = 0; ci < companions.length; ci += 1) {
      await fsWriteFile(
        joinPath(tempPath, companions[ci].relativePath),
        companions[ci].bytes,
        exportRootOptions(exportPolicy)
      );
    }
    return companions;
  }

  async function exportVerifiedPackage(options) {
    var opts = safeObject(options);
    var packagePath = cleanString(opts.packagePath);
    var tempPath = '';
    var tempName = '';
    var ownsStage = false;
    try {
      var exportPolicy = await readSavedChatExportRootPolicy();
      var exportFsOptions = exportRootOptions(exportPolicy);
      var dest = resolveExportDestination(opts);
      var dry = await dryRunExportPackage(opts, exportPolicy);
      if (dry.status !== 'export-ready') return dry;
      var verified = await inspectVerifiedPackage(packagePath);
      if (verified.status !== 'verified') {
        return exportResult(verified.status, { packagePath: packagePath, exportName: dest.exportName, destinationPath: dest.destinationPath, reason: verified.reason, inspectionStatus: cleanString(verified.inspection && verified.inspection.status) });
      }
      var finalExists = await fsExists(dest.destinationPath, exportFsOptions);
      if (finalExists) {
        return exportResult('destination-exists', { packagePath: packagePath, exportName: dest.exportName, destinationPath: dest.destinationPath, inspectionStatus: 'verified', reason: 'destination already exists' });
      }

      var declared = declaredFilesFromManifest(verified.manifest);
      await fsMkdir(EXPORT_ROOT, exportRootOptions(exportPolicy, { recursive: true }));
      var ownedStage = await createOwnedFolderStage(dest.exportName);
      tempName = ownedStage.stagedName;
      tempPath = ownedStage.stagedPath;
      ownsStage = true;
      if (asArray(verified.manifest.assets).length) {
        await fsMkdir(
          joinPath(tempPath, 'assets'),
          exportRootOptions(exportPolicy, { recursive: true })
        );
      }

      var copied = [];
      for (var i = 0; i < declared.length; i += 1) {
        copied.push(await copyDeclaredFile(packagePath, tempPath, declared[i], exportPolicy));
      }
      await verifyCopiedFiles(verified.manifest, copied);
      /* Derived v3 companions are intentionally outside manifest.files and
       * contentHash. The source manifest is copied byte-for-byte and unchanged. */
      var derivedCompanions = await writeV3DerivedExportCompanions(
        verified.manifest,
        copied,
        tempPath,
        exportPolicy
      );
      /* Advisory existence checks above improve UX but are not publication
       * authority. This native operation performs the final existence test and
       * create-only directory namespace mutation atomically under the fixed
       * export root. */
      var publication = safeObject(await publishFolderCreateOnly(tempName, dest.exportName));
      if (cleanString(publication.status) === 'destination-exists') {
        if (ownsStage) {
          try { await fsRemove(tempPath, exportRootOptions(exportPolicy, { recursive: true })); } catch (_) { /* best effort */ }
        }
        ownsStage = false;
        tempPath = '';
        return exportResult('destination-exists', {
          packagePath: packagePath,
          exportName: dest.exportName,
          destinationPath: dest.destinationPath,
          inspectionStatus: 'verified',
          reason: 'destination already exists',
        });
      }
      if (publication.ok !== true || cleanString(publication.status) !== 'published') {
        throw new Error('saved-chat-folder-create-only-publication-failed');
      }
      if (publication.stagingRemoved !== true) {
        throw new Error('saved-chat-folder-create-only-staging-not-removed');
      }
      ownsStage = false;
      tempPath = '';
      return exportResult('exported', {
        packagePath: packagePath,
        exportName: dest.exportName,
        destinationPath: dest.destinationPath,
        inspectionStatus: 'verified',
        schemaVersion: verified.manifest.schemaVersion,
        payloadVersion: verified.manifest.payloadVersion,
        /* Recomputed over the COPIED bytes — this is the proof the export is
         * byte-faithful, not a restatement of the source manifest's claim. */
        /* The TRUSTED identity established by the Archive Inspector for the
         * source package. The exporter no longer derives one of its own. */
        contentHash: cleanString(verifiedIdentity(verified).contentHash),
        contentHashVerified: true,
        packageKind: cleanString(verifiedIdentity(verified).packageKind),
        fileCount: copied.length + derivedCompanions.length,
        assetCount: asArray(verified.manifest.assets).length,
        exportedAt: nowIso(),
        reason: 'exported to bounded Desktop export root',
      });
    } catch (err) {
      if (ownsStage && tempPath) {
        try { await fsRemove(tempPath, exportRootOptions(exportPolicy, { recursive: true })); } catch (_) { /* best-effort cleanup only */ }
      }
      return exportResult('write-error', { packagePath: packagePath, tempPath: tempPath, reason: String((err && err.message) || err || 'export failed') });
    }
  }

  function zipExportResult(status, data) {
    var d = safeObject(data);
    var base = exportResult(status, d);
    base.format = 'h2ochat-zip';
    base.compressionMethod = 8;
    base.entryCount = isFiniteNumber(d.entryCount) ? d.entryCount : 0;
    base.zipByteLength = isFiniteNumber(d.zipByteLength) ? d.zipByteLength : 0;
    base.packageDirName = cleanString(d.packageDirName) || null;
    return base;
  }

  /* Canonical container entry -> native member key. A portable V3 export carries
   * REGENERATED chat.md / chat.html companions: the container's inventory
   * requires them, but V3 package semantics forbid a persistent renderer, so
   * they are transport artifacts and are not offered as semantic members. */
  var CANONICAL_MEMBER_BY_ENTRY = {
    'manifest.json': 'manifest',
    'snapshot.json': 'snapshot',
    'chat.md': 'markdown',
    'chat.html': 'html',
  };
  var CANONICAL_ASSET_ENTRY = /^assets\/sha256-[0-9a-f]{64}\.[a-z0-9]{1,16}$/;

  function portableVerificationInput(packageEntries, schemaVersion) {
    var companionsAreMembers = Number(schemaVersion) !== 3;
    var members = { assets: [] };
    var unexpected = [];
    asArray(packageEntries).forEach(function (entry) {
      var name = cleanString(entry && entry.name);
      if (!name) return;
      var canonical = CANONICAL_MEMBER_BY_ENTRY[name];
      if (canonical) {
        if ((canonical === 'markdown' || canonical === 'html') && !companionsAreMembers) return;
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

  async function assemblePortablePackage(packagePath, verified) {
    var declared = declaredFilesFromManifest(verified.manifest);
    var copied = [];
    for (var i = 0; i < declared.length; i += 1) copied.push(await readDeclaredFile(packagePath, declared[i]));
    await verifyCopiedFiles(verified.manifest, copied);
    var companions = await buildV3DerivedExportCompanions(verified.manifest, copied);
    var packageEntries = copied.concat(companions).map(function (entry) {
      return { name: entry.relativePath, bytes: bytesFor(entry.bytes) };
    });
    var packageDirName = packageDirNameForPath(packagePath);

    /* THE semantic verification, performed ONCE, on the assembled members and
     * before any ZIP exists. The read-back below proves the published bytes are
     * these bytes, so verifying a second time after the write would be ceremony
     * rather than assurance. */
    var verify = getPortableVerifier();
    if (!verify) throw new Error('trusted portable verification unavailable');
    var input = portableVerificationInput(packageEntries, verified.manifest.schemaVersion);
    var trusted = safeObject(await verify({
      packageDirName: packageDirName,
      members: input.members,
      unexpectedMembers: input.unexpectedMembers,
    }));
    if (trusted.verified !== true) {
      var refusal = safeObject(trusted.refusal);
      throw new Error('assembled portable package failed trusted verification: '
        + (cleanString(refusal.code) || 'unknown'));
    }

    return {
      packageDirName: packageDirName,
      packageEntries: packageEntries,
      zipEntries: packageEntries.map(function (entry) {
        return { name: joinPath(packageDirName, entry.name), bytes: entry.bytes };
      }),
      /* The trusted wire is bare hex; the outward export contract has always
       * carried the prefixed form. Formatting only — nothing is recomputed. */
      contentHash: prefixedHash(trusted.contentHash),
      assetCount: asArray(verified.manifest.assets).length,
      schemaVersion: verified.manifest.schemaVersion,
      payloadVersion: verified.manifest.payloadVersion,
      packageKind: cleanString(verifiedIdentity(verified).packageKind),
    };
  }

  function bytesEqual(leftInput, rightInput) {
    var left = bytesFor(leftInput);
    var right = bytesFor(rightInput);
    if (left.byteLength !== right.byteLength) return false;
    for (var i = 0; i < left.byteLength; i += 1) if (left[i] !== right[i]) return false;
    return true;
  }

  /* TRANSPORT identity only. The semantic claim was established before the ZIP
   * was built; this proves the container round-trips those exact bytes, which is
   * what binds the claim to what gets published. */
  async function verifyPortableZipReadback(zipBytes, assembled) {
    var portable = getPortableZip();
    if (!portable) throw new Error('portable ZIP read-back authority unavailable');
    var decoded = await portable.readPortablePackageZip(zipBytes);
    if (decoded.packageDirName !== assembled.packageDirName) throw new Error('portable ZIP package root changed during write');
    var actual = Object.create(null);
    decoded.entries.forEach(function (entry) { actual[entry.name] = entry.bytes; });
    if (decoded.entries.length !== assembled.packageEntries.length) throw new Error('portable ZIP entry count changed during write');
    assembled.packageEntries.forEach(function (entry) {
      if (!actual[entry.name] || !bytesEqual(actual[entry.name], entry.bytes)) {
        throw new Error('portable ZIP member read-back mismatch: ' + entry.name);
      }
    });
    return decoded;
  }

  async function dryRunExportPackageZip(options, policyToken) {
    var opts = safeObject(options);
    var packagePath = cleanString(opts.packagePath);
    try {
      var exportPolicy = policyToken || await readSavedChatExportRootPolicy();
      var dest = resolveZipExportDestination(opts);
      if (!getPortableZip() || !getPortableVerifier()) {
        return zipExportResult('rejected', { packagePath: packagePath, exportName: dest.exportName, destinationPath: dest.destinationPath, reason: 'portable ZIP authority unavailable' });
      }
      var verified = await inspectVerifiedPackage(packagePath);
      if (verified.status !== 'verified') {
        return zipExportResult(verified.status, { packagePath: packagePath, exportName: dest.exportName, destinationPath: dest.destinationPath, reason: verified.reason, inspectionStatus: cleanString(verified.inspection && verified.inspection.status) });
      }
      if (await fsExists(dest.destinationPath, exportRootOptions(exportPolicy))) {
        return zipExportResult('destination-exists', { packagePath: packagePath, exportName: dest.exportName, destinationPath: dest.destinationPath, packageDirName: dest.packageDirName, inspectionStatus: 'verified', reason: 'destination already exists' });
      }
      var schemaVersion = Number(verified.manifest.schemaVersion);
      var entryCount = declaredFilesFromManifest(verified.manifest).length + (schemaVersion === 3 ? 2 : 0);
      return zipExportResult('export-ready', {
        packagePath: packagePath,
        exportName: dest.exportName,
        destinationPath: dest.destinationPath,
        packageDirName: dest.packageDirName,
        inspectionStatus: 'verified',
        schemaVersion: verified.manifest.schemaVersion,
        payloadVersion: verified.manifest.payloadVersion,
        contentHash: cleanString(verifiedIdentity(verified).contentHash),
        contentHashVerified: verifiedIdentity(verified).contentHashVerified === true,
        packageKind: cleanString(verifiedIdentity(verified).packageKind),
        fileCount: entryCount,
        entryCount: entryCount,
        assetCount: asArray(verified.manifest.assets).length,
        reason: 'verified and portable ZIP destination available',
      });
    } catch (error) {
      return zipExportResult('read-error', { packagePath: packagePath, reason: String((error && error.message) || error || 'ZIP dry-run failed') });
    }
  }

  async function exportVerifiedPackageZip(options) {
    var opts = safeObject(options);
    var packagePath = cleanString(opts.packagePath);
    try {
      var exportPolicy = await readSavedChatExportRootPolicy();
      var dest = resolveZipExportDestination(opts);
      var dry = await dryRunExportPackageZip(opts, exportPolicy);
      if (dry.status !== 'export-ready') return dry;
      var verified = await inspectVerifiedPackage(packagePath);
      if (verified.status !== 'verified') {
        return zipExportResult(verified.status, { packagePath: packagePath, exportName: dest.exportName, destinationPath: dest.destinationPath, reason: verified.reason, inspectionStatus: cleanString(verified.inspection && verified.inspection.status) });
      }
      var assembled = await assemblePortablePackage(packagePath, verified);
      var portable = getPortableZip();
      var zipBytes = await portable.buildPortableZip(assembled.zipEntries, { method: portable.METHOD_DEFLATE });
      var decoded = await verifyPortableZipReadback(zipBytes, assembled);
      var expectedZipSha256 = await sha256Prefixed(zipBytes);
      if (await fsExists(dest.destinationPath, exportRootOptions(exportPolicy))) {
        return zipExportResult('destination-exists', { packagePath: packagePath, exportName: dest.exportName, destinationPath: dest.destinationPath, packageDirName: dest.packageDirName, inspectionStatus: 'verified', reason: 'destination already exists' });
      }
      /* Advisory existence checks above improve UX but are not publication
       * authority. This native transaction exclusively creates and owns the
       * stage outside renderer mutation authority, writes and verifies these
       * exact bytes through its retained handle, then atomically creates the
       * final name from that handle rather than from the staging pathname. */
      var publication = safeObject(await publishOwnedZipBytes(
        dest.exportName,
        expectedZipSha256,
        zipBytes.byteLength,
        zipBytes
      ));
      if (cleanString(publication.status) === 'destination-exists') {
        return zipExportResult('destination-exists', {
          packagePath: packagePath,
          exportName: dest.exportName,
          destinationPath: dest.destinationPath,
          packageDirName: dest.packageDirName,
          inspectionStatus: 'verified',
          reason: 'destination already exists',
        });
      }
      if (publication.ok !== true || cleanString(publication.status) !== 'published') {
        throw new Error('saved-chat-zip-create-only-publication-failed:' + cleanString(publication.status));
      }
      /* Publication is the commit point. Native staging cleanup and the final
       * parent durability fence are reported separately and must never turn an
       * already-created final object into an apparent no-commit failure. */
      if (publication.committed !== true ||
          Number(publication.byteLength) !== zipBytes.byteLength ||
          cleanString(publication.sha256) !== expectedZipSha256) {
        throw new Error('saved-chat-zip-publication-identity-mismatch');
      }
      return zipExportResult('exported', {
        packagePath: packagePath,
        exportName: dest.exportName,
        destinationPath: dest.destinationPath,
        packageDirName: assembled.packageDirName,
        inspectionStatus: 'verified',
        schemaVersion: assembled.schemaVersion,
        payloadVersion: assembled.payloadVersion,
        contentHash: assembled.contentHash,
        contentHashVerified: true,
        packageKind: assembled.packageKind,
        fileCount: assembled.packageEntries.length,
        entryCount: decoded.entryCount,
        assetCount: assembled.assetCount,
        zipByteLength: zipBytes.byteLength,
        exportedAt: nowIso(),
        reason: 'portable ZIP exported and read-back verified',
      });
    } catch (error) {
      return zipExportResult('write-error', { packagePath: packagePath, reason: String((error && error.message) || error || 'ZIP export failed') });
    }
  }

  var TEXT = {
    title: 'Export Saved Chat Archive Package',
    eyebrow: 'Export / share · Desktop only · bounded root',
    intro: 'Export one verified .h2ochat package to $HOME/H2O Studio Exports/. No overwrite, no zip, no cloud or sync propagation.',
    unavailable: 'This export action is available in Desktop Studio only.',
    loadButton: 'Load packages',
    dryRunButton: 'Check export',
    exportButton: 'Export package',
    loadingList: 'Loading packages...',
    noPackages: 'No saved chat packages found in the archive.',
    selectPlaceholder: 'Select a package...',
  };

  var STATUS_PRESENTATION = {
    'verified': { tone: 'ok', label: 'Verified' },
    'export-ready': { tone: 'ok', label: 'Export-ready', note: 'Package verifies and the bounded export destination is available.' },
    'exported': { tone: 'ok', label: 'Exported', note: 'Package folder copied to the bounded Desktop export root.' },
    'destination-exists': { tone: 'warn', label: 'Destination exists', note: 'No overwrite was performed. Choose a different export name.' },
    'corrupted': { tone: 'block', label: 'Corrupted', note: 'Package failed verification and was not exported.' },
    'unsupported-version': { tone: 'warn', label: 'Unsupported version', note: 'Package version is outside the supported export range.' },
    'unsupported-encoding': { tone: 'warn', label: 'Unsupported encoding', note: 'This package encoding is not enabled for export yet.' },
    'rejected': { tone: 'block', label: 'Rejected', note: 'Export was refused.' },
    'read-error': { tone: 'block', label: 'Read error', note: 'The source package could not be verified/read.' },
    'write-error': { tone: 'block', label: 'Write error', note: 'The export write did not complete.' },
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

  function renderArchiveExporterCard(container, options) {
    if (!container || typeof container !== 'object') return null;
    if (typeof document === 'undefined') return null;
    var opts = options || {};
    var dryRun = (typeof opts.dryRunExportPackage === 'function') ? opts.dryRunExportPackage : dryRunExportPackage;
    var doExport = (typeof opts.exportVerifiedPackage === 'function') ? opts.exportVerifiedPackage : exportVerifiedPackage;
    var listFn = (typeof opts.listPackages === 'function') ? opts.listPackages : listPackagesViaInspector;
    var desktop = (typeof opts.isDesktop === 'boolean') ? opts.isDesktop : isDesktopCapable();
    var card = { desktop: desktop, busy: false, listBusy: false, listLoaded: false, options: [], packagePath: '', exportName: '', lastDry: null, lastExport: null };

    function canExport() {
      return !!card.lastDry && card.lastDry.status === 'export-ready' && card.lastDry.packagePath === card.packagePath;
    }
    function syncFields() {
      var sel = container.querySelector('[data-archive-exporter-select="1"]');
      var name = container.querySelector('[data-archive-exporter-name="1"]');
      if (sel && typeof sel.value === 'string') card.packagePath = sel.value.trim();
      if (name && typeof name.value === 'string') card.exportName = name.value.trim();
    }
    function optionsHtml() {
      if (!card.desktop) return '';
      var rows = asArray(card.options);
      var hint = '';
      if (card.listBusy) hint = '<div style="opacity:.6;font-size:12px;margin-top:6px">' + escapeHtml(TEXT.loadingList) + '</div>';
      else if (card.listLoaded && !rows.length) hint = '<div style="opacity:.6;font-size:12px;margin-top:6px">' + escapeHtml(TEXT.noPackages) + '</div>';
      var select = '';
      if (rows.length) {
        select = '<select data-archive-exporter-select="1" style="margin-top:6px;width:100%;padding:7px;border-radius:6px;background:rgba(0,0,0,.18);border:1px solid rgba(255,255,255,.14);color:inherit;font:inherit">'
          + '<option value="">' + escapeHtml(TEXT.selectPlaceholder) + '</option>';
        rows.forEach(function (row) {
          var r = safeObject(row);
          var label = cleanString(r.packageDirName) + (cleanString(r.status) ? '  [' + cleanString(r.status) + ']' : '');
          select += '<option value="' + escapeHtml(cleanString(r.packagePath)) + '"' + (cleanString(r.packagePath) === card.packagePath ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
        });
        select += '</select>';
      }
      return hint + select
        + '<input data-archive-exporter-name="1" value="' + escapeHtml(card.exportName) + '" placeholder="Optional export name (.h2ochat)" style="margin-top:8px;width:100%;padding:7px;border-radius:6px;background:rgba(0,0,0,.18);border:1px solid rgba(255,255,255,.14);color:inherit;font:inherit">';
    }
    function identityRow(key, value) {
      if (!cleanString(value)) return '';
      return '<div style="display:flex;gap:8px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;word-break:break-all;user-select:text">'
        + '<span style="opacity:.55;min-width:120px">' + escapeHtml(key) + '</span><span>' + escapeHtml(value) + '</span></div>';
    }
    function resultBlockHtml(result, kind) {
      if (!result) return '';
      var status = cleanString(result.status);
      var preset = STATUS_PRESENTATION[status] || { tone: 'neutral', label: status, note: '' };
      return '<div data-archive-exporter-' + kind + '="1" data-archive-exporter-status="' + escapeHtml(status) + '" style="margin-top:10px;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:10px;background:rgba(255,255,255,.025)">'
        + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' + pillHtml(preset.label, preset.tone) + '<span style="opacity:.6;font-size:12px">' + escapeHtml(kind) + ' · ' + escapeHtml(status) + '</span></div>'
        + (preset.note ? '<div style="opacity:.78;font-size:12px;margin-top:5px">' + escapeHtml(preset.note) + '</div>' : '')
        + (cleanString(result.reason) ? '<div style="opacity:.6;font-size:11px;margin-top:4px">' + escapeHtml(result.reason) + '</div>' : '')
        + '<div style="margin-top:8px;display:flex;flex-direction:column;gap:4px">'
        + identityRow('destination', result.destinationPath)
        + identityRow('contentHash', result.contentHash)
        + identityRow('schemaVersion', result.schemaVersion == null ? '' : String(result.schemaVersion))
        + identityRow('payloadVersion', result.payloadVersion == null ? '' : String(result.payloadVersion))
        + identityRow('fileCount', result.fileCount ? String(result.fileCount) : '')
        + identityRow('assetCount', result.assetCount ? String(result.assetCount) : '')
        + identityRow('exportedAt', result.exportedAt)
        + '</div></div>';
    }
    function render() {
      var disabledLoad = (!card.desktop || card.listBusy || card.busy) ? ' disabled' : '';
      var disabledDry = (!card.desktop || card.busy || card.listBusy) ? ' disabled' : '';
      var exportEnabled = card.desktop && !card.busy && !card.listBusy && canExport();
      var disabledExport = exportEnabled ? '' : ' disabled';
      var btnBase = 'padding:8px 14px;border-radius:6px;cursor:pointer;color:inherit;font:inherit;';
      var bodyHtml;
      if (!card.desktop) {
        bodyHtml = '<div style="opacity:.7;font-size:12px;margin-top:8px">' + escapeHtml(TEXT.unavailable) + '</div>';
      } else {
        bodyHtml = ''
          + optionsHtml()
          + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px">'
          + '<button type="button" data-archive-exporter-dry="1" style="' + btnBase + 'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);' + (disabledDry ? 'opacity:.5;cursor:default;' : '') + '"' + disabledDry + '>' + escapeHtml(card.busy === 'dry' ? 'Checking...' : TEXT.dryRunButton) + '</button>'
          + '<button type="button" data-archive-exporter-export="1" style="' + btnBase + 'background:rgba(46,160,67,.16);border:1px solid rgba(46,160,67,.4);' + (exportEnabled ? '' : 'opacity:.45;cursor:default;') + '"' + disabledExport + '>' + escapeHtml(card.busy === 'export' ? 'Exporting...' : TEXT.exportButton) + '</button>'
          + '<button type="button" data-archive-exporter-load="1" style="' + btnBase + 'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);' + (disabledLoad ? 'opacity:.5;cursor:default;' : '') + '"' + disabledLoad + '>' + escapeHtml(TEXT.loadButton) + '</button>'
          + '</div>'
          + resultBlockHtml(card.lastDry, 'dry-run')
          + resultBlockHtml(card.lastExport, 'export');
      }
      container.innerHTML = ''
        + '<section data-archive-exporter-card="1" style="border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:12px;background:rgba(255,255,255,.02)">'
        + '<div style="font-size:11px;letter-spacing:.04em;text-transform:uppercase;opacity:.6">' + escapeHtml(TEXT.eyebrow) + '</div>'
        + '<div style="font-weight:600;margin-top:2px">' + escapeHtml(TEXT.title) + '</div>'
        + '<div style="opacity:.7;font-size:12px;margin-top:4px">' + escapeHtml(TEXT.intro) + '</div>'
        + bodyHtml
        + '</section>';
      var dryBtn = container.querySelector('[data-archive-exporter-dry="1"]');
      if (dryBtn && card.desktop && !card.busy && !card.listBusy) dryBtn.addEventListener('click', doDryRun, { once: true });
      var exportBtn = container.querySelector('[data-archive-exporter-export="1"]');
      if (exportBtn && exportEnabled) exportBtn.addEventListener('click', doExportClick, { once: true });
      var loadBtn = container.querySelector('[data-archive-exporter-load="1"]');
      if (loadBtn && card.desktop && !card.listBusy && !card.busy) loadBtn.addEventListener('click', doLoad, { once: true });
      var sel = container.querySelector('[data-archive-exporter-select="1"]');
      if (sel) sel.addEventListener('change', function () { syncFields(); card.lastDry = null; card.lastExport = null; render(); });
      var name = container.querySelector('[data-archive-exporter-name="1"]');
      if (name) name.addEventListener('input', function () { syncFields(); card.lastDry = null; card.lastExport = null; });
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
      syncFields();
      if (!card.packagePath) { card.lastDry = exportResult('rejected', { reason: 'select a package first' }); render(); return; }
      card.busy = 'dry'; card.lastDry = null; card.lastExport = null; render();
      Promise.resolve(dryRun({ packagePath: card.packagePath, exportName: card.exportName })).then(function (res) {
        card.busy = false; card.lastDry = (res && typeof res === 'object') ? res : exportResult('rejected', { packagePath: card.packagePath, reason: 'no result' }); render();
      }, function (err) {
        card.busy = false; card.lastDry = exportResult('read-error', { packagePath: card.packagePath, reason: String((err && err.message) || err || 'dry-run threw') }); render();
      });
    }
    function doExportClick() {
      if (card.busy || !card.desktop || !canExport()) return;
      syncFields();
      card.busy = 'export'; card.lastExport = null; render();
      Promise.resolve(doExport({ packagePath: card.packagePath, exportName: card.exportName })).then(function (res) {
        card.busy = false; card.lastExport = (res && typeof res === 'object') ? res : exportResult('write-error', { packagePath: card.packagePath, reason: 'no result' }); render();
      }, function (err) {
        card.busy = false; card.lastExport = exportResult('write-error', { packagePath: card.packagePath, reason: String((err && err.message) || err || 'export threw') }); render();
      });
    }
    render();
    return { getState: function () { return card; }, dryRun: doDryRun, doExport: doExportClick, load: doLoad };
  }

  function mountArchiveExporterCard(healthContainer, options) {
    if (typeof document === 'undefined') return null;
    if (!healthContainer || typeof healthContainer !== 'object') return null;
    var parent = healthContainer.parentNode;
    if (!parent || typeof parent.appendChild !== 'function') return null;
    var box = (typeof parent.querySelector === 'function') ? parent.querySelector('[data-archive-exporter-mount="1"]') : null;
    if (!box) {
      box = document.createElement('div');
      box.setAttribute('data-archive-exporter-mount', '1');
      box.style.marginTop = '12px';
      parent.appendChild(box);
    }
    return renderArchiveExporterCard(box, options || {});
  }

  H2O.Studio.archiveExporter = {
    __installed: true,
    __version: MODULE_VERSION,
    detectTauri: detectTauri,
    isDesktopCapable: isDesktopCapable,
    readSavedChatExportRootPolicy: readSavedChatExportRootPolicy,
    resolveExportDestination: resolveExportDestination,
    resolveZipExportDestination: resolveZipExportDestination,
    dryRunExportPackage: dryRunExportPackage,
    exportVerifiedPackage: exportVerifiedPackage,
    dryRunExportPackageZip: dryRunExportPackageZip,
    exportVerifiedPackageZip: exportVerifiedPackageZip,
    renderArchiveExporterCard: renderArchiveExporterCard,
    mountArchiveExporterCard: mountArchiveExporterCard,
    _private: {
      sanitizeExportName: sanitizeExportName,
      sanitizeZipExportName: sanitizeZipExportName,
      assertSafeRelativePackagePath: assertSafeRelativePackagePath,
      declaredFilesFromManifest: declaredFilesFromManifest,
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
