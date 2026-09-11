/*
 * P02 V8-B — Desktop local-folder storage adapter for the generic v2 writer.
 *
 * This is the injected `storage` object that `sync-writer-transport-v2.mjs`
 * (Z4) expects, and nothing more. It owns no protocol logic: create-or-verify
 * semantics, pointer replacement, hash verification, temporary naming, phase
 * ordering and collision classification all stay in Z4, exactly where they are
 * today. Every path it receives was derived by Z4 from the frozen §J.1 layout.
 *
 * It carries opaque bytes, so it is object-domain agnostic: a future chat-note,
 * folder, label, tag or category domain uses this adapter unchanged.
 *
 * Filesystem authority stays native. This module holds no path, no root and no
 * handle - it forwards to four narrow scoped commands, and the Rust side
 * re-derives the resolver-authorized repository on every call. There is no
 * general-purpose file write available to the webview through this surface.
 *
 * Importing this module has no side effect and starts nothing: V8-C composes it.
 */

export const P02_DESKTOP_WRITER_STORAGE = Object.freeze({
  SCHEMA: 'h2o.studio.syncWriterStorageLocal.p02.v1',
  COMMAND: Object.freeze({
    READ: 'h2o_p02_storage_read',
    WRITE_TEMPORARY: 'h2o_p02_storage_write_temporary',
    READ_TEMPORARY: 'h2o_p02_storage_read_temporary',
    PROMOTE_TEMPORARY: 'h2o_p02_storage_promote_temporary'
  })
});

export const P02_DESKTOP_WRITER_STORAGE_ERROR = Object.freeze({
  RUNTIME_UNAVAILABLE: 'p02-v8b-desktop-storage-runtime-unavailable',
  CAPABILITY_REQUIRED: 'p02-v8b-desktop-storage-capability-required',
  RESULT_INVALID: 'p02-v8b-desktop-storage-result-invalid',
  BYTES_INVALID: 'p02-v8b-desktop-storage-bytes-invalid'
});

export class P02DesktopWriterStorageError extends Error {
  constructor(code) {
    super(code);
    this.name = 'P02DesktopWriterStorageError';
    this.code = code;
  }
}

function fail(code) {
  throw new P02DesktopWriterStorageError(code);
}

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes) {
  if (!(bytes instanceof Uint8Array)) fail(P02_DESKTOP_WRITER_STORAGE_ERROR.BYTES_INVALID);
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index];
    const b1 = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const b2 = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const value = (b0 << 16) | (b1 << 8) | b2;
    output += BASE64_ALPHABET[(value >> 18) & 63];
    output += BASE64_ALPHABET[(value >> 12) & 63];
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(value >> 6) & 63] : '=';
    output += index + 2 < bytes.length ? BASE64_ALPHABET[value & 63] : '=';
  }
  return output;
}

function fromBase64(value) {
  if (typeof value !== 'string' || value.length % 4 !== 0) {
    fail(P02_DESKTOP_WRITER_STORAGE_ERROR.RESULT_INVALID);
  }
  const clean = value.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let cursor = 0;
  for (const character of clean) {
    const index = BASE64_ALPHABET.indexOf(character);
    if (index < 0) fail(P02_DESKTOP_WRITER_STORAGE_ERROR.RESULT_INVALID);
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[cursor] = (buffer >> bits) & 0xff;
      cursor += 1;
    }
  }
  return bytes.subarray(0, cursor);
}

function readResultBytes(result) {
  if (!result || typeof result !== 'object' ||
      result.schema !== P02_DESKTOP_WRITER_STORAGE.SCHEMA) {
    fail(P02_DESKTOP_WRITER_STORAGE_ERROR.RESULT_INVALID);
  }
  if (result.present !== true) return null;
  const bytes = fromBase64(result.base64);
  if (bytes.length !== result.byteLength) {
    fail(P02_DESKTOP_WRITER_STORAGE_ERROR.RESULT_INVALID);
  }
  return bytes;
}

/*
 * Build the Z4-compatible storage object.
 *
 * `invoke` is injected rather than detected so the adapter holds no ambient
 * authority. `capability` is the ephemeral governed publication lease: it is
 * captured in this closure and attached to every mutating request, so Z4 never
 * learns about H2O campaign governance and its injected-storage contract stays
 * exactly read / writeTemporary / readTemporary / promoteTemporary.
 *
 * Omitting the capability yields a read-only storage object: reads still work,
 * and any mutation fails here before it can reach the native command.
 */
export function createDesktopLocalWriterStorage({ invoke, capability = null } = {}) {
  if (typeof invoke !== 'function') {
    fail(P02_DESKTOP_WRITER_STORAGE_ERROR.RUNTIME_UNAVAILABLE);
  }
  if (capability !== null && (typeof capability !== 'string' || !/^[0-9a-f]{64}$/.test(capability))) {
    fail(P02_DESKTOP_WRITER_STORAGE_ERROR.CAPABILITY_REQUIRED);
  }
  const requireCapability = () => {
    if (capability === null) fail(P02_DESKTOP_WRITER_STORAGE_ERROR.CAPABILITY_REQUIRED);
    return capability;
  };
  const { COMMAND } = P02_DESKTOP_WRITER_STORAGE;

  return Object.freeze({
    /* Z4 treats null as "absent"; anything else must be exact bytes. */
    async read(relativePath) {
      return readResultBytes(await invoke(COMMAND.READ, { relativePath }));
    },
    async writeTemporary(relativePath, bytes) {
      await invoke(COMMAND.WRITE_TEMPORARY, {
        relativePath,
        base64: toBase64(bytes),
        capability: requireCapability()
      });
    },
    async readTemporary(relativePath) {
      const bytes = readResultBytes(
        await invoke(COMMAND.READ_TEMPORARY, { relativePath })
      );
      if (bytes === null) fail(P02_DESKTOP_WRITER_STORAGE_ERROR.RESULT_INVALID);
      return bytes;
    },
    /* `replaceExisting` is Z4's distinction: false for immutable documents,
     * true only for the mutable writer pointer. The native side enforces it. */
    async promoteTemporary(pendingPath, finalPath, { replaceExisting = false } = {}) {
      await invoke(COMMAND.PROMOTE_TEMPORARY, {
        pendingPath,
        finalPath,
        replaceExisting: replaceExisting === true,
        capability: requireCapability()
      });
    }
  });
}

export { toBase64 as encodeStorageBytes, fromBase64 as decodeStorageBytes };
