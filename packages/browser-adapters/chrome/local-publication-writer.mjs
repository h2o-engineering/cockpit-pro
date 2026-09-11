/*
 * Chrome File System Access adapter for one local-publication slot.
 *
 * Lineage, canonical bytes, and durable producer state remain owned by the
 * projection/ledger authorities. This module only obtains the existing Sync
 * directory handle, performs a gesture-gated live permission check, and makes
 * already-authoritative bytes visible through a fixed temp -> move -> final
 * protocol. It has no picker, path, remote transport, UI, or Desktop capability.
 */

export const LOCAL_PUBLICATION_FILE = 'h2o-local-publication.v1.json';
export const LOCAL_PUBLICATION_TEMP_FILE = '.h2o-local-publication.v1.json.tmp';
export const LOCAL_PUBLICATION_SCHEMA = 'h2o.studio.local-publication.v1';
export const LOCAL_PUBLICATION_SCHEMA_VERSION = 1;

export const LOCAL_PUBLICATION_WRITER_ERROR = Object.freeze({
  OBJECT_ID_INVALID: 'local-publication-object-id-invalid',
  USER_GESTURE_REQUIRED: 'local-publication-user-gesture-required',
  AUTOMATIC_AUTHORITY_REQUIRED: 'local-publication-automatic-authority-required',
  DIRECTORY_HANDLE_MISSING: 'local-publication-directory-handle-missing',
  PERMISSION_UNAVAILABLE: 'local-publication-readwrite-permission-unavailable',
  PERMISSION_DENIED: 'local-publication-readwrite-permission-denied',
  PERMISSION_LOST: 'local-publication-readwrite-permission-lost',
  PLAN_INVALID: 'local-publication-plan-invalid',
  TARGET_REVISION_MOVED: 'local-publication-target-revision-moved',
  ENVELOPE_INVALID: 'local-publication-envelope-invalid',
  SLOT_UNSAFE: 'local-publication-slot-unsafe',
  /* Generation-scoped retirement. Under P02 the genuine Chrome-origin handoff is
   * repository-native, under h2o-object-sync/; this slot lane belongs to P01 and
   * Round 2 and must not write the parent-container artifact any more. */
  LANE_RETIRED: 'local-publication-lane-retired',
  TEMP_SLOT_UNEXPLAINED: 'local-publication-temp-slot-unexplained',
  MOVE_UNAVAILABLE: 'local-publication-move-unavailable',
  MOVE_FAILED: 'local-publication-move-failed',
  TEMP_VERIFY_FAILED: 'local-publication-temp-verification-failed',
  FINAL_VERIFY_FAILED: 'local-publication-final-verification-failed',
  PUBLICATION_FAILED: 'local-publication-write-failed'
});

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_ID_LENGTH = 512;
const ENVELOPE_KEYS = Object.freeze([
  'headBytesBase64',
  'headSha256Hex',
  'objectId',
  'producedAtIso',
  'publicationSchemaVersion',
  'revisionBlobSha256Hex',
  'revisionBytesBase64',
  'schema'
]);

export class LocalPublicationWriterError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'LocalPublicationWriterError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function fail(code, cause = null) {
  throw new LocalPublicationWriterError(code, cause);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStrictIdentifier(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch (_) {
    return false;
  }
}

function bytesFrom(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value) && value.constructor?.name === 'Uint8Array') {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    );
  }
  return null;
}

function bytesEqual(left, right) {
  const a = bytesFrom(left);
  const b = bytesFrom(right);
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function bytesToBase64(bytes) {
  const source = bytesFrom(bytes);
  if (!source || source.byteLength === 0) {
    fail(LOCAL_PUBLICATION_WRITER_ERROR.ENVELOPE_INVALID);
  }
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < source.length; index += 3) {
    const first = source[index];
    const second = source[index + 1];
    const third = source[index + 2];
    const value = (first << 16) |
      ((second === undefined ? 0 : second) << 8) |
      (third === undefined ? 0 : third);
    output += alphabet[(value >>> 18) & 63];
    output += alphabet[(value >>> 12) & 63];
    output += second === undefined ? '=' : alphabet[(value >>> 6) & 63];
    output += third === undefined ? '=' : alphabet[value & 63];
  }
  return output;
}

