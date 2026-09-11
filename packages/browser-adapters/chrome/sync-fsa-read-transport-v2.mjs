/*
 * O1-T11 — read-only File System Access port.
 *
 * The receive side needs to fetch bytes at a content address from a folder the
 * user granted. That is all this does. There is no write path here - not a
 * disabled one, not a guarded one, not one behind a capability flag. A module
 * that cannot write is a stronger guarantee than a module that chooses not to,
 * and the receive foundation genuinely does not need one.
 *
 * PERMISSION IS A FIRST-CLASS OUTCOME, NOT AN ERROR. A folder the user has not
 * granted, or has revoked, produces `blocked(permission)` - the scheduler's
 * existing block class - so the object waits for an operator action instead of
 * being retried on a timer forever. Permission is deliberately QUERIED and
 * never requested: a background pass must not raise a picker.
 *
 * ABSENCE IS NOT FAILURE. A revision that is not there yet is a normal state in
 * a folder that syncs in the background, and it is reported as `absent` so the
 * caller can wait rather than quarantine. Only bytes that are present and wrong
 * are an integrity problem.
 *
 * ADDRESSES ARE VERIFIED, NEVER TRUSTED. The content address is re-derived from
 * the bytes read. A file whose name says one hash and whose contents say
 * another is exactly what an untrusted folder can contain.
 */

export const P02_FSA_READ_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncFsaReadTransport.p02.v1',
  /* Matches deriveRevisionPath in the writer transport. */
  revisionPath: (objectKey, revisionBlobSha256) =>
    ['objects', objectKey, 'revisions', `${revisionBlobSha256}.json`]
});

export const P02_FSA_READ_STATUS = Object.freeze({
  VERIFIED: 'verified',
  /* Not there. A normal state, not a failure. */
  ABSENT: 'absent',
  /* Present, but the bytes do not hash to the address they were read from. */
  INTEGRITY: 'integrity',
  /* Present and readable, but not a usable document. */
  MALFORMED: 'malformed',
  /* The grant is missing or revoked. Waits for an operator, not for a timer. */
  BLOCKED_PERMISSION: 'blocked(permission)',
  /* The read failed for some other reason. Transient by default. */
  UNREADABLE: 'unreadable'
});

export const P02_FSA_READ_ERROR = Object.freeze({
  DEPENDENCY_INVALID: 'p02-fsa-read-dependency-invalid',
  ADDRESS_INVALID: 'p02-fsa-read-address-invalid',
  /* The path is not in the accepted grammar. Refused before any handle walk. */
  PATH_REFUSED: 'p02-fsa-read-path-refused',
  /* The grant is gone. Deliberately NOT expressed as absence: a caller that
   * read "file not there" from a revoked grant would conclude the repository
   * had lost content it still has. */
  PERMISSION_BLOCKED: 'p02-fsa-read-permission-blocked',
  READ_FAILED: 'p02-fsa-read-failed'
});

/*
 * The ONLY repository reads Unit W performs. This is a closed grammar, not a
 * path sanitizer: a path either matches one of these five families exactly or
 * it is refused. There is deliberately no generic filesystem capability here.
 *
 * The writer-generation record is WRITER-SCOPED - `writers/<writerKey>/
 * generation.json` - matching `require_p02_generation` in
 * `p02_steady_authority.rs` and the live campaign repository. A root-level
 * `generation.json` is not a path this product uses.
 */
export const P02_FSA_REPOSITORY_READS = Object.freeze([
  Object.freeze({ family: 'library-info', pattern: /^library\.info\.json$/ }),
  Object.freeze({
    family: 'revision',
    pattern: /^objects\/[0-9a-f]{64}\/revisions\/[0-9a-f]{64}\.json$/
  }),
  Object.freeze({ family: 'writer-state', pattern: /^writers\/[0-9a-f]{64}\/state\.json$/ }),
  Object.freeze({
    family: 'heads-snapshot',
    pattern: /^writers\/[0-9a-f]{64}\/heads\/[0-9a-f]{64}\.json$/
  }),
  Object.freeze({
    family: 'writer-generation',
    pattern: /^writers\/[0-9a-f]{64}\/generation\.json$/
  })
]);

