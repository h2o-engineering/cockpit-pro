/* H2O Studio Saved Chat Package Member Codec (Desktop / Tauri)
 *
 * Narrow v3 integrity substrate for M03. This module owns native gzip byte
 * encoding plus physical/logical verification of one governed package member.
 * Representation selection/publication remains with the isolated v3 writer;
 * this module does not verify package contentHash, parse JSON, or activate any
 * consumer read path.
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
  if (H2O.Studio.ingestion.savedChatPackageCodec &&
      H2O.Studio.ingestion.savedChatPackageCodec.__installed) return;

  var MODULE_VERSION = '1.0.0-m03-t03';
  var APP_LOCAL_DATA = 15;
  var PACKAGE_ROOT = 'archive/packages';
  var LOGICAL_SNAPSHOT_CAP_BYTES = 8 * 1024 * 1024;
  var SHA256_PATTERN = /^sha256-[0-9a-f]{64}$/;
  var IDENTITY_ENCODING = 'identity';
  var GZIP_ENCODING = 'gzip';

  function safeObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function cleanString(value) {
    return String(value == null ? '' : value).trim();
  }

  function codecError(code, message, detail) {
    var error = new Error(message);
    error.name = 'SavedChatPackageMemberError';
    error.code = code;
    if (typeof detail !== 'undefined') error.detail = detail;
    return error;
  }

  function isCodecError(error) {
    return !!(error && error.name === 'SavedChatPackageMemberError' &&
      /^saved-chat-member-/.test(cleanString(error.code)));
  }

  function requireByteCap(value, code, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw codecError(code, label + ' must be a non-negative safe integer');
    }
    return value;
  }

  function requireByteLength(value, code, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw codecError(code, label + ' must be a non-negative safe integer');
    }
    return value;
  }

  function governedLogicalByteCap(value) {
    var requested = requireByteCap(value, 'saved-chat-member-invalid-cap', 'logical byte cap');
    return Math.min(requested, LOGICAL_SNAPSHOT_CAP_BYTES);
  }

  function normalizeBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (value && typeof ArrayBuffer !== 'undefined' &&
        ArrayBuffer.isView && ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (Array.isArray(value)) return Uint8Array.from(value);
    throw codecError('saved-chat-member-invalid-byte-input', 'package member input must be bytes');
  }

  function copyBytes(value) {
    var source = normalizeBytes(value);
    var copy = new Uint8Array(source.byteLength);
    copy.set(source);
    return copy;
  }

  function bytesToHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 1) {
      var part = bytes[i].toString(16);
      out += part.length === 1 ? '0' + part : part;
    }
    return out;
  }

  async function sha256PrefixedBytes(value) {
    var cryptoObj = global.crypto || {};
    if (!cryptoObj.subtle || typeof cryptoObj.subtle.digest !== 'function') {
      throw codecError('saved-chat-member-hash-unavailable', 'WebCrypto SHA-256 is unavailable');
    }
    var digest = await cryptoObj.subtle.digest('SHA-256', normalizeBytes(value));
    return 'sha256-' + bytesToHex(new Uint8Array(digest));
  }

  function requireSha256(value, code, label) {
    var sha = cleanString(value).toLowerCase();
    if (!SHA256_PATTERN.test(sha)) {
      throw codecError(code, label + ' must use the governed sha256-<hex> form');
    }
    return sha;
  }

  function streamFromBytes(value) {
    if (typeof global.ReadableStream !== 'function') {
      throw codecError('saved-chat-member-stream-unavailable', 'ReadableStream is unavailable');
    }
    var bytes = copyBytes(value);
    return new global.ReadableStream({
      start: function (controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async function collectStreamBounded(readable, byteCap, overflowCode, overflowMessage) {
    var cap = requireByteCap(byteCap, 'saved-chat-member-invalid-cap', 'stream byte cap');
    var reader = readable.getReader();
    var chunks = [];
    var total = 0;
    try {
      while (true) {
        var step = await reader.read();
        if (step.done) break;
        var incoming = normalizeBytes(step.value);
        var nextTotal = total + incoming.byteLength;
        if (!Number.isSafeInteger(nextTotal) || nextTotal > cap) {
          try { await reader.cancel(); } catch (_) { /* best effort */ }
          throw codecError(overflowCode, overflowMessage, { byteCap: cap, retainedBytes: total });
        }
        var chunk = copyBytes(incoming);
        chunks.push(chunk);
        total = nextTotal;
      }
    } finally {
      try { reader.releaseLock(); } catch (_) { /* ignore */ }
    }

    var output = new Uint8Array(total);
    var offset = 0;
    chunks.forEach(function (chunk) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    });
    return output;
  }

  async function gzipEncodeBytes(logicalInput, options) {
    var opts = safeObject(options);
    var logicalBytes = copyBytes(logicalInput);
    if (logicalBytes.byteLength > LOGICAL_SNAPSHOT_CAP_BYTES) {
      throw codecError('saved-chat-member-declared-logical-size-exceeds-cap', 'logical gzip input exceeds the governed snapshot cap', {
        logicalByteCap: LOGICAL_SNAPSHOT_CAP_BYTES,
        actualByteLength: logicalBytes.byteLength,
      });
    }
    var physicalByteCap = requireByteCap(
      opts.physicalByteCap,
      'saved-chat-member-invalid-cap',
      'gzip physical output cap'
    );
    if (typeof global.CompressionStream !== 'function') {
      throw codecError('saved-chat-member-gzip-unavailable', 'CompressionStream gzip is unavailable');
    }
    var compressor;
    try { compressor = new global.CompressionStream(GZIP_ENCODING); }
    catch (_) {
      throw codecError('saved-chat-member-gzip-unavailable', 'CompressionStream gzip is unavailable');
    }
    try {
      var compressed = streamFromBytes(logicalBytes).pipeThrough(compressor);
      return await collectStreamBounded(
        compressed,
        physicalByteCap,
        'saved-chat-member-physical-output-exceeds-cap',
        'gzip physical output exceeds its governed cap'
      );
    } catch (error) {
      if (isCodecError(error)) throw error;
      throw codecError('saved-chat-member-compression-failed', 'gzip compression failed');
    }
  }

  async function decodeGzipBounded(storedBytes, contentByteLength, logicalByteCap) {
    var effectiveCap = Math.min(contentByteLength, logicalByteCap);
    if (typeof global.DecompressionStream !== 'function') {
      throw codecError('saved-chat-member-gzip-unavailable', 'DecompressionStream gzip is unavailable');
    }
    var decompressor;
    try { decompressor = new global.DecompressionStream(GZIP_ENCODING); }
    catch (_) {
      throw codecError('saved-chat-member-gzip-unavailable', 'DecompressionStream gzip is unavailable');
    }
    try {
      return await collectStreamBounded(
        streamFromBytes(storedBytes).pipeThrough(decompressor),
        effectiveCap,
        'saved-chat-member-decoded-output-exceeds-cap',
        'decoded gzip output exceeds its declared or governed logical cap'
      );
    } catch (error) {
      if (isCodecError(error)) throw error;
      throw codecError('saved-chat-member-decompression-failed', 'gzip decompression failed');
    }
  }

  function validateExpectedPath(descriptor, expectedPath) {
    var descriptorPath = cleanString(descriptor.path);
    if (!descriptorPath) {
      throw codecError('saved-chat-member-invalid-descriptor', 'member descriptor path is required');
    }
    if (expectedPath && descriptorPath !== expectedPath) {
      throw codecError('saved-chat-member-path-mismatch', 'member descriptor path does not match the expected member');
    }
    return descriptorPath;
  }

  function verifiedResult(path, encoding, physicalSha, physicalLength, logicalSha, logicalLength, logicalBytes) {
    return Object.freeze({
      scope: 'verified-package-member',
      packageVerified: false,
      path: path,
      encoding: encoding,
      physicalSha256: physicalSha,
      physicalByteLength: physicalLength,
      logicalSha256: logicalSha,
      logicalByteLength: logicalLength,
      logicalBytes: logicalBytes,
    });
  }

  async function verifyPackageMemberBytes(options) {
    var opts = safeObject(options);
    var descriptor = safeObject(opts.descriptor);
    var expectedPath = cleanString(opts.expectedPath);
    var path = validateExpectedPath(descriptor, expectedPath);
    var physicalByteCap = requireByteCap(
      opts.physicalByteCap,
      'saved-chat-member-invalid-cap',
      'physical byte cap'
    );
    var logicalByteCap = governedLogicalByteCap(opts.logicalByteCap);
    var storedBytes = copyBytes(opts.storedBytes);

    if (storedBytes.byteLength > physicalByteCap) {
      throw codecError('saved-chat-member-physical-input-exceeds-cap', 'stored member exceeds its governed physical cap', {
        physicalByteCap: physicalByteCap,
        actualByteLength: storedBytes.byteLength,
      });
    }

    var descriptorPhysicalLength = requireByteLength(
      descriptor.byteLength,
      'saved-chat-member-invalid-descriptor',
      'descriptor byteLength'
    );
    if (storedBytes.byteLength !== descriptorPhysicalLength) {
      throw codecError('saved-chat-member-physical-size-mismatch', 'stored member byteLength does not match its descriptor', {
        expectedByteLength: descriptorPhysicalLength,
        actualByteLength: storedBytes.byteLength,
      });
    }

    var descriptorPhysicalSha = requireSha256(
      descriptor.sha256,
      'saved-chat-member-invalid-descriptor',
      'descriptor sha256'
    );
    var actualPhysicalSha = await sha256PrefixedBytes(storedBytes);
    if (actualPhysicalSha !== descriptorPhysicalSha) {
      throw codecError('saved-chat-member-physical-hash-mismatch', 'stored member SHA-256 does not match its descriptor');
    }

    var encoding = cleanString(descriptor.encoding).toLowerCase();
    if (encoding !== IDENTITY_ENCODING && encoding !== GZIP_ENCODING) {
      throw codecError('saved-chat-member-unsupported-encoding', 'member encoding is unsupported');
    }

    if (encoding === IDENTITY_ENCODING) {
      if (storedBytes.byteLength > logicalByteCap) {
        throw codecError('saved-chat-member-declared-logical-size-exceeds-cap', 'identity logical bytes exceed the governed logical cap', {
          logicalByteCap: logicalByteCap,
          actualByteLength: storedBytes.byteLength,
        });
      }
      if (typeof descriptor.contentByteLength !== 'undefined') {
        var identityLogicalLength = requireByteLength(
          descriptor.contentByteLength,
          'saved-chat-member-invalid-logical-descriptor',
          'identity contentByteLength'
        );
        if (identityLogicalLength !== descriptorPhysicalLength) {
          throw codecError('saved-chat-member-invalid-logical-descriptor', 'identity contentByteLength contradicts physical byteLength');
        }
      }
      if (typeof descriptor.contentSha256 !== 'undefined') {
        var identityLogicalSha = requireSha256(
          descriptor.contentSha256,
          'saved-chat-member-invalid-logical-descriptor',
          'identity contentSha256'
        );
        if (identityLogicalSha !== descriptorPhysicalSha) {
          throw codecError('saved-chat-member-invalid-logical-descriptor', 'identity contentSha256 contradicts physical sha256');
        }
      }
      return verifiedResult(
        path,
        encoding,
        actualPhysicalSha,
        storedBytes.byteLength,
        actualPhysicalSha,
        storedBytes.byteLength,
        storedBytes
      );
    }

    if (typeof descriptor.contentByteLength === 'undefined' ||
        typeof descriptor.contentSha256 === 'undefined') {
      throw codecError('saved-chat-member-invalid-logical-descriptor', 'gzip members require contentByteLength and contentSha256');
    }
    var declaredLogicalLength = requireByteLength(
      descriptor.contentByteLength,
      'saved-chat-member-invalid-logical-descriptor',
      'gzip contentByteLength'
    );
    var declaredLogicalSha = requireSha256(
      descriptor.contentSha256,
      'saved-chat-member-invalid-logical-descriptor',
      'gzip contentSha256'
    );
    if (declaredLogicalLength > logicalByteCap) {
      throw codecError('saved-chat-member-declared-logical-size-exceeds-cap', 'declared gzip logical size exceeds the governed cap', {
        contentByteLength: declaredLogicalLength,
        logicalByteCap: logicalByteCap,
      });
    }

    var logicalBytes = await decodeGzipBounded(storedBytes, declaredLogicalLength, logicalByteCap);
    if (logicalBytes.byteLength !== declaredLogicalLength) {
      throw codecError('saved-chat-member-decoded-length-mismatch', 'decoded gzip byteLength does not match contentByteLength', {
        expectedByteLength: declaredLogicalLength,
        actualByteLength: logicalBytes.byteLength,
      });
    }
    var actualLogicalSha = await sha256PrefixedBytes(logicalBytes);
    if (actualLogicalSha !== declaredLogicalSha) {
      throw codecError('saved-chat-member-decoded-hash-mismatch', 'decoded gzip SHA-256 does not match contentSha256');
    }
    return verifiedResult(
      path,
      encoding,
      actualPhysicalSha,
      storedBytes.byteLength,
      actualLogicalSha,
      logicalBytes.byteLength,
      logicalBytes
    );
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

  function normalizePackagePath(value) {
    var path = cleanString(value).replace(/\\/g, '/').replace(/\/+$/g, '');
    var prefix = PACKAGE_ROOT + '/';
    if (path.indexOf(prefix) !== 0 || path.indexOf('/', prefix.length) >= 0 || !/\.h2ochat$/.test(path)) {
      throw codecError('saved-chat-member-path-out-of-scope', 'package path is outside the governed app-owned archive root');
    }
    return path;
  }

  function normalizeMemberPath(value) {
    var path = cleanString(value);
    var parts = path.split('/');
    if (!path || path.charAt(0) === '/' || path.indexOf('\\') >= 0 || path.indexOf(':') >= 0 ||
        parts.some(function (part) { return !part || part === '.' || part === '..'; })) {
      throw codecError('saved-chat-member-path-out-of-scope', 'member path is not a governed package-relative path');
    }
    return path;
  }

  async function readBoundedPackageMemberBytes(options) {
    var opts = safeObject(options);
    var packagePath = normalizePackagePath(opts.packagePath);
    var memberPath = normalizeMemberPath(opts.memberPath);
    var physicalByteCap = requireByteCap(
      opts.physicalByteCap,
      'saved-chat-member-invalid-cap',
      'physical byte cap'
    );
    var fullPath = packagePath + '/' + memberPath;
    var invoke = getInvoke();
    if (!invoke) throw codecError('saved-chat-member-read-unavailable', 'Tauri filesystem invoke is unavailable');

    var metadata;
    try {
      metadata = await invoke('plugin:fs|lstat', { path: fullPath, options: { baseDir: APP_LOCAL_DATA } });
    } catch (_) {
      throw codecError('saved-chat-member-read-failed', 'package member metadata read failed');
    }
    if (!metadata || metadata.isSymlink || !metadata.isFile) {
      throw codecError('saved-chat-member-invalid-file-type', 'package member must be a regular non-symlink file');
    }
    var metadataSize = requireByteLength(
      metadata.size,
      'saved-chat-member-read-failed',
      'package member metadata size'
    );
    if (metadataSize > physicalByteCap) {
      throw codecError('saved-chat-member-physical-input-exceeds-cap', 'stored member exceeds its governed physical cap', {
        physicalByteCap: physicalByteCap,
        metadataByteLength: metadataSize,
      });
    }
    var storedBytes;
    try {
      storedBytes = normalizeBytes(await invoke('plugin:fs|read_file', {
        path: fullPath,
        options: { baseDir: APP_LOCAL_DATA },
      }));
    } catch (_) {
      throw codecError('saved-chat-member-read-failed', 'package member byte read failed');
    }
    if (storedBytes.byteLength > physicalByteCap) {
      throw codecError('saved-chat-member-physical-input-exceeds-cap', 'returned member bytes exceed the governed physical cap', {
        physicalByteCap: physicalByteCap,
        actualByteLength: storedBytes.byteLength,
      });
    }
    if (storedBytes.byteLength !== metadataSize) {
      throw codecError('saved-chat-member-physical-size-mismatch', 'returned member byteLength does not match its metadata', {
        metadataByteLength: metadataSize,
        actualByteLength: storedBytes.byteLength,
      });
    }
    return Object.freeze({
      path: memberPath,
      storedBytes: copyBytes(storedBytes),
      physicalSha256: await sha256PrefixedBytes(storedBytes),
      physicalByteLength: storedBytes.byteLength,
    });
  }

  async function readVerifiedPackageMember(options) {
    var opts = safeObject(options);
    var descriptor = safeObject(opts.descriptor);
    var expectedPath = cleanString(opts.expectedPath);
    var descriptorPath = validateExpectedPath(descriptor, expectedPath);
    var physicalByteCap = requireByteCap(
      opts.physicalByteCap,
      'saved-chat-member-invalid-cap',
      'physical byte cap'
    );
    var logicalByteCap = governedLogicalByteCap(opts.logicalByteCap);
    var bounded = await readBoundedPackageMemberBytes({
      packagePath: opts.packagePath,
      memberPath: descriptorPath,
      physicalByteCap: physicalByteCap,
    });
    return verifyPackageMemberBytes({
      storedBytes: bounded.storedBytes,
      descriptor: descriptor,
      expectedPath: descriptorPath,
      physicalByteCap: physicalByteCap,
      logicalByteCap: logicalByteCap,
    });
  }

  H2O.Studio.ingestion = Object.assign({}, H2O.Studio.ingestion, {
    savedChatPackageCodec: Object.freeze({
      __installed: true,
      __version: MODULE_VERSION,
      LOGICAL_SNAPSHOT_CAP_BYTES: LOGICAL_SNAPSHOT_CAP_BYTES,
      gzipEncodeBytes: gzipEncodeBytes,
      decodeGzipBounded: decodeGzipBounded,
      sha256PrefixedBytes: sha256PrefixedBytes,
      verifyPackageMemberBytes: verifyPackageMemberBytes,
      readBoundedPackageMemberBytes: readBoundedPackageMemberBytes,
      readVerifiedPackageMember: readVerifiedPackageMember,
      diagnose: function () {
        return {
          installed: true,
          version: MODULE_VERSION,
          encodings: [IDENTITY_ENCODING, GZIP_ENCODING],
          nativeGzip: true,
          memberVerificationOnly: true,
          packageContentHashVerified: false,
          writerSelectionActive: false,
          readerMigrationActive: false,
        };
      },
    }),
  });
})(typeof window !== 'undefined' ? window : globalThis);
