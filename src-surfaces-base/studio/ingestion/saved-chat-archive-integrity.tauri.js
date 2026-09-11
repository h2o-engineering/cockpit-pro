/* H2O Studio — trusted Saved-Chat archive integrity client (M10 P3a)
 *
 * The thinnest possible bridge to the accepted P1 trusted authority:
 *
 *   h2o_saved_chat_archive_integrity  ->  h2o.savedChatArchiveIntegrity v1
 *
 * It resolves the Tauri invoke, calls the command, checks just enough of the
 * transport contract to FAIL CLOSED, and returns the trusted envelope
 * unchanged. It reclassifies nothing.
 *
 * It performs NO package hashing, manifest/snapshot parsing, gzip verification,
 * contentHash derivation, package discovery, integrity severity logic,
 * filesystem read, package-byte read or mutation. Every one of those already
 * has a trusted owner on the Rust side.
 *
 * Failure is an EXCEPTION, never a health verdict: malformed or missing trusted
 * data is thrown, never normalized, never defaulted, and never mapped to a
 * healthy result. `complete === false` is NOT a failure — it is a valid trusted
 * envelope that the presentation mapper turns into "Partial scan".
 *
 * Public API (H2O.Studio.ingestion):
 *   readSavedChatArchiveIntegrityV1() -> Promise<envelope>
 *   SAVED_CHAT_ARCHIVE_INTEGRITY_CODES
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.ingestion = H2O.Studio.ingestion || {};
  if (H2O.Studio.ingestion.readSavedChatArchiveIntegrityV1) return;

  var MODULE_VERSION = '0.1.0-m10-p3a';

  var COMMAND = 'h2o_saved_chat_archive_integrity';
  var SCHEMA = 'h2o.savedChatArchiveIntegrity';
  var SCHEMA_VERSION = 1;

  /* Transport/contract failure codes. They describe how the TRUSTED READ
   * failed — never a health state, which only the mapper may express. */
  var CODES = Object.freeze({
    TRANSPORT_UNAVAILABLE: 'integrity-client-transport-unavailable',
    COMMAND_FAILED: 'integrity-client-command-failed',
    SCHEMA_MISMATCH: 'integrity-client-schema-mismatch',
    SCHEMA_VERSION_UNSUPPORTED: 'integrity-client-schema-version-unsupported',
    ENVELOPE_INCOMPLETE: 'integrity-client-envelope-incomplete',
    ENVELOPE_MALFORMED: 'integrity-client-envelope-malformed',
  });

  function clientError(code, message, cause) {
    var error = new Error('[' + code + '] ' + message);
    error.name = 'SavedChatArchiveIntegrityClientError';
    error.code = code;
    if (cause !== undefined) error.cause = cause;
    return error;
  }

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
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

  /* Enough of the contract to know the payload IS the trusted envelope. It
   * deliberately does not re-validate what Rust already guarantees; it refuses
   * anything whose shape would let a caller misread it. */
  function assertEnvelope(payload) {
    if (!isObject(payload)) {
      throw clientError(CODES.ENVELOPE_MALFORMED, 'trusted result is not an object');
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
    /* `complete` must be STATED. A missing or non-boolean value is refused
     * rather than assumed true — assuming completeness is how an incomplete
     * scan becomes a false "nothing is here". */
    if (typeof payload.complete !== 'boolean') {
      throw clientError(CODES.ENVELOPE_INCOMPLETE, '`complete` must be a boolean');
    }
    if (!Array.isArray(payload.occupants)) {
      throw clientError(CODES.ENVELOPE_MALFORMED, '`occupants` must be an array');
    }
    if (!Array.isArray(payload.blockers)) {
      throw clientError(CODES.ENVELOPE_MALFORMED, '`blockers` must be an array');
    }
    for (var i = 0; i < payload.occupants.length; i += 1) {
      var occupant = payload.occupants[i];
      if (!isObject(occupant) || typeof occupant.class !== 'string' || !occupant.class) {
        throw clientError(CODES.ENVELOPE_MALFORMED, 'occupant ' + i + ' is missing a trusted class');
      }
      if (typeof occupant.path !== 'string' || !occupant.path) {
        throw clientError(CODES.ENVELOPE_MALFORMED, 'occupant ' + i + ' is missing a path');
      }
    }
    return payload;
  }

  /* Read the trusted archive integrity envelope. The renderer supplies nothing:
   * the canonical archive root is derived by trusted native code. */
  async function readSavedChatArchiveIntegrityV1() {
    var invoke = getInvoke();
    if (!invoke) {
      throw clientError(CODES.TRANSPORT_UNAVAILABLE, 'Tauri invoke is unavailable');
    }
    var payload;
    try {
      payload = await invoke(COMMAND);
    } catch (err) {
      throw clientError(
        CODES.COMMAND_FAILED,
        String((err && err.message) || err),
        err,
      );
    }
    return assertEnvelope(payload);
  }

  H2O.Studio.ingestion.readSavedChatArchiveIntegrityV1 = readSavedChatArchiveIntegrityV1;
  H2O.Studio.ingestion.SAVED_CHAT_ARCHIVE_INTEGRITY_CODES = CODES;
  H2O.Studio.ingestion.SAVED_CHAT_ARCHIVE_INTEGRITY_CONTRACT = Object.freeze({
    command: COMMAND,
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    moduleVersion: MODULE_VERSION,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