function base64ToBytes(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const output = [];
  for (let index = 0; index < value.length; index += 4) {
    const a = alphabet.indexOf(value[index]);
    const b = alphabet.indexOf(value[index + 1]);
    const c = value[index + 2] === '=' ? 0 : alphabet.indexOf(value[index + 2]);
    const d = value[index + 3] === '=' ? 0 : alphabet.indexOf(value[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) return null;
    const packed = (a << 18) | (b << 12) | (c << 6) | d;
    output.push((packed >>> 16) & 255);
    if (value[index + 2] !== '=') output.push((packed >>> 8) & 255);
    if (value[index + 3] !== '=') output.push(packed & 255);
  }
  return new Uint8Array(output);
}

async function sha256Hex(cryptoImplementation, bytes) {
  if (!cryptoImplementation?.subtle ||
      typeof cryptoImplementation.subtle.digest !== 'function') {
    fail(LOCAL_PUBLICATION_WRITER_ERROR.ENVELOPE_INVALID);
  }
  try {
    const digest = await cryptoImplementation.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')).join('');
  } catch (error) {
    fail(LOCAL_PUBLICATION_WRITER_ERROR.ENVELOPE_INVALID, error);
  }
}

function authoritativeRequestFromPlan(plan, staged) {
  if (plan?.disposition === 'PromoteReady' ||
      plan?.disposition === 'ResumeRetry') {
    return plan.pending?.pending?.request || null;
  }
  if (staged?.pending?.request) return staged.pending.request;
  if (plan?.disposition === 'committed-replay' && staged?.tip) {
    const projection = plan.projection;
    return {
      objectId: projection?.objectId,
      objectKey: projection?.objectKeyHex,
      revisionId: projection?.revisionId,
      previousRevisionId: projection?.previousRevisionId,
      revisionBlobSha256Hex: projection?.revisionBlobSha256Hex,
      headSha256Hex: projection?.headSha256Hex,
      producedAtIso: staged.tip.producedAtIso,
      revisionBlobBytes: projection?.revisionCanonicalBytes,
      headBytes: projection?.headCanonicalBytes
    };
  }
  return null;
}

function validateAuthoritativeRequest(request, objectId) {
  const revisionBlobBytes = bytesFrom(request?.revisionBlobBytes);
  const headBytes = bytesFrom(request?.headBytes);
  if (!isPlainObject(request) ||
      request.objectId !== objectId ||
      !SHA256_RE.test(request.objectKey || '') ||
      !isStrictIdentifier(request.revisionId) ||
      (request.previousRevisionId !== null &&
        !isStrictIdentifier(request.previousRevisionId)) ||
      !SHA256_RE.test(request.revisionBlobSha256Hex || '') ||
      !SHA256_RE.test(request.headSha256Hex || '') ||
      !isIsoTimestamp(request.producedAtIso) ||
      !revisionBlobBytes || !headBytes ||
      revisionBlobBytes.byteLength === 0 || headBytes.byteLength === 0) {
    fail(LOCAL_PUBLICATION_WRITER_ERROR.PLAN_INVALID);
  }
  return Object.freeze({
    ...request,
    revisionBlobBytes,
    headBytes
  });
}

export async function buildLocalPublicationEnvelope(
  request,
  canonicalJson,
  cryptoImplementation = globalThis.crypto
) {
  if (typeof canonicalJson !== 'function') {
    fail(LOCAL_PUBLICATION_WRITER_ERROR.ENVELOPE_INVALID);
  }
  const validated = validateAuthoritativeRequest(request, request?.objectId);
  if (await sha256Hex(cryptoImplementation, validated.headBytes) !==
      validated.headSha256Hex ||
      await sha256Hex(cryptoImplementation, validated.revisionBlobBytes) !==
        validated.revisionBlobSha256Hex) {
    fail(LOCAL_PUBLICATION_WRITER_ERROR.ENVELOPE_INVALID);
  }
  const envelope = {
    schema: LOCAL_PUBLICATION_SCHEMA,
    publicationSchemaVersion: LOCAL_PUBLICATION_SCHEMA_VERSION,
    objectId: validated.objectId,
    headBytesBase64: bytesToBase64(validated.headBytes),
    headSha256Hex: validated.headSha256Hex,
    revisionBytesBase64: bytesToBase64(validated.revisionBlobBytes),
    revisionBlobSha256Hex: validated.revisionBlobSha256Hex,
    producedAtIso: validated.producedAtIso
  };
  return Object.freeze({
    envelope: Object.freeze(envelope),
    text: canonicalJson(envelope),
    bytes: new TextEncoder().encode(canonicalJson(envelope))
  });
}

function errorCode(error, fallback) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return LOCAL_PUBLICATION_WRITER_ERROR.PERMISSION_LOST;
  }
  return typeof error?.code === 'string' ? error.code : fallback;
}

