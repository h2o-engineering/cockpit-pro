/*
 * Confined Chrome File System Access write port for P02 writer transport.
 *
 * The caller supplies the already-persisted container handle. This adapter
 * never opens a picker, requests permission, accepts a path from a page, or
 * exposes a general filesystem API. Every path must match the closed P02
 * repository grammar (or its same-directory temporary form), and every handle
 * is derived below the fixed h2o-object-sync child.
 */
import {
  P02_FSA_REPOSITORY_CHILD,
  P02_FSA_REPOSITORY_READS
} from './sync-fsa-read-transport-v2.mjs';

export const P02_FSA_WRITE_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncFsaWriteTransport.p02.v1',
  GENERATION_SCHEMA: 'h2o.studio.syncWriterGeneration.p02.v1'
});

export const P02_FSA_WRITE_ERROR = Object.freeze({
  DEPENDENCY_INVALID: 'p02-fsa-write-dependency-invalid',
  PATH_REFUSED: 'p02-fsa-write-path-refused',
  PERMISSION_BLOCKED: 'p02-fsa-write-permission-blocked',
  HANDLE_INVALID: 'p02-fsa-write-handle-invalid',
  WRITE_FAILED: 'p02-fsa-write-failed',
  ATOMIC_PROMOTION_UNAVAILABLE: 'p02-fsa-write-atomic-promotion-unavailable',
  READBACK_MISMATCH: 'p02-fsa-write-readback-mismatch',
  GENERATION_INVALID: 'p02-fsa-write-generation-invalid',
  GENERATION_CONFLICT: 'p02-fsa-write-generation-conflict'
});

export class P02FsaWriteError extends Error {
  constructor(code) { super(code); this.name = 'P02FsaWriteError'; this.code = code; }
}

const HEX64 = /^[0-9a-f]{64}$/;
const TEMP_SUFFIX = /\.pending-[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const fail = (code) => { throw new P02FsaWriteError(code); };

function acceptedPath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') ||
      path.includes('\\') || path.split('/').some((part) =>
        !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f]/.test(part))) {
    return false;
  }
  const final = path.replace(TEMP_SUFFIX, '');
  return P02_FSA_REPOSITORY_READS.some(({ pattern }) => pattern.test(final));
}

function bytesEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) ||
      left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function permission(handle) {
  let value;
  try { value = await handle.queryPermission({ mode: 'readwrite' }); }
  catch (_) { fail(P02_FSA_WRITE_ERROR.PERMISSION_BLOCKED); }
  if (value !== 'granted') fail(P02_FSA_WRITE_ERROR.PERMISSION_BLOCKED);
}

async function directory(root, names, create, missingAllowed = false) {
  let cursor = root;
  for (const name of names) {
    let next;
    try { next = await cursor.getDirectoryHandle(name, { create }); }
    catch (error) {
      if (missingAllowed &&
          (error?.name === 'NotFoundError' || error?.code === 'ENOENT')) return null;
      fail(P02_FSA_WRITE_ERROR.WRITE_FAILED);
    }
    if (!next || next.kind !== 'directory') fail(P02_FSA_WRITE_ERROR.HANDLE_INVALID);
    cursor = next;
  }
  return cursor;
}

async function readFile(parent, name) {
  let handle;
  try { handle = await parent.getFileHandle(name, { create: false }); }
  catch (error) {
    if (error?.name === 'NotFoundError' || error?.code === 'ENOENT') return null;
    fail(P02_FSA_WRITE_ERROR.WRITE_FAILED);
  }
  if (!handle || handle.kind !== 'file') fail(P02_FSA_WRITE_ERROR.HANDLE_INVALID);
  try { return new Uint8Array(await (await handle.getFile()).arrayBuffer()); }
  catch (_) { fail(P02_FSA_WRITE_ERROR.WRITE_FAILED); }
}

async function requireResolved(root, handle, expected) {
  let resolved;
  try { resolved = await root.resolve(handle); }
  catch (_) { fail(P02_FSA_WRITE_ERROR.HANDLE_INVALID); }
  if (!Array.isArray(resolved) || resolved.length !== expected.length ||
      resolved.some((part, index) => part !== expected[index])) {
    /* A null/different resolution includes an out-of-root symlink target. */
    fail(P02_FSA_WRITE_ERROR.HANDLE_INVALID);
  }
}