/* Writer-root discovery is deliberately narrower than the document grammar.
 * It lists only direct directory children of the fixed writers/ root and
 * returns only valid content-addressed names. No pointer, snapshot or revision
 * is opened through this surface, so an unknown directory can be reported
 * without becoming trusted input. */
const WRITER_ROOT_NAME = /^[0-9a-f]{64}$/;

/* Container-rooted, and only these two. No arbitrary-name fallback. */
export const P02_FSA_LEGACY_ARTIFACTS = Object.freeze([
  'round2-item9-delivery.json',
  'h2o-local-publication.v1.json'
]);

/* The repository directory inside the granted container. */
export const P02_FSA_REPOSITORY_CHILD = 'h2o-object-sync';

export class P02FsaReadError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = 'P02FsaReadError';
    this.code = code;
    if (detail !== null) this.detail = detail;
  }
}

/*
 * Closed-grammar check. Rejects absolute paths, traversal, backslashes, empty
 * components and anything outside the five families - before a handle is
 * touched, so a refused path never becomes a directory walk.
 */
export function classifyRepositoryRead(path) {
  const value = typeof path === 'string' ? path : '';
  if (!value || value !== value.trim()) return null;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null;
  if (value.includes('\\')) return null;
  if (value.includes('//') || value.startsWith('./') || value.endsWith('/')) return null;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  const match = P02_FSA_REPOSITORY_READS.find((entry) => entry.pattern.test(value));
  return match ? match.family : null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const hex64 = (value) => typeof value === 'string' && HEX64.test(value);
const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

/* A NotFoundError from the FSA API is absence, not breakage. */
const isNotFound = (error) =>
  error?.name === 'NotFoundError' || clean(error?.code) === 'ENOENT';
/* A NotAllowedError / SecurityError is the grant, not the file. */
const isPermission = (error) =>
  error?.name === 'NotAllowedError' || error?.name === 'SecurityError';

export function createChromeFsaReadTransport({
  directoryHandle,
  /*
   * The GRANTED handle. Chrome persists the container, not the repository, so
   * `repositoryStorage()` descends one validated level into it while
   * `legacyArtifactStorage()` reads the two N.2 names beside it. When only
   * `directoryHandle` is supplied it keeps its original meaning - already
   * repository-rooted - so existing callers are unaffected.
   */
  containerHandle = null,
  sha256HexBytes,
  maxRevisionBytes = 5 * 1024 * 1024,
  maxDocumentBytes = 5 * 1024 * 1024
} = {}) {
  const rootHandle = isPlainObject(directoryHandle) ? directoryHandle : containerHandle;
  if (!isPlainObject(rootHandle) ||
      typeof rootHandle.getDirectoryHandle !== 'function' ||
      typeof rootHandle.getFileHandle !== 'function' ||
      typeof sha256HexBytes !== 'function') {
    fail(P02_FSA_READ_ERROR.DEPENDENCY_INVALID);
  }
  directoryHandle = rootHandle;

  /*
   * Query, never request. `queryPermission` reports the standing grant;
   * `requestPermission` would raise a prompt, which a background pass has no
   * business doing and which would fail outside a user gesture anyway.
   */
  async function permissionState() {
    if (typeof directoryHandle.queryPermission !== 'function') {
      /* No permission API at all: nothing to check, proceed and let the read
       * itself report a refusal. Assuming denial would block a platform that
       * simply does not model permissions. */
      return 'granted';
    }
    try {
      return clean(await directoryHandle.queryPermission({ mode: 'read' })) || 'denied';
    } catch (_) {
      return 'denied';
    }
  }

  async function resolveFile(segments, root = directoryHandle) {
    let handle = root;
    for (const segment of segments.slice(0, -1)) {
      handle = await handle.getDirectoryHandle(segment, { create: false });
    }
    return handle.getFileHandle(segments[segments.length - 1], { create: false });
  }

  async function readRevision({ objectKey, revisionBlobSha256 } = {}) {
    const key = clean(objectKey);
    const address = clean(revisionBlobSha256);
    if (!hex64(key) || !hex64(address)) fail(P02_FSA_READ_ERROR.ADDRESS_INVALID);

    const permission = await permissionState();
    if (permission !== 'granted') {
      return Object.freeze({
        status: P02_FSA_READ_STATUS.BLOCKED_PERMISSION,
        blockReason: 'permission',
        permission,
        revisionBlobSha256Hex: address,
        bytes: null, value: null
      });
    }

    let file;
    try {
      const handle = await resolveFile(
        P02_FSA_READ_V2.revisionPath(key, address),
        await repositoryHandle()
      );
      file = await handle.getFile();
    } catch (error) {
      if (isPermission(error)) {
        /* Revoked between the query and the read: still permission, not I/O. */
        return Object.freeze({
          status: P02_FSA_READ_STATUS.BLOCKED_PERMISSION,
          blockReason: 'permission',
          permission: 'denied',
          revisionBlobSha256Hex: address, bytes: null, value: null
        });
      }
      if (isNotFound(error)) {
        return Object.freeze({
          status: P02_FSA_READ_STATUS.ABSENT,
          revisionBlobSha256Hex: address, bytes: null, value: null
        });
      }
      return Object.freeze({
        status: P02_FSA_READ_STATUS.UNREADABLE,
        reason: clean(error?.name) || clean(error?.code) || 'read-failed',
        revisionBlobSha256Hex: address, bytes: null, value: null
      });
    }

    if (Number(file?.size) > maxRevisionBytes) {
      /* Refused before reading it into memory. An untrusted folder can hold a
       * file of any size, and a bound that is checked after loading is not a
       * bound at all. */
      return Object.freeze({
        status: P02_FSA_READ_STATUS.MALFORMED,
        reason: 'revision-too-large',
        revisionBlobSha256Hex: address, bytes: null, value: null
      });
    }

    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      return Object.freeze({
        status: P02_FSA_READ_STATUS.UNREADABLE,
        reason: clean(error?.name) || 'read-failed',
        revisionBlobSha256Hex: address, bytes: null, value: null
      });
    }

    /* The address is re-derived. A file named for one hash whose bytes hash to
     * another is precisely what an untrusted folder can contain. */
    const actual = clean(await sha256HexBytes(bytes));
    if (actual !== address) {
      return Object.freeze({
        status: P02_FSA_READ_STATUS.INTEGRITY,
        reason: 'blob-hash-mismatch',
        revisionBlobSha256Hex: address,
        observedSha256Hex: hex64(actual) ? actual : null,
        bytes: null, value: null
      });
    }

    let value;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch (_) {
      return Object.freeze({
        status: P02_FSA_READ_STATUS.MALFORMED,
        reason: 'not-canonical-json',
        revisionBlobSha256Hex: address, bytes: null, value: null
      });
    }
    if (!isPlainObject(value)) {
      return Object.freeze({
        status: P02_FSA_READ_STATUS.MALFORMED,
        reason: 'not-a-document',
        revisionBlobSha256Hex: address, bytes: null, value: null
      });
    }

    return Object.freeze({
      status: P02_FSA_READ_STATUS.VERIFIED,
      revisionBlobSha256Hex: address,
      bytes, value
    });
  }

  /*
   * Walk a validated relative path with `create: false` only. Every acquisition
   * on this route is a read: there is no branch that creates, writes, truncates
   * or removes anything, and none can be added without changing this function.
   */
  async function readWithin(handle, segments, limitBytes) {
    let current = handle;
    for (const segment of segments.slice(0, -1)) {
      current = await current.getDirectoryHandle(segment, { create: false });
    }
    const fileHandle = await current.getFileHandle(segments[segments.length - 1],
      { create: false });
    const file = await fileHandle.getFile();
    if (Number(file?.size) > limitBytes) {
      throw new P02FsaReadError(P02_FSA_READ_ERROR.READ_FAILED, 'document-too-large');
    }
    return new Uint8Array(await file.arrayBuffer());
  }

  /*
   * The shared reader's storage contract: `read(path)` returning bytes, or
   * null for a PROVEN absence. A lost grant throws instead, because a reader
   * that cannot see the repository has not proven anything about its contents.
   */
  async function confinedRead(handle, segments, limitBytes) {
    const permission = await permissionState();
    if (permission !== 'granted') {
      throw new P02FsaReadError(P02_FSA_READ_ERROR.PERMISSION_BLOCKED, permission);
    }
    try {
      return await readWithin(handle, segments, limitBytes);
    } catch (error) {
      if (error instanceof P02FsaReadError) throw error;
      if (isPermission(error)) {
        throw new P02FsaReadError(P02_FSA_READ_ERROR.PERMISSION_BLOCKED, 'denied');
      }
      if (isNotFound(error)) return null;
      throw new P02FsaReadError(P02_FSA_READ_ERROR.READ_FAILED,
        clean(error?.name) || 'read-failed');
    }
  }

  let repositoryHandlePromise = null;
  async function repositoryHandle() {
    if (containerHandle === null) return directoryHandle;
    if (repositoryHandlePromise === null) {
      repositoryHandlePromise = containerHandle
        .getDirectoryHandle(P02_FSA_REPOSITORY_CHILD, { create: false });
    }
    return repositoryHandlePromise;
  }

  async function listWriterRoots() {
    const permission = await permissionState();
    if (permission !== 'granted') {
      throw new P02FsaReadError(P02_FSA_READ_ERROR.PERMISSION_BLOCKED, permission);
    }
    let writers;
    try {
      writers = await (await repositoryHandle()).getDirectoryHandle('writers', {
        create: false
      });
    } catch (error) {
      if (isPermission(error)) {
        throw new P02FsaReadError(P02_FSA_READ_ERROR.PERMISSION_BLOCKED, 'denied');
      }
      if (isNotFound(error)) return Object.freeze([]);
      throw new P02FsaReadError(P02_FSA_READ_ERROR.READ_FAILED,
        clean(error?.name) || 'writer-root-list-failed');
    }

    const names = [];
    try {
      if (typeof writers.entries === 'function') {
        for await (const [name, handle] of writers.entries()) {
          if (handle?.kind === 'directory' && WRITER_ROOT_NAME.test(name)) names.push(name);
        }
      } else if (typeof writers.values === 'function') {
        for await (const handle of writers.values()) {
          if (handle?.kind === 'directory' && WRITER_ROOT_NAME.test(handle.name || '')) {
            names.push(handle.name);
          }
        }
      } else {
        throw new P02FsaReadError(P02_FSA_READ_ERROR.READ_FAILED,
          'writer-root-listing-unavailable');
      }
    } catch (error) {
      if (error instanceof P02FsaReadError) throw error;
      if (isPermission(error)) {
        throw new P02FsaReadError(P02_FSA_READ_ERROR.PERMISSION_BLOCKED, 'denied');
      }
      throw new P02FsaReadError(P02_FSA_READ_ERROR.READ_FAILED,
        clean(error?.name) || 'writer-root-list-failed');
    }
    return Object.freeze([...new Set(names)].sort());
  }

  /*
   * Repository-rooted, closed-grammar reads. This is the object handed to
   * `createLocalReaderTransportPrimitives` - and it is the whole capability
   * Chrome gets: one method, five permitted path families, no write of any kind.
   */
  function repositoryStorage() {
    return Object.freeze({
      readOnly: true,
      async read(path) {
        const family = classifyRepositoryRead(path);
        if (family === null) {
          throw new P02FsaReadError(P02_FSA_READ_ERROR.PATH_REFUSED, String(path));
        }
        return confinedRead(await repositoryHandle(), path.split('/'), maxDocumentBytes);
      }
    });
  }

  /* Container-rooted N.2 artifacts, by exact name only. */
  function legacyArtifactStorage() {
    return Object.freeze({
      readOnly: true,
      async read(name) {
        if (!P02_FSA_LEGACY_ARTIFACTS.includes(name)) {
          throw new P02FsaReadError(P02_FSA_READ_ERROR.PATH_REFUSED, String(name));
        }
        return confinedRead(containerHandle ?? directoryHandle, [name], maxDocumentBytes);
      }
    });
  }

  return Object.freeze({
    schema: P02_FSA_READ_V2.SCHEMA,
    /* Stated, so a caller cannot look for a write method and find nothing. */
    readOnly: true,
    permissionState,
    readRevision,
    listWriterRoots,
    repositoryStorage,
    legacyArtifactStorage
  });
}