async function queryReadWritePermission(handle) {
  if (!handle || typeof handle.queryPermission !== 'function') {
    fail(LOCAL_PUBLICATION_WRITER_ERROR.PERMISSION_UNAVAILABLE);
  }
  try {
    return await handle.queryPermission({ mode: 'readwrite' });
  } catch (error) {
    fail(LOCAL_PUBLICATION_WRITER_ERROR.PERMISSION_UNAVAILABLE, error);
  }
}

export async function ensureLocalPublicationWritePermission(
  handle,
  explicitUserGesture
) {
  const current = await queryReadWritePermission(handle);
  if (current === 'granted') return 'granted';
  if (explicitUserGesture !== true) {
    fail(LOCAL_PUBLICATION_WRITER_ERROR.USER_GESTURE_REQUIRED);
  }
  if (typeof handle.requestPermission !== 'function') {
    fail(LOCAL_PUBLICATION_WRITER_ERROR.PERMISSION_UNAVAILABLE);
  }
  let requested;
  try {
    requested = await handle.requestPermission({ mode: 'readwrite' });
  } catch (error) {
    fail(LOCAL_PUBLICATION_WRITER_ERROR.PERMISSION_DENIED, error);
  }
  if (requested !== 'granted') {
    fail(LOCAL_PUBLICATION_WRITER_ERROR.PERMISSION_DENIED);
  }
  return 'granted';
}

async function requirePermissionStillGranted(handle) {
  if (await queryReadWritePermission(handle) !== 'granted') {
    fail(LOCAL_PUBLICATION_WRITER_ERROR.PERMISSION_LOST);
  }
}

async function readNamedFile(directoryHandle, name) {
  let handle;
  try {
    handle = await directoryHandle.getFileHandle(name, { create: false });
  } catch (error) {
    if (error?.name === 'NotFoundError' || error?.code === 'ENOENT') return null;
    throw error;
  }
  const file = await handle.getFile();
  return {
    handle,
    bytes: new Uint8Array(await file.arrayBuffer())
  };
}

async function parseSlot(bytes, cryptoImplementation) {
  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (_) {
    return null;
  }
  if (!isPlainObject(envelope) ||
      Object.keys(envelope).sort().join('\u0000') !== ENVELOPE_KEYS.join('\u0000') ||
      envelope.schema !== LOCAL_PUBLICATION_SCHEMA ||
      envelope.publicationSchemaVersion !== LOCAL_PUBLICATION_SCHEMA_VERSION ||
      !isStrictIdentifier(envelope.objectId) ||
      !SHA256_RE.test(envelope.headSha256Hex || '') ||
      !SHA256_RE.test(envelope.revisionBlobSha256Hex || '') ||
      !isIsoTimestamp(envelope.producedAtIso)) return null;
  const headBytes = base64ToBytes(envelope.headBytesBase64);
  const revisionBytes = base64ToBytes(envelope.revisionBytesBase64);
  if (!headBytes || !revisionBytes ||
      await sha256Hex(cryptoImplementation, headBytes) !== envelope.headSha256Hex ||
      await sha256Hex(cryptoImplementation, revisionBytes) !==
        envelope.revisionBlobSha256Hex) return null;
  let head;
  try {
    head = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headBytes));
  } catch (_) {
    return null;
  }
  if (!isPlainObject(head) || head.objectId !== envelope.objectId ||
      !isStrictIdentifier(head.revisionId) ||
      (head.previousRevisionId !== null &&
        !isStrictIdentifier(head.previousRevisionId))) return null;
  return { envelope, head, headBytes, revisionBytes };
}