export function createChromeFsaWriteTransport({
  containerHandle,
  cryptoImplementation = globalThis.crypto
} = {}) {
  if (!containerHandle || containerHandle.kind !== 'directory' ||
      typeof containerHandle.queryPermission !== 'function' ||
      typeof containerHandle.getDirectoryHandle !== 'function' ||
      typeof containerHandle.resolve !== 'function') {
    fail(P02_FSA_WRITE_ERROR.DEPENDENCY_INVALID);
  }

  async function root(create = false, missingAllowed = false) {
    await permission(containerHandle);
    const repository = await directory(
      containerHandle, [P02_FSA_REPOSITORY_CHILD], create, missingAllowed);
    if (repository !== null) {
      await requireResolved(
        containerHandle, repository, [P02_FSA_REPOSITORY_CHILD]);
    }
    return repository;
  }

  async function locate(relativePath, createDirectories = false, missingAllowed = false) {
    if (!acceptedPath(relativePath)) fail(P02_FSA_WRITE_ERROR.PATH_REFUSED);
    const parts = relativePath.split('/');
    const name = parts.pop();
    const repository = await root(createDirectories, missingAllowed);
    if (repository === null) return null;
    const parent = await directory(
      repository, parts, createDirectories, missingAllowed);
    if (parent !== null) await requireResolved(repository, parent, parts);
    return parent === null ? null : { parent, name };
  }

  const storage = Object.freeze({
    async read(relativePath) {
      const located = await locate(relativePath, false, true);
      if (located === null) return null;
      const { parent, name } = located;
      return readFile(parent, name);
    },
    async writeTemporary(relativePath, input) {
      if (!TEMP_SUFFIX.test(relativePath) || !(input instanceof Uint8Array)) {
        fail(P02_FSA_WRITE_ERROR.PATH_REFUSED);
      }
      const { parent, name } = await locate(relativePath, true);
      let handle;
      try { handle = await parent.getFileHandle(name, { create: true }); }
      catch (_) { fail(P02_FSA_WRITE_ERROR.WRITE_FAILED); }
      if (!handle || handle.kind !== 'file') fail(P02_FSA_WRITE_ERROR.HANDLE_INVALID);
      await requireResolved(
        await root(false), handle, [...relativePath.split('/')]);
      let writable;
      try {
        writable = await handle.createWritable({ keepExistingData: false });
        await writable.write(input);
        await writable.close();
      } catch (_) {
        try { await writable?.abort?.(); } catch (_) { /* best effort */ }
        fail(P02_FSA_WRITE_ERROR.WRITE_FAILED);
      }
      const readback = await readFile(parent, name);
      if (!bytesEqual(readback, input)) fail(P02_FSA_WRITE_ERROR.READBACK_MISMATCH);
    },
    async readTemporary(relativePath) {
      if (!TEMP_SUFFIX.test(relativePath)) fail(P02_FSA_WRITE_ERROR.PATH_REFUSED);
      const { parent, name } = await locate(relativePath, false);
      const bytes = await readFile(parent, name);
      if (bytes === null) fail(P02_FSA_WRITE_ERROR.READBACK_MISMATCH);
      return bytes;
    },
    async promoteTemporary(pendingPath, finalPath, { replaceExisting = false } = {}) {
      if (!TEMP_SUFFIX.test(pendingPath) || !acceptedPath(finalPath) ||
          pendingPath.replace(TEMP_SUFFIX, '') !== finalPath) {
        fail(P02_FSA_WRITE_ERROR.PATH_REFUSED);
      }
      const pending = await locate(pendingPath, false);
      const destination = await locate(finalPath, true);
      if (pending.parent !== destination.parent) {
        /* Handles are derived twice, so object identity is not portable. The
         * path check above is the authoritative same-directory proof. */
      }
      const source = await pending.parent.getFileHandle(pending.name, { create: false });
      if (!source || source.kind !== 'file' || typeof source.move !== 'function') {
        fail(P02_FSA_WRITE_ERROR.ATOMIC_PROMOTION_UNAVAILABLE);
      }
      if (!replaceExisting && await readFile(destination.parent, destination.name) !== null) {
        fail(P02_FSA_WRITE_ERROR.WRITE_FAILED);
      }
      try { await source.move(destination.parent, destination.name); }
      catch (_) { fail(P02_FSA_WRITE_ERROR.WRITE_FAILED); }
      if (await readFile(destination.parent, destination.name) === null) {
        fail(P02_FSA_WRITE_ERROR.READBACK_MISMATCH);
      }
    }
  });

  async function ensureWriterGeneration({ writerKey, record }) {
    if (!HEX64.test(writerKey || '') || !record ||
        record.schema !== P02_FSA_WRITE_V2.GENERATION_SCHEMA ||
        record.generation !== 'p02' || record.writerKey !== writerKey) {
      fail(P02_FSA_WRITE_ERROR.GENERATION_INVALID);
    }
    const path = `writers/${writerKey}/generation.json`;
    const proposed = encoder.encode(JSON.stringify(record));
    const existing = await storage.read(path);
    if (existing !== null) {
      let parsed;
      try { parsed = JSON.parse(decoder.decode(existing)); }
      catch (_) { fail(P02_FSA_WRITE_ERROR.GENERATION_INVALID); }
      if (parsed?.schema !== P02_FSA_WRITE_V2.GENERATION_SCHEMA ||
          parsed?.generation !== 'p02' || parsed?.writerKey !== writerKey) {
        fail(P02_FSA_WRITE_ERROR.GENERATION_CONFLICT);
      }
      return Object.freeze({ initialized: false, verified: true, record: parsed });
    }
    if (typeof cryptoImplementation?.subtle?.digest !== 'function') {
      fail(P02_FSA_WRITE_ERROR.DEPENDENCY_INVALID);
    }
    const digest = new Uint8Array(
      await cryptoImplementation.subtle.digest('SHA-256', proposed));
    const identity = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const temporary = `${path}.pending-${identity}`;
    await storage.writeTemporary(temporary, proposed);
    await storage.promoteTemporary(temporary, path, { replaceExisting: false });
    const readback = await storage.read(path);
    if (!bytesEqual(readback, proposed)) fail(P02_FSA_WRITE_ERROR.READBACK_MISMATCH);
    return Object.freeze({ initialized: true, verified: true, record });
  }

  return Object.freeze({ schema: P02_FSA_WRITE_V2.SCHEMA, storage, ensureWriterGeneration });
}
