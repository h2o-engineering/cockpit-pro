/* H2O Studio — trusted portable package verification client (Desktop / Tauri)
 *
 * M10 P3.6a. A THIN client over the native portable verification session. It
 * carries bytes and nothing else.
 *
 * Package validity is decided entirely by trusted Rust, which runs the SAME
 * semantic verifier the archive path already trusts. This module therefore:
 *   - computes no hash, and no contentHash;
 *   - parses no manifest and reads no snapshot;
 *   - decides nothing about families, versions, encodings or renderers;
 *   - has no Inspector, Health or archive-integrity dependency;
 *   - has NO fallback to the legacy JS verifier. If the trusted read is
 *     unavailable the caller fails closed, because a weaker second opinion is
 *     exactly what P3.6 exists to remove.
 *
 * ZIP parsing stays on the JS side: the caller hands over already-extracted
 * member bytes. The native side re-derives every identity fact it uses and
 * never trusts this normalization.
 *
 * Session shape: begin -> declare(member, length) -> write chunk xN -> finish.
 * Members may interleave; a member is complete when its accumulated length
 * equals what was declared, so there is no end-member call. `abort` runs in a
 * finally so an abandoned upload never holds the single session slot.
 *
 * Public API (H2O.Studio.ingestion):
 *   verifySavedChatPortablePackageV1({ packageDirName, members }) -> Promise<result>
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
  if (H2O.Studio.ingestion.verifySavedChatPortablePackageV1) return;

  var MODULE_VERSION = '1.0.0-m10-p3-6a';
  var SCHEMA = 'h2o.savedChatPortablePackageVerification';
  var SCHEMA_VERSION = 1;

  var BEGIN_COMMAND = 'h2o_saved_chat_portable_verify_begin';
  var DECLARE_COMMAND = 'h2o_saved_chat_portable_verify_declare';
  var WRITE_COMMAND = 'h2o_saved_chat_portable_verify_write';
  var FINISH_COMMAND = 'h2o_saved_chat_portable_verify_finish';
  var ABORT_COMMAND = 'h2o_saved_chat_portable_verify_abort';

  /* Transport chunk only — not a member or package ceiling. The trusted side
   * owns every real limit and re-checks this one. */
  var CHUNK_BYTES = 4 * 1024 * 1024;

  /* Client-side failure vocabulary. Distinct from native refusal codes so a
   * transport problem can never be read as a semantic verdict. */
  var CODES = {
    TRANSPORT_UNAVAILABLE: 'portable-verify-transport-unavailable',
    COMMAND_FAILED: 'portable-verify-command-failed',
    SESSION_REFUSED: 'portable-verify-session-refused',
    MEMBER_REFUSED: 'portable-verify-member-refused',
    SCHEMA_MISMATCH: 'portable-verify-schema-mismatch',
    SCHEMA_VERSION_UNSUPPORTED: 'portable-verify-schema-version-unsupported',
    ENVELOPE_MALFORMED: 'portable-verify-envelope-malformed',
  };

  function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function cleanString(value) { return String(value == null ? '' : value).trim(); }

  function clientError(code, message, cause) {
    var error = new Error('[portable-verify] ' + message);
    error.name = 'SavedChatPortableVerificationError';
    error.code = code;
    if (cause !== undefined) error.cause = cause;
    return error;
  }

  function getInvoke() {
    try {
      var internals = global.__TAURI_INTERNALS__;
      if (internals && typeof internals.invoke === 'function') return internals.invoke;
      var legacy = global.__TAURI__;
      if (legacy && typeof legacy.invoke === 'function') return legacy.invoke;
    } catch (_) { /* ignore */ }
    return null;
  }

  function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value && value.buffer instanceof ArrayBuffer) {
      return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
    }
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (Array.isArray(value)) return Uint8Array.from(value);
    throw clientError(CODES.ENVELOPE_MALFORMED, 'member bytes must be binary');
  }

  /* The result is validated as a CONTRACT, not merely read: an unrecognised
   * schema or version must fail closed rather than be interpreted optimistically. */
  function assertResult(payload) {
    if (!isObject(payload)) {
      throw clientError(CODES.ENVELOPE_MALFORMED, 'verification result must be an object');
    }
    if (payload.schema !== SCHEMA) {
      throw clientError(
        CODES.SCHEMA_MISMATCH,
        'expected schema ' + SCHEMA + ', received ' + String(payload.schema),
      );
    }
    if (payload.schemaVersion !== SCHEMA_VERSION) {
      throw clientError(
        CODES.SCHEMA_VERSION_UNSUPPORTED,
        'unsupported schemaVersion ' + String(payload.schemaVersion),
      );
    }
    if (typeof payload.verified !== 'boolean') {
      throw clientError(CODES.ENVELOPE_MALFORMED, '`verified` must be stated as a boolean');
    }
    if (payload.verified === false && !isObject(payload.refusal)) {
      throw clientError(CODES.ENVELOPE_MALFORMED, 'a refusal must say why');
    }
    if (payload.verified === true && !cleanString(payload.contentHash)) {
      throw clientError(CODES.ENVELOPE_MALFORMED, 'a verified result must carry contentHash');
    }
    return payload;
  }

  async function callCommand(invoke, command, options) {
    try {
      return await invoke(command, { options: options });
    } catch (err) {
      throw clientError(CODES.COMMAND_FAILED, command + ' failed: ' + String((err && err.message) || err), err);
    }
  }

  async function writeMember(invoke, token, member, bytes) {
    var offset = 0;
    /* An empty member is still written once, so the trusted side sees it
     * complete rather than underrun. */
    do {
      var end = Math.min(offset + CHUNK_BYTES, bytes.length);
      var ack;
      try {
        ack = await invoke(WRITE_COMMAND, bytes.subarray(offset, end), {
          headers: { options: JSON.stringify({ token: token, member: member }) },
        });
      } catch (err) {
        throw clientError(CODES.COMMAND_FAILED, 'member write failed: ' + String((err && err.message) || err), err);
      }
      if (!ack || ack.ok !== true) {
        throw clientError(
          CODES.MEMBER_REFUSED,
          'member ' + member + ' refused: ' + cleanString(ack && ack.code),
        );
      }
      offset = end;
    } while (offset < bytes.length);
  }

  /* members: { manifest, snapshot, markdown, html, assets: [{ key, bytes }] }
   * where every value is raw bytes already extracted from the portable
   * container. `key` is the native member key, `asset:sha256-<hex>.<ext>`.
   *
   * `unexpectedMembers` names persistent container entries OUTSIDE the canonical
   * inventory. Because the container is parsed here and not natively, this list
   * is the only way the trusted side can learn they exist — and it can only make
   * the verdict stricter, since a non-empty list is an outright refusal. */
  async function verifySavedChatPortablePackageV1(options) {
    var opts = isObject(options) ? options : {};
    var packageDirName = cleanString(opts.packageDirName);
    var members = isObject(opts.members) ? opts.members : {};
    var unexpectedMembers = (Array.isArray(opts.unexpectedMembers) ? opts.unexpectedMembers : [])
      .map(cleanString).filter(Boolean);

    var invoke = getInvoke();
    if (!invoke) {
      throw clientError(CODES.TRANSPORT_UNAVAILABLE, 'Tauri invoke is unavailable');
    }

    var queue = [];
    ['manifest', 'snapshot', 'markdown', 'html'].forEach(function (name) {
      if (members[name] != null) queue.push({ key: name, bytes: toBytes(members[name]) });
    });
    (Array.isArray(members.assets) ? members.assets : []).forEach(function (asset) {
      var entry = isObject(asset) ? asset : {};
      queue.push({ key: cleanString(entry.key), bytes: toBytes(entry.bytes) });
    });

    var begun = await callCommand(invoke, BEGIN_COMMAND, {
      packageDirName: packageDirName,
      unexpectedMembers: unexpectedMembers,
    });
    if (!begun || begun.ok !== true || begun.token == null) {
      throw clientError(
        CODES.SESSION_REFUSED,
        'verification session refused: ' + cleanString(begun && begun.code),
      );
    }
    var token = begun.token;
    var finished = false;
    try {
      for (var i = 0; i < queue.length; i += 1) {
        var member = queue[i];
        var declared = await callCommand(invoke, DECLARE_COMMAND, {
          token: token,
          member: member.key,
          expectedLength: member.bytes.length,
        });
        if (!declared || declared.ok !== true) {
          throw clientError(
            CODES.MEMBER_REFUSED,
            'member ' + member.key + ' refused: ' + cleanString(declared && declared.code),
          );
        }
        await writeMember(invoke, token, member.key, member.bytes);
      }
      var result = assertResult(await callCommand(invoke, FINISH_COMMAND, { token: token }));
      /* finish destroys the session natively; aborting afterwards would be a
       * no-op, but saying so here keeps the finally honest. */
      finished = true;
      return result;
    } finally {
      if (!finished) {
        /* Abandoned uploads must not hold the single session slot. Abort is
         * idempotent, so a best-effort call is always safe. */
        try { await invoke(ABORT_COMMAND, { options: { token: token } }); } catch (_) { /* ignore */ }
      }
    }
  }

  H2O.Studio.ingestion.verifySavedChatPortablePackageV1 = verifySavedChatPortablePackageV1;
  H2O.Studio.ingestion.SAVED_CHAT_PORTABLE_VERIFICATION_CODES = CODES;
  H2O.Studio.ingestion.SAVED_CHAT_PORTABLE_VERIFICATION_CONTRACT = Object.freeze({
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    version: MODULE_VERSION,
    commands: Object.freeze([
      BEGIN_COMMAND, DECLARE_COMMAND, WRITE_COMMAND, FINISH_COMMAND, ABORT_COMMAND,
    ]),
    chunkBytes: CHUNK_BYTES,
    ownsVerification: false,
    ownsContentHash: false,
    hasLegacyFallback: false,
  });
})(typeof window !== 'undefined' ? window : globalThis);