async function slotPosture({
  finalBytes,
  publicationBytes,
  request,
  ledgerTip,
  cryptoImplementation
}) {
  if (!finalBytes) return Object.freeze({ state: 'absent' });
  if (bytesEqual(finalBytes, publicationBytes)) {
    return Object.freeze({ state: 'same-publication-current' });
  }
  const parsed = await parseSlot(finalBytes, cryptoImplementation);
  if (!parsed) return Object.freeze({ state: 'undecodable-unsafe' });
  if (parsed.envelope.objectId !== request.objectId) {
    return Object.freeze({ state: 'other-object-different-publication' });
  }
  if (ledgerTip &&
      parsed.head.revisionId === ledgerTip.revisionId &&
      parsed.head.previousRevisionId === ledgerTip.previousRevisionId &&
      parsed.envelope.revisionBlobSha256Hex ===
        ledgerTip.revisionBlobSha256Hex &&
      parsed.envelope.headSha256Hex === ledgerTip.headSha256Hex &&
      parsed.envelope.producedAtIso === ledgerTip.producedAtIso &&
      request.previousRevisionId === ledgerTip.revisionId) {
    return Object.freeze({ state: 'same-object-behind' });
  }
  return Object.freeze({ state: 'same-object-different-publication' });
}

async function writeExactFile(fileHandle, bytes) {
  const writable = await fileHandle.createWritable();
  let closed = false;
  try {
    await writable.write(bytes);
    await writable.close();
    closed = true;
  } finally {
    if (!closed && typeof writable.abort === 'function') {
      try { await writable.abort(); } catch (_) { /* best effort only */ }
    }
  }
}

export function createChromeLocalPublicationWriter({
  projection,
  ledger,
  folderAuthority,
  cryptoImplementation = globalThis.crypto,
  userActivation = () => globalThis.navigator?.userActivation?.isActive === true,
  automaticAuthority = async () => false,
  /*
   * O1-T19. The writer-generation gate, injected rather than reached for, so a
   * platform composition states explicitly what this writer observes.
   *
   * The DEFAULT is the compatibility position: a caller that supplies no gate
   * is a pre-T19 composition, and P01 must behave exactly as it did before.
   * That is a statement about the CALLER, not about the store - once a gate is
   * supplied its four-state observation governs, and an unreadable store
   * refuses.
   */
  writerGenerationGate = { p01MayMutate: async () => ({
    permitted: true, reason: null
  }) },
  /* Production compositions inject the origin-wide Web Locks owner. The
   * compatibility default preserves pre-admission unit callers, but still
   * keeps the generation check inside the operation boundary. */
  p01MutationAdmission = {
    async run({ generationCheck, operation, existingLease = null }) {
      const generation = await generationCheck();
      if (generation?.permitted !== true) {
        fail(generation?.reason || 'p01-writer-stood-down');
      }
      return operation(existingLease, generation);
    }
  },
  hooks = Object.freeze({})
} = {}) {
  if (!projection || typeof projection.planPublication !== 'function' ||
      typeof projection.canonicalJson !== 'function' ||
      !ledger || typeof ledger.stageLocalPublicationIntent !== 'function' ||
      typeof ledger.commitLocalPublicationIntent !== 'function' ||
      typeof ledger.markLocalPublicationRetry !== 'function' ||
      typeof ledger.readLocalPublicationTip !== 'function' ||
      !folderAuthority ||
      typeof folderAuthority.getConnectedDirectoryHandle !== 'function' ||
      !p01MutationAdmission ||
      typeof p01MutationAdmission.run !== 'function') {
    fail(LOCAL_PUBLICATION_WRITER_ERROR.PLAN_INVALID);
  }

  async function hook(name, context) {
    if (typeof hooks[name] === 'function') await hooks[name](context);
  }

  async function markRetry(request, hasPending) {
    if (!hasPending) return;
    try {
      await ledger.markLocalPublicationRetry(
        request.objectKey,
        request.revisionId
      );
    } catch (_) {
      /* The original durable pending/error remains authoritative. */
    }
  }

  /* The revision this plan would actually publish, whatever route produced it.
   * A pending promotion/retry carries its authoritative request instead of a
   * fresh projection. */
  function plannedRevisionId(plan) {
    if (isStrictIdentifier(plan?.projection?.revisionId)) {
      return plan.projection.revisionId;
    }
    const pendingRequest = plan?.pending?.pending?.request;
    if (isStrictIdentifier(pendingRequest?.revisionId)) {
      return pendingRequest.revisionId;
    }
    return null;
  }

  /* expectedRevisionId binds a publication to the revision its caller actually
   * saw and proved. The archive can advance the SAME object between that proof
   * and this call, and planning always projects the CURRENT head, so without
   * this the writer would silently publish a revision the caller never
   * displayed. A caller that supplies no identifier keeps the previous
   * behaviour, and anything that is not a strict identifier is ignored exactly
   * as every other caller-supplied value is — an expectation can only refuse a
   * publication, never redirect one. */
  /* Read-only. Fails OPEN for P01 compatibility: a gate that cannot be observed
   * has not told us this is a p02 repository, and every pre-existing generation
   * check inside the admission owner still applies. */
  async function repositoryGenerationIsP02() {
    try {
      const observation = typeof writerGenerationGate.observe === 'function'
        ? await writerGenerationGate.observe()
        : null;
      return observation?.state === 'recorded' && observation?.generation === 'p02';
    } catch (_) {
      return false;
    }
  }

  async function publishLocalRevisionInternal(
    objectId,
    expectedRevisionId,
    automatic,
    existingLease = null
  ) {
    /* Capture transient activation synchronously, before the admission owner
     * reaches its first await. The lease then spans planning, permission,
     * filesystem writes, and the durable publication ledger. */
    const explicitUserGesture = userActivation() === true;
    /*
     * Generation-scoped lane retirement, checked BEFORE the admission owner is
     * entered - so no lease is taken, no plan is built, no temp or final slot
     * byte is written, and nothing is staged in the ledger.
     *
     * Under repository generation p02 the parent-container slot is a retired
     * P01 / Round-2 compatibility artifact whose baseline expectation is
     * `present:false`. Writing it would flip that expectation to
     * EXPECTED_ABSENT_NOW_PRESENT and break the V7 baseline. The genuine P02
     * handoff is repository-native and never comes through here.
     *
     * P01 is untouched: an absent, unobservable or p01 generation leaves this
     * lane exactly as it was.
     */
    if (await repositoryGenerationIsP02()) {
      fail(LOCAL_PUBLICATION_WRITER_ERROR.LANE_RETIRED);
    }
    return p01MutationAdmission.run({
      label: automatic
        ? 'chrome-local-publication-automatic'
        : 'chrome-local-publication-manual',
      existingLease,
      generationCheck: async () => {
        try {
          /* A P02 publication must prove P02 PUBLICATION authority, not P01
           * MUTATION authority. Asking p01MayMutate() refused every publication
           * in the one state that authorises this writer - recorded/p02 with
           * P01 stood down - because a stood-down P01 is the precondition, not
           * a blocker. Gates that expose the publication predicate answer the
           * right question; p01MayMutate stays the fallback for the accepted
           * pre-P02 compositions and for the permissive default below, and it
           * is itself unchanged. Both predicates read one observation. */
          return typeof writerGenerationGate.publicationMayProceed === 'function'
            ? await writerGenerationGate.publicationMayProceed()
            : await writerGenerationGate.p01MayMutate();
        } catch (_) {
          return { permitted: false, reason: 'generation-unobserved' };
        }
      },
      operation: () => publishLocalRevisionAdmitted(
        objectId,
        expectedRevisionId,
        automatic,
        explicitUserGesture
      )
    });
  }

  async function publishLocalRevisionAdmitted(
    objectId,
    expectedRevisionId,
    automatic,
    explicitUserGesture
  ) {
    if (!isStrictIdentifier(objectId)) {
      fail(LOCAL_PUBLICATION_WRITER_ERROR.OBJECT_ID_INVALID);
    }
    const boundRevisionId = isStrictIdentifier(expectedRevisionId)
      ? expectedRevisionId
      : null;
    if (automatic) {
      if (await automaticAuthority() !== true) {
        fail(LOCAL_PUBLICATION_WRITER_ERROR.AUTOMATIC_AUTHORITY_REQUIRED);
      }
    } else if (!explicitUserGesture) {
      fail(LOCAL_PUBLICATION_WRITER_ERROR.USER_GESTURE_REQUIRED);
    }

    // Planning precedes all folder/permission access, so failed provenance has
    // no filesystem or permission side effect.
    const plan = await projection.planPublication({ objectId, ledger });
    if (!isPlainObject(plan) || typeof plan.disposition !== 'string') {
      fail(LOCAL_PUBLICATION_WRITER_ERROR.PLAN_INVALID);
    }

    // Bind BEFORE any folder handle, permission query, temp file, final write
    // or publication ledger mutation: a moved revision must cost nothing.
    if (boundRevisionId !== null && plannedRevisionId(plan) !== boundRevisionId) {
      fail(LOCAL_PUBLICATION_WRITER_ERROR.TARGET_REVISION_MOVED);
    }

    // A canonical revision which was materialized by remote Apply is already
    // converged. Suppress it before folder or permission access so automatic
    // reconciliation cannot echo the same semantic revision back.
    if (plan.disposition === 'remote-applied-current') {
      return Object.freeze({
        ok: true,
        disposition: plan.disposition,
        visibility: 'suppressed-remote-echo',
        slotPosture: 'not-inspected',
        objectId,
        revisionId: plan.projection.revisionId,
        previousRevisionId: plan.projection.previousRevisionId,
        producedAtIso: null,
        bytes: 0,
        advanceLedger: false,
        unchangedNoOp: true
      });
    }

    if (automatic && await automaticAuthority() !== true) {
      fail(LOCAL_PUBLICATION_WRITER_ERROR.AUTOMATIC_AUTHORITY_REQUIRED);
    }

    const directoryHandle = folderAuthority.getConnectedDirectoryHandle();
    if (!directoryHandle) {
      fail(LOCAL_PUBLICATION_WRITER_ERROR.DIRECTORY_HANDLE_MISSING);
    }
    await ensureLocalPublicationWritePermission(
      directoryHandle,
      automatic ? false : explicitUserGesture
    );

    let staged = null;
    let request = null;
    let hasPending = plan.disposition === 'PromoteReady' ||
      plan.disposition === 'ResumeRetry';
    try {
      if (hasPending) {
        request = authoritativeRequestFromPlan(plan, null);
      } else {
        if (!plan.projection) {
          fail(LOCAL_PUBLICATION_WRITER_ERROR.PLAN_INVALID);
        }
        staged = await ledger.stageLocalPublicationIntent({
          objectId: plan.projection.objectId,
          objectKey: plan.projection.objectKeyHex,
          revisionId: plan.projection.revisionId,
          previousRevisionId: plan.projection.previousRevisionId,
          revisionBlobSha256Hex: plan.projection.revisionBlobSha256Hex,
          headSha256Hex: plan.projection.headSha256Hex,
          revisionBlobBytes: plan.projection.revisionCanonicalBytes,
          headBytes: plan.projection.headCanonicalBytes
        });
        hasPending = staged?.verdict !== 'committed-replay';
        request = authoritativeRequestFromPlan(plan, staged);
      }
      request = validateAuthoritativeRequest(request, objectId);
      const publication = await buildLocalPublicationEnvelope(
        request,
        projection.canonicalJson,
        cryptoImplementation
      );
      const ledgerTip = await ledger.readLocalPublicationTip(request.objectKey);

      await hook('afterPendingBeforeTemp', { plan, request, publication });
      await requirePermissionStillGranted(directoryHandle);

      const finalRead = await readNamedFile(
        directoryHandle,
        LOCAL_PUBLICATION_FILE
      );
      const posture = await slotPosture({
        finalBytes: finalRead?.bytes || null,
        publicationBytes: publication.bytes,
        request,
        ledgerTip,
        cryptoImplementation
      });
      if (posture.state === 'same-publication-current') {
        if (hasPending) {
          await ledger.commitLocalPublicationIntent(
            request.objectKey,
            request.revisionId
          );
        }
        return Object.freeze({
          ok: true,
          disposition: plan.disposition,
          visibility: 'already-current',
          slotPosture: posture.state,
          objectId,
          revisionId: request.revisionId,
          previousRevisionId: request.previousRevisionId,
          producedAtIso: request.producedAtIso,
          bytes: publication.bytes.byteLength,
          advanceLedger: hasPending
        });
      }
      if (posture.state !== 'absent' && posture.state !== 'same-object-behind') {
        fail(LOCAL_PUBLICATION_WRITER_ERROR.SLOT_UNSAFE);
      }

      const existingTemp = await readNamedFile(
        directoryHandle,
        LOCAL_PUBLICATION_TEMP_FILE
      );
      if (existingTemp && !bytesEqual(existingTemp.bytes, publication.bytes)) {
        fail(LOCAL_PUBLICATION_WRITER_ERROR.TEMP_SLOT_UNEXPLAINED);
      }
      let tempHandle = existingTemp?.handle || null;
      if (!existingTemp) {
        await hook('beforeTempCreate', { plan, request, publication });
        await requirePermissionStillGranted(directoryHandle);
        tempHandle = await directoryHandle.getFileHandle(
          LOCAL_PUBLICATION_TEMP_FILE,
          { create: true }
        );
        await hook('duringTempWrite', { plan, request, publication, tempHandle });
        await writeExactFile(tempHandle, publication.bytes);
      }
      await hook('afterTempCloseBeforeVerify', {
        plan, request, publication, tempHandle
      });
      const verifiedTemp = await readNamedFile(
        directoryHandle,
        LOCAL_PUBLICATION_TEMP_FILE
      );
      if (!verifiedTemp || !bytesEqual(verifiedTemp.bytes, publication.bytes) ||
          await sha256Hex(cryptoImplementation, verifiedTemp.bytes) !==
            await sha256Hex(cryptoImplementation, publication.bytes)) {
        fail(LOCAL_PUBLICATION_WRITER_ERROR.TEMP_VERIFY_FAILED);
      }
      tempHandle = verifiedTemp.handle;
      await hook('afterTempVerifyBeforeMove', {
        plan, request, publication, tempHandle
      });
      await requirePermissionStillGranted(directoryHandle);
      if (typeof tempHandle.move !== 'function') {
        fail(LOCAL_PUBLICATION_WRITER_ERROR.MOVE_UNAVAILABLE);
      }
      try {
        await tempHandle.move(LOCAL_PUBLICATION_FILE);
      } catch (error) {
        fail(errorCode(error, LOCAL_PUBLICATION_WRITER_ERROR.MOVE_FAILED), error);
      }
      await hook('afterMoveBeforeFinalVerify', { plan, request, publication });
      await requirePermissionStillGranted(directoryHandle);
      const finalVerified = await readNamedFile(
        directoryHandle,
        LOCAL_PUBLICATION_FILE
      );
      if (!finalVerified ||
          !bytesEqual(finalVerified.bytes, publication.bytes) ||
          await sha256Hex(cryptoImplementation, finalVerified.bytes) !==
            await sha256Hex(cryptoImplementation, publication.bytes)) {
        fail(LOCAL_PUBLICATION_WRITER_ERROR.FINAL_VERIFY_FAILED);
      }
      await hook('afterFinalVerifyBeforePromotion', {
        plan, request, publication
      });
      if (hasPending) {
        await ledger.commitLocalPublicationIntent(
          request.objectKey,
          request.revisionId
        );
      }
      await hook('afterLedgerPromotion', { plan, request, publication });
      return Object.freeze({
        ok: true,
        disposition: plan.disposition,
        visibility: 'verified-final',
        slotPosture: posture.state,
        objectId,
        revisionId: request.revisionId,
        previousRevisionId: request.previousRevisionId,
        producedAtIso: request.producedAtIso,
        bytes: publication.bytes.byteLength,
        advanceLedger: hasPending
      });
    } catch (error) {
      if (request) await markRetry(request, hasPending);
      if (error instanceof LocalPublicationWriterError) throw error;
      fail(errorCode(error, LOCAL_PUBLICATION_WRITER_ERROR.PUBLICATION_FAILED), error);
    }
  }

  function publishLocalRevision(objectId, expectedRevisionId, existingLease) {
    return publishLocalRevisionInternal(
      objectId, expectedRevisionId, false, existingLease || null
    );
  }

  function publishLocalRevisionAutomatically(
    objectId,
    expectedRevisionId,
    existingLease
  ) {
    return publishLocalRevisionInternal(
      objectId, expectedRevisionId, true, existingLease || null
    );
  }

  return Object.freeze({
    publishLocalRevision,
    publishLocalRevisionAutomatically
  });
}

export const LOCAL_PUBLICATION_WRITER_CONSTANTS = Object.freeze({
  LOCAL_PUBLICATION_FILE,
  LOCAL_PUBLICATION_TEMP_FILE,
  LOCAL_PUBLICATION_SCHEMA,
  LOCAL_PUBLICATION_SCHEMA_VERSION
});
