/*
 * Round 2 / Item 9-1 — Chrome peer-scoped sync-object observation store.
 *
 * CHROME/MV3 PLATFORM ADAPTER ONLY.
 *
 * This module intentionally has no service-worker registration or external
 * capability surface.
 * A later Item 9 tranche may call this internal API after separately governed
 * Desktop-mediated delivery.
 */

const DATABASE_NAME = 'h2o.studio.sync-object.mv3';
const DATABASE_VERSION = 4;
const AUTHORITY_STORE = 'authority';
const OBSERVATION_STORE = 'observations';
const LOCAL_PUBLICATION_LEDGER_STORE = 'local-publication-ledger';
const ADMISSION_EVIDENCE_STORE = 'admission-evidence';
const APPLY_STATE_STORE = 'apply-state';
const BRANCH_EVIDENCE_STORE = 'branch-evidence';
const AUTHORITY_KEY = 'peer-authority';
const AUTHORITY_SCHEMA = 'h2o.round2.item9.browser-sync-authority.v1';
const AUTHORITY_SCHEMA_VERSION = 1;
const OBSERVATION_SCHEMA = 'h2o.round2.item9.browser-sync-observation.v1';
const OBSERVATION_SCHEMA_VERSION = 1;
const LOCAL_PUBLICATION_LEDGER_SCHEMA = 'h2o.studio.local-publication-ledger.v1';
const LOCAL_PUBLICATION_LEDGER_SCHEMA_VERSION = 1;
const ADMISSION_EVIDENCE_SCHEMA = 'h2o.studio.sync-admission-evidence.v1';
const ADMISSION_EVIDENCE_SCHEMA_VERSION = 1;
const APPLY_STATE_SCHEMA = 'h2o.studio.sync-apply-state.v1';
const APPLY_STATE_SCHEMA_VERSION = 1;
/* P02 Wave 1 / Z6 (frozen V2): additive retained-branch-evidence store. */
const BRANCH_EVIDENCE_SCHEMA = 'h2o.studio.sync-branch-evidence.p02.v1';
const BRANCH_EVIDENCE_SCHEMA_VERSION = 1;
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 512;

const EXPECTED_IDENTITY = Object.freeze({
  schema: 'h2o.studio.peer-identity.v1',
  surfaceKind: 'studio-chrome',
  appKind: 'mv3-chrome',
  storeKind: 'idb-archive'
});

const ERROR_CODE = Object.freeze({
  IDENTITY_UNAVAILABLE: 'round2-item9-identity-unavailable',
  IDENTITY_MALFORMED: 'round2-item9-identity-malformed',
  IDENTITY_CLASSIFICATION_UNSUPPORTED: 'round2-item9-identity-classification-unsupported',
  PEER_AUTHORITY_MISMATCH: 'round2-item9-peer-authority-mismatch',
  DATABASE_OPEN_FAILED: 'round2-item9-database-open-failed',
  DATABASE_TRANSACTION_FAILED: 'round2-item9-database-transaction-failed',
  DATABASE_VERSION_UNSUPPORTED: 'round2-item9-database-version-unsupported',
  MIGRATION_FAILED: 'round2-item9-migration-failed',
  OBSERVATION_CONFLICT: 'round2-item9-observation-conflict',
  OBSERVATION_INVALID: 'round2-item9-observation-invalid',
  BLOB_HASH_MISMATCH: 'round2-item9-blob-hash-mismatch',
  LINEAGE_MISSING: 'round2-item9-lineage-missing',
  LINEAGE_CONFLICT: 'round2-item9-lineage-conflict',
  ADMISSION_EVIDENCE_INVALID: 'round2-item9-admission-evidence-invalid',
  LEGACY_ADMISSION_EVIDENCE_INSUFFICIENT: 'legacy-admission-evidence-insufficient',
  APPLY_STATE_INVALID: 'round2-item9-apply-state-invalid',
  APPLY_STATE_CONFLICT: 'round2-item9-apply-state-conflict',
  APPLY_PENDING_UNRESOLVED: 'round2-item9-apply-pending-unresolved',
  LOCAL_PUBLICATION_LEDGER_INVALID: 'local-publication-ledger-invalid',
  LOCAL_PUBLICATION_LEDGER_CONFLICT: 'local-publication-ledger-conflict',
  /* Foreign-lane retirement. Narrow by construction: these can only be reached
   * through retireLocalPublicationForeignIntent, which names one exact row. */
  LOCAL_PUBLICATION_FOREIGN_INTENT_NOT_FOUND:
    'local-publication-foreign-intent-not-found',
  LOCAL_PUBLICATION_FOREIGN_INTENT_MISMATCH:
    'local-publication-foreign-intent-mismatch',
  LOCAL_PUBLICATION_FOREIGN_INTENT_NOT_FOREIGN:
    'local-publication-foreign-intent-not-foreign',
  LOCAL_PUBLICATION_FOREIGN_INTENT_NOT_PENDING:
    'local-publication-foreign-intent-not-pending',
  LOCAL_PUBLICATION_PENDING_UNRESOLVED: 'local-publication-pending-unresolved',
  BRANCH_EVIDENCE_INVALID: 'p02-z6-branch-evidence-invalid',
  BRANCH_EVIDENCE_CONFLICT: 'p02-z6-branch-evidence-conflict'
});

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

class Item9StoreError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Item9StoreError';
    this.code = code;
  }
}

function fail(code) {
  throw new Item9StoreError(code);
}

function safeCode(error, fallback) {
  const value = error && typeof error.code === 'string' ? error.code : '';
  return Object.values(ERROR_CODE).includes(value) ? value : fallback;
}

function safeIdentityCode(error) {
  const value = error && typeof error.code === 'string' ? error.code : '';
  return [
    ERROR_CODE.IDENTITY_UNAVAILABLE,
    ERROR_CODE.IDENTITY_MALFORMED,
    ERROR_CODE.IDENTITY_CLASSIFICATION_UNSUPPORTED
  ].includes(value) ? value : ERROR_CODE.IDENTITY_UNAVAILABLE;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyId(value) {
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
  if (ArrayBuffer.isView(value) && value.constructor && value.constructor.name === 'Uint8Array') {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
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

function textBytes(value) {
  return new TextEncoder().encode(value);
}

async function sha256Hex(cryptoImplementation, bytes, failureCode) {
  if (!cryptoImplementation?.subtle || typeof cryptoImplementation.subtle.digest !== 'function') {
    fail(failureCode);
  }
  try {
    const digest = await cryptoImplementation.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    fail(failureCode);
  }
}

function validateChromeIdentity(raw) {
  if (!isPlainObject(raw) ||
      raw.schema !== EXPECTED_IDENTITY.schema ||
      !UUID_V4_RE.test(raw.installId || '') ||
      !UUID_V4_RE.test(raw.physicalDeviceId || '') ||
      typeof raw.syncPeerId !== 'string' ||
      typeof raw.displayName !== 'string' ||
      !isIsoTimestamp(raw.createdAt) ||
      !isIsoTimestamp(raw.updatedAt) ||
      !Array.isArray(raw.surfaceHistory)) {
    fail(ERROR_CODE.IDENTITY_MALFORMED);
  }
  if (raw.surfaceKind !== EXPECTED_IDENTITY.surfaceKind ||
      raw.appKind !== EXPECTED_IDENTITY.appKind ||
      raw.storeKind !== EXPECTED_IDENTITY.storeKind) {
    fail(ERROR_CODE.IDENTITY_CLASSIFICATION_UNSUPPORTED);
  }
  const expectedPeerId = [
    EXPECTED_IDENTITY.surfaceKind,
    EXPECTED_IDENTITY.appKind,
    EXPECTED_IDENTITY.storeKind,
    raw.installId
  ].join(':');
  if (raw.syncPeerId !== expectedPeerId) {
    fail(ERROR_CODE.IDENTITY_MALFORMED);
  }
  return raw;
}

export function createChromePeerIdentityReadiness({
  identityProvider,
  cryptoImplementation = globalThis.crypto
} = {}) {
  let readinessPromise = null;

  async function resolveIdentity() {
    if (!identityProvider || typeof identityProvider.whenSyncReady !== 'function') {
      fail(ERROR_CODE.IDENTITY_UNAVAILABLE);
    }
    let raw;
    try {
      raw = await identityProvider.whenSyncReady();
    } catch (error) {
      fail(safeIdentityCode(error));
    }
    if (raw == null) fail(ERROR_CODE.IDENTITY_UNAVAILABLE);
    const identity = validateChromeIdentity(raw);
    const peerFingerprintSha256Hex = await sha256Hex(
      cryptoImplementation,
      textBytes(identity.syncPeerId),
      ERROR_CODE.IDENTITY_UNAVAILABLE
    );
    return Object.freeze({
      ok: true,
      schema: EXPECTED_IDENTITY.schema,
      surfaceKind: EXPECTED_IDENTITY.surfaceKind,
      appKind: EXPECTED_IDENTITY.appKind,
      storeKind: EXPECTED_IDENTITY.storeKind,
      peerFingerprintSha256Hex
    });
  }

  return Object.freeze({
    whenReady() {
      if (!readinessPromise) readinessPromise = resolveIdentity();
      return readinessPromise;
    }
  });
}

function migrationV1(database) {
  if (database.objectStoreNames.contains(AUTHORITY_STORE) ||
      database.objectStoreNames.contains(OBSERVATION_STORE)) {
    fail(ERROR_CODE.MIGRATION_FAILED);
  }
  database.createObjectStore(AUTHORITY_STORE, { keyPath: 'key' });
  database.createObjectStore(OBSERVATION_STORE, { keyPath: 'key' });
}

function migrationV2(database) {
  if (database.objectStoreNames.contains(LOCAL_PUBLICATION_LEDGER_STORE)) {
    fail(ERROR_CODE.MIGRATION_FAILED);
  }
  database.createObjectStore(LOCAL_PUBLICATION_LEDGER_STORE, {
    keyPath: 'key'
  });
}

function migrationV3(database) {
  if (database.objectStoreNames.contains(ADMISSION_EVIDENCE_STORE) ||
      database.objectStoreNames.contains(APPLY_STATE_STORE)) {
    fail(ERROR_CODE.MIGRATION_FAILED);
  }
  database.createObjectStore(ADMISSION_EVIDENCE_STORE, { keyPath: 'key' });
  database.createObjectStore(APPLY_STATE_STORE, { keyPath: 'key' });
}

/*
 * P02 Wave 1 / Z6, frozen V2. Purely additive: it creates one new store and
 * touches no accepted store, so every accepted observation, admission
 * evidence, apply-state and ledger record survives the upgrade byte-intact.
 * Deleting accepted stores is NOT authorized by the frozen contract.
 */
function migrationV4(database) {
  if (database.objectStoreNames.contains(BRANCH_EVIDENCE_STORE)) {
    fail(ERROR_CODE.MIGRATION_FAILED);
  }
  database.createObjectStore(BRANCH_EVIDENCE_STORE, { keyPath: 'key' });
}

export const MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, migrate: migrationV1 }),
  Object.freeze({ version: 2, migrate: migrationV2 }),
  Object.freeze({ version: 3, migrate: migrationV3 }),
  Object.freeze({ version: 4, migrate: migrationV4 })
]);

export function validateMigrationRegistry(
  migrations,
  expectedVersion = DATABASE_VERSION
) {
  if (!Array.isArray(migrations) || migrations.length !== expectedVersion) {
    fail(ERROR_CODE.MIGRATION_FAILED);
  }
  const seen = new Set();
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    const expected = index + 1;
    if (!isPlainObject(migration) ||
        migration.version !== expected ||
        seen.has(migration.version) ||
        typeof migration.migrate !== 'function') {
      fail(ERROR_CODE.MIGRATION_FAILED);
    }
    seen.add(migration.version);
  }
  return true;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('request-failed'));
  });
}

function transactionResult(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('transaction-failed'));
    transaction.onabort = () => reject(transaction.error || new Error('transaction-aborted'));
  });
}

function abortQuietly(transaction) {
  try {
    transaction.abort();
  } catch (_) {
    // The transaction may already have been aborted by IndexedDB.
  }
}

function openDatabase(indexedDBFactory, migrations, onVersionChange) {
  validateMigrationRegistry(migrations);
  if (!indexedDBFactory || typeof indexedDBFactory.open !== 'function') {
    return Promise.reject(new Item9StoreError(ERROR_CODE.DATABASE_OPEN_FAILED));
  }

  return new Promise((resolve, reject) => {
    let request;
    let upgradeFailed = false;
    let settled = false;
    function rejectOnce(error) {
      if (settled) return;
      settled = true;
      reject(error);
    }
    try {
      request = indexedDBFactory.open(DATABASE_NAME, DATABASE_VERSION);
    } catch (_) {
      rejectOnce(new Item9StoreError(ERROR_CODE.DATABASE_OPEN_FAILED));
      return;
    }

    request.onupgradeneeded = (event) => {
      try {
        const oldVersion = Number(event.oldVersion || 0);
        if (oldVersion > DATABASE_VERSION) {
          fail(ERROR_CODE.DATABASE_VERSION_UNSUPPORTED);
        }
        for (const migration of migrations) {
          if (migration.version > oldVersion) migration.migrate(request.result, request.transaction);
        }
      } catch (_) {
        upgradeFailed = true;
        abortQuietly(request.transaction);
      }
    };
    request.onblocked = () => {
      rejectOnce(new Item9StoreError(ERROR_CODE.DATABASE_OPEN_FAILED));
    };
    request.onerror = () => {
      if (settled) return;
      const name = request.error && request.error.name;
      if (name === 'VersionError') {
        rejectOnce(new Item9StoreError(ERROR_CODE.DATABASE_VERSION_UNSUPPORTED));
      } else if (upgradeFailed || name === 'AbortError') {
        rejectOnce(new Item9StoreError(ERROR_CODE.MIGRATION_FAILED));
      } else {
        rejectOnce(new Item9StoreError(ERROR_CODE.DATABASE_OPEN_FAILED));
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        try { database.close(); } catch (_) { /* ignore */ }
        return;
      }
      if (database.version !== DATABASE_VERSION ||
          !database.objectStoreNames.contains(AUTHORITY_STORE) ||
          !database.objectStoreNames.contains(OBSERVATION_STORE) ||
          !database.objectStoreNames.contains(LOCAL_PUBLICATION_LEDGER_STORE) ||
          !database.objectStoreNames.contains(ADMISSION_EVIDENCE_STORE) ||
          !database.objectStoreNames.contains(APPLY_STATE_STORE)) {
        try { database.close(); } catch (_) { /* ignore */ }
        rejectOnce(new Item9StoreError(ERROR_CODE.MIGRATION_FAILED));
        return;
      }
      database.onversionchange = () => {
        try { database.close(); } catch (_) { /* ignore */ }
        if (typeof onVersionChange === 'function') onVersionChange(database);
      };
      settled = true;
      resolve(database);
    };
  });
}

function cloneObservation(record) {
  if (!record) return null;
  return {
    ...record,
    revisionBlobBytes: bytesFrom(record.revisionBlobBytes)
  };
}

function safeObservation(record) {
  if (!record) return null;
  return Object.freeze({
    schema: record.schema,
    schemaVersion: record.schemaVersion,
    peerFingerprintSha256Hex: record.peerFingerprintSha256Hex,
    objectKeySha256Hex: record.objectKeySha256Hex,
    revisionKeySha256Hex: record.revisionKeySha256Hex,
    revisionBlobSha256Hex: record.revisionBlobSha256Hex,
    payloadSha256Hex: record.payloadSha256Hex,
    parentRevisionId: record.parentRevisionId,
    observedState: record.observedState,
    applyState: record.applyState,
    firstObservedAt: record.firstObservedAt,
    lastObservedAt: record.lastObservedAt,
    observationCount: record.observationCount,
    statusCode: record.statusCode
  });
}

function immutableObservationFieldsMatch(existing, proposed) {
  return existing.key === proposed.key &&
    existing.peerObjectKey === proposed.peerObjectKey &&
    existing.schema === proposed.schema &&
    existing.schemaVersion === proposed.schemaVersion &&
    existing.peerFingerprintSha256Hex === proposed.peerFingerprintSha256Hex &&
    existing.objectId === proposed.objectId &&
    existing.objectKeySha256Hex === proposed.objectKeySha256Hex &&
    existing.revisionId === proposed.revisionId &&
    existing.revisionKeySha256Hex === proposed.revisionKeySha256Hex &&
    existing.revisionBlobSha256Hex === proposed.revisionBlobSha256Hex &&
    existing.payloadSha256Hex === proposed.payloadSha256Hex &&
    existing.parentRevisionId === proposed.parentRevisionId &&
    existing.observedState === proposed.observedState &&
    existing.applyState === proposed.applyState &&
    existing.statusCode === proposed.statusCode &&
    isIsoTimestamp(existing.firstObservedAt) &&
    isIsoTimestamp(existing.lastObservedAt) &&
    Number.isSafeInteger(existing.observationCount) &&
    existing.observationCount > 0 &&
    bytesEqual(existing.revisionBlobBytes, proposed.revisionBlobBytes);
}

function exactObservationRecordMatch(existing, expected) {
  return immutableObservationFieldsMatch(existing, expected) &&
    existing.firstObservedAt === expected.firstObservedAt &&
    existing.lastObservedAt === expected.lastObservedAt &&
    existing.observationCount === expected.observationCount;
}

function cloneAdmissionEvidence(record) {
  if (!record) return null;
  return {
    ...record,
    headBytes: bytesFrom(record.headBytes)
  };
}

function immutableAdmissionEvidenceMatches(left, right) {
  return isPlainObject(left) &&
    isPlainObject(right) &&
    left.key === right.key &&
    left.schema === right.schema &&
    left.schemaVersion === right.schemaVersion &&
    left.peerFingerprintSha256Hex === right.peerFingerprintSha256Hex &&
    left.headSha256Hex === right.headSha256Hex &&
    bytesEqual(left.headBytes, right.headBytes);
}

function validateAdmissionEvidenceRecord(record, observation, fingerprint) {
  const headBytes = bytesFrom(record?.headBytes);
  if (!isPlainObject(record) ||
      !isPlainObject(observation) ||
      record.key !== observation.key ||
      record.schema !== ADMISSION_EVIDENCE_SCHEMA ||
      record.schemaVersion !== ADMISSION_EVIDENCE_SCHEMA_VERSION ||
      record.peerFingerprintSha256Hex !== fingerprint ||
      observation.peerFingerprintSha256Hex !== fingerprint ||
      !SHA256_RE.test(record.headSha256Hex || '') ||
      !headBytes ||
      headBytes.byteLength === 0 ||
      headBytes.byteLength > MAX_HEAD_BYTES) {
    fail(ERROR_CODE.ADMISSION_EVIDENCE_INVALID);
  }
  return {
    ...record,
    headBytes
  };
}

function validateApplyReference(value) {
  if (isPlainObject(value) && value.referenceKind === 'branch-evidence-v2') {
    const nullableId = (candidate) => candidate === null || isNonEmptyId(candidate);
    const nullableHash = (candidate) => candidate === null || SHA256_RE.test(candidate || '');
    if (!isNonEmptyId(value.objectDomain) ||
        !SHA256_RE.test(value.objectKey || '') ||
        !isNonEmptyId(value.writerSyncPeerId) ||
        !SHA256_RE.test(value.writerKey || '') ||
        !isNonEmptyId(value.selectedLeafRevisionId) ||
        !SHA256_RE.test(value.selectedLeafRevisionBlobSha256Hex || '') ||
        !isNonEmptyId(value.revisionId) ||
        !nullableId(value.parentRevisionId) ||
        !nullableHash(value.parentRevisionBlobSha256Hex) ||
        ((value.parentRevisionId === null) !==
          (value.parentRevisionBlobSha256Hex === null)) ||
        !isNonEmptyId(value.branchEvidenceKey) ||
        !SHA256_RE.test(value.revisionBlobSha256Hex || '') ||
        !SHA256_RE.test(value.payloadSha256Hex || '') ||
        !isNonEmptyId(value.sourceRevisionId) ||
        !nullableId(value.canonicalAnchorRevisionId) ||
        !nullableHash(value.canonicalAnchorRevisionBlobSha256Hex) ||
        ((value.canonicalAnchorRevisionId === null) !==
          (value.canonicalAnchorRevisionBlobSha256Hex === null)) ||
        !nullableId(value.canonicalPreStateRevisionId) ||
        !nullableHash(value.canonicalPreStatePayloadSha256Hex) ||
        ((value.canonicalPreStateRevisionId === null) !==
          (value.canonicalPreStatePayloadSha256Hex === null)) ||
        value.parentRevisionId !== value.canonicalAnchorRevisionId ||
        value.parentRevisionBlobSha256Hex !==
          value.canonicalAnchorRevisionBlobSha256Hex) {
      fail(ERROR_CODE.APPLY_STATE_INVALID);
    }
    return {
      referenceKind: value.referenceKind,
      objectDomain: value.objectDomain,
      objectKey: value.objectKey,
      writerSyncPeerId: value.writerSyncPeerId,
      writerKey: value.writerKey,
      selectedLeafRevisionId: value.selectedLeafRevisionId,
      selectedLeafRevisionBlobSha256Hex:
        value.selectedLeafRevisionBlobSha256Hex,
      revisionId: value.revisionId,
      parentRevisionId: value.parentRevisionId,
      parentRevisionBlobSha256Hex: value.parentRevisionBlobSha256Hex,
      branchEvidenceKey: value.branchEvidenceKey,
      revisionBlobSha256Hex: value.revisionBlobSha256Hex,
      payloadSha256Hex: value.payloadSha256Hex,
      sourceRevisionId: value.sourceRevisionId,
      canonicalAnchorRevisionId: value.canonicalAnchorRevisionId,
      canonicalAnchorRevisionBlobSha256Hex:
        value.canonicalAnchorRevisionBlobSha256Hex,
      canonicalPreStateRevisionId: value.canonicalPreStateRevisionId,
      canonicalPreStatePayloadSha256Hex: value.canonicalPreStatePayloadSha256Hex
    };
  }
  if (!isPlainObject(value) ||
      !isNonEmptyId(value.revisionId) ||
      (value.parentRevisionId !== null &&
        !isNonEmptyId(value.parentRevisionId)) ||
      !isNonEmptyId(value.observationKey) ||
      !SHA256_RE.test(value.revisionBlobSha256Hex || '') ||
      !SHA256_RE.test(value.payloadSha256Hex || '') ||
      !SHA256_RE.test(value.headSha256Hex || '')) {
    fail(ERROR_CODE.APPLY_STATE_INVALID);
  }
  return {
    revisionId: value.revisionId,
    parentRevisionId: value.parentRevisionId,
    observationKey: value.observationKey,
    revisionBlobSha256Hex: value.revisionBlobSha256Hex,
    payloadSha256Hex: value.payloadSha256Hex,
    headSha256Hex: value.headSha256Hex
  };
}

function applyReferenceMatches(left, right) {
  if (!left || !right) return left === right;
  if (left.referenceKind === 'branch-evidence-v2' ||
      right.referenceKind === 'branch-evidence-v2') {
    return left.referenceKind === right.referenceKind &&
      JSON.stringify(left) === JSON.stringify(right);
  }
  return left.revisionId === right.revisionId &&
    left.parentRevisionId === right.parentRevisionId &&
    left.observationKey === right.observationKey &&
    left.revisionBlobSha256Hex === right.revisionBlobSha256Hex &&
    left.payloadSha256Hex === right.payloadSha256Hex &&
    left.headSha256Hex === right.headSha256Hex;
}

function validateApplyStateRecord(record, fingerprint, keys, objectId) {
  if (record == null) return null;
  if (!isPlainObject(record) ||
      record.key !== keys.peerObjectKey ||
      record.schema !== APPLY_STATE_SCHEMA ||
      record.schemaVersion !== APPLY_STATE_SCHEMA_VERSION ||
      record.peerFingerprintSha256Hex !== fingerprint ||
      record.objectId !== objectId ||
      record.objectKeySha256Hex !== keys.objectKeySha256Hex ||
      /* The single convergence-direction cell for this (peer, object). Optional
       * so pre-amendment records stay valid and read as legacy. */
      (record.convergedDirection != null && !isConvergedDirection(record.convergedDirection)) ||
      (record.publishedPayloadSha256Hex != null &&
        !SHA256_RE.test(record.publishedPayloadSha256Hex)) ||
      !isIsoTimestamp(record.updatedAt)) {
    fail(ERROR_CODE.APPLY_STATE_INVALID);
  }
  return {
    ...record,
    lastApplied: record.lastApplied === null
      ? null
      : validateApplyReference(record.lastApplied),
    pending: record.pending === null
      ? null
      : validateApplyReference(record.pending)
  };
}

function cloneApplyState(record) {
  if (!record) return null;
  return Object.freeze({
    ...record,
    lastApplied: record.lastApplied
      ? Object.freeze({ ...record.lastApplied })
      : null,
    pending: record.pending
      ? Object.freeze({ ...record.pending })
      : null
  });
}

function validateLinearObservationGraph(observations) {
  if (observations.length === 0) return null;
  const byRevision = new Map();
  const childByParent = new Map();
  for (const observation of observations) {
    if (byRevision.has(observation.revisionId)) {
      fail(ERROR_CODE.LINEAGE_CONFLICT);
    }
    byRevision.set(observation.revisionId, observation);
    if (observation.parentRevisionId !== null) {
      if (observation.parentRevisionId === observation.revisionId ||
          childByParent.has(observation.parentRevisionId)) {
        fail(ERROR_CODE.LINEAGE_CONFLICT);
      }
      childByParent.set(
        observation.parentRevisionId,
        observation.revisionId
      );
    }
  }
  // Locally authored revisions are canonical lineage anchors but are not
  // inbound observations. The durable observation graph can therefore be a
  // set of non-branching admitted segments whose oldest parent is external.
  // Admission proves each such external parent against the current canonical
  // state; stored validation still forbids sibling children and cycles.
  for (const observation of observations) {
    const visited = new Set();
    let current = observation;
    while (current) {
      if (visited.has(current.revisionId)) fail(ERROR_CODE.LINEAGE_CONFLICT);
      visited.add(current.revisionId);
      current = current.parentRevisionId === null
        ? null
        : byRevision.get(current.parentRevisionId) || null;
    }
  }
  return true;
}

function uniqueStructuralTip(observations) {
  if (observations.length === 0) return null;
  const parentIds = new Set(observations
    .map((observation) => observation.parentRevisionId)
    .filter((revisionId) => revisionId !== null));
  const tips = observations.filter((observation) =>
    !parentIds.has(observation.revisionId));
  return tips.length === 1 ? tips[0].revisionId : undefined;
}

function validateAtomicObservationSnapshot(current, validated, proposed) {
  const currentByRevision = new Map();
  for (const observation of current) {
    if (currentByRevision.has(observation.revisionId)) {
      fail(ERROR_CODE.LINEAGE_CONFLICT);
    }
    currentByRevision.set(observation.revisionId, observation);
  }
  const validatedByRevision = new Map(
    validated.map((observation) => [observation.revisionId, observation])
  );
  for (const observation of validated) {
    const currentObservation = currentByRevision.get(observation.revisionId);
    if (!currentObservation) fail(ERROR_CODE.LINEAGE_CONFLICT);
    if (observation.revisionId === proposed.revisionId) {
      if (!immutableObservationFieldsMatch(currentObservation, proposed) ||
          currentObservation.firstObservedAt !== observation.firstObservedAt ||
          currentObservation.observationCount < observation.observationCount) {
        fail(ERROR_CODE.LINEAGE_CONFLICT);
      }
    } else if (!exactObservationRecordMatch(currentObservation, observation)) {
      fail(ERROR_CODE.LINEAGE_CONFLICT);
    }
  }
  for (const observation of current) {
    if (validatedByRevision.has(observation.revisionId)) continue;
    if (observation.revisionId !== proposed.revisionId ||
        !immutableObservationFieldsMatch(observation, proposed)) {
      fail(ERROR_CODE.LINEAGE_CONFLICT);
    }
  }
}

function validateObservationInput(input) {
  if (!isPlainObject(input) ||
      !isNonEmptyId(input.objectId) ||
      !isNonEmptyId(input.revisionId) ||
      !SHA256_RE.test(input.revisionBlobSha256Hex || '') ||
      (input.payloadSha256Hex != null && !SHA256_RE.test(input.payloadSha256Hex)) ||
      (input.parentRevisionId != null && !isNonEmptyId(input.parentRevisionId))) {
    fail(ERROR_CODE.OBSERVATION_INVALID);
  }
  const revisionBlobBytes = bytesFrom(input.revisionBlobBytes);
  if (!revisionBlobBytes ||
      revisionBlobBytes.byteLength === 0 ||
      revisionBlobBytes.byteLength > MAX_BLOB_BYTES) {
    fail(ERROR_CODE.OBSERVATION_INVALID);
  }
  return revisionBlobBytes;
}

function ledgerKey(peerFingerprintSha256Hex, objectKey) {
  return `v1:${peerFingerprintSha256Hex}:${objectKey}`;
}

/*
 * A1 identity amendment. The direction names which anchor a row's payload
 * identity belongs to, so convergence never has to compare envelope hashes from
 * different representation domains. Absent ⇒ the legacy comparator regime,
 * which is exactly how every pre-amendment record already behaves.
 */
const CONVERGED_DIRECTION = Object.freeze({ PUBLISHED: 'published', APPLIED: 'applied' });

function isConvergedDirection(value) {
  return value === CONVERGED_DIRECTION.PUBLISHED || value === CONVERGED_DIRECTION.APPLIED;
}

function validatePublicationTip(value, objectKey) {
  if (value === null) return null;
  if (!isPlainObject(value) ||
      value.objectKey !== objectKey ||
      !isNonEmptyId(value.revisionId) ||
      (value.previousRevisionId !== null &&
        !isNonEmptyId(value.previousRevisionId)) ||
      !SHA256_RE.test(value.revisionBlobSha256Hex || '') ||
      !SHA256_RE.test(value.headSha256Hex || '') ||
      /* Optional by design: tips written before the amendment carry no payload
       * identity, and must stay readable rather than becoming invalid. */
      (value.payloadSha256Hex != null && !SHA256_RE.test(value.payloadSha256Hex)) ||
      !isIsoTimestamp(value.producedAtIso)) {
    fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
  }
  return value;
}

function validatePublicationRequest(value, objectKey) {
  const revisionBlobBytes = bytesFrom(value?.revisionBlobBytes);
  const headBytes = bytesFrom(value?.headBytes);
  if (!isPlainObject(value) ||
      !isNonEmptyId(value.objectId) ||
      value.objectKey !== objectKey ||
      !isNonEmptyId(value.revisionId) ||
      (value.previousRevisionId !== null &&
        !isNonEmptyId(value.previousRevisionId)) ||
      !SHA256_RE.test(value.revisionBlobSha256Hex || '') ||
      !SHA256_RE.test(value.headSha256Hex || '') ||
      !isIsoTimestamp(value.producedAtIso) ||
      !revisionBlobBytes || revisionBlobBytes.byteLength === 0 ||
      revisionBlobBytes.byteLength > MAX_BLOB_BYTES ||
      !headBytes || headBytes.byteLength === 0 ||
      headBytes.byteLength > MAX_BLOB_BYTES) {
    fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
  }
  let p02Plan = null;
  if (value.p02Plan != null) {
    const plan = value.p02Plan;
    if (!isPlainObject(plan) ||
        !isNonEmptyId(plan.writerSyncPeerId) ||
        (plan.expectedCurrentHeadsSnapshotSha256 !== null &&
          !SHA256_RE.test(plan.expectedCurrentHeadsSnapshotSha256 || '')) ||
        (plan.anchorRevisionId !== null && !isNonEmptyId(plan.anchorRevisionId)) ||
        (plan.anchorRevisionBlobSha256 !== null &&
          !SHA256_RE.test(plan.anchorRevisionBlobSha256 || '')) ||
        (plan.anchorPayloadSha256 !== null &&
          !SHA256_RE.test(plan.anchorPayloadSha256 || ''))) {
      fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
    }
    p02Plan = Object.freeze({
      writerSyncPeerId: plan.writerSyncPeerId,
      expectedCurrentHeadsSnapshotSha256:
        plan.expectedCurrentHeadsSnapshotSha256,
      anchorRevisionId: plan.anchorRevisionId,
      anchorRevisionBlobSha256: plan.anchorRevisionBlobSha256,
      anchorPayloadSha256: plan.anchorPayloadSha256
    });
  }
  return {
    ...value,
    revisionBlobBytes,
    headBytes,
    p02Plan
  };
}

/*
 * 'retired-foreign-lane' is a RETAINED, non-pending historical state. The row
 * and its staged bytes stay in the ledger as evidence of what the retired slot
 * lane produced, but the row no longer participates in pending resolution or in
 * background recovery, so it cannot block or be adopted by the repository-native
 * P02 lane. Nothing is ever deleted.
 */
const LOCAL_PUBLICATION_RETIRED_FOREIGN_LANE = 'retired-foreign-lane';
const LOCAL_PUBLICATION_PENDING_STATES = [
  'promote-ready',
  'resume-retry',
  'terminal-unresolved',
  LOCAL_PUBLICATION_RETIRED_FOREIGN_LANE
];

/*
 * ONE definition of "is this pending row still live publication state?", used by
 * every path that asks. Staging, resolution, recovery, retry and commit had
 * each been asking `existing?.pending`, which is a question about a FIELD, not
 * about a STATE - so a retained historical row read as an unresolved intent and
 * blocked the very staging its retirement existed to unblock.
 *
 * 'retired-foreign-lane' is historical evidence: not pending, not retryable,
 * not resumable, not recovery-eligible, and never a blocker. Every other state -
 * promote-ready, resume-retry and terminal-unresolved - is unchanged and still
 * blocks exactly as before.
 */
function isBlockingPendingPublication(pending) {
  return !!pending && pending.state !== LOCAL_PUBLICATION_RETIRED_FOREIGN_LANE;
}

/*
 * Durable retirement history. The row model holds ONE pending slot, so a fresh
 * intent must be free to occupy it; the evidence of what was retired is moved
 * here first and is append-only, so nothing is lost when the slot is reused and
 * nothing is ever deleted.
 */
function validateRetiredForeignIntents(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
  return value.map((entry) => {
    if (!isPlainObject(entry) ||
        !isNonEmptyId(entry.revisionId) ||
        !SHA256_RE.test(entry.revisionBlobSha256Hex || '') ||
        !SHA256_RE.test(entry.headSha256Hex || '') ||
        !isIsoTimestamp(entry.stagedAt) ||
        !isIsoTimestamp(entry.retiredAt) ||
        !Number.isInteger(entry.stagedBytes) || entry.stagedBytes < 0 ||
        !isNonEmptyId(entry.priorState)) {
      fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
    }
    return Object.freeze({
      revisionId: entry.revisionId,
      previousRevisionId: entry.previousRevisionId ?? null,
      revisionBlobSha256Hex: entry.revisionBlobSha256Hex,
      headSha256Hex: entry.headSha256Hex,
      producedAtIso: entry.producedAtIso ?? null,
      stagedAt: entry.stagedAt,
      retiredAt: entry.retiredAt,
      stagedBytes: entry.stagedBytes,
      priorState: entry.priorState,
      retiredState: LOCAL_PUBLICATION_RETIRED_FOREIGN_LANE
    });
  });
}

function validatePendingPublication(value, objectKey) {
  if (value === null) return null;
  if (!isPlainObject(value) ||
      !LOCAL_PUBLICATION_PENDING_STATES.includes(value.state) ||
      (value.errorCode !== null && !isNonEmptyId(value.errorCode))) {
    fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
  }
  return {
    state: value.state,
    errorCode: value.errorCode,
    request: validatePublicationRequest(value.request, objectKey)
  };
}

function validateLedgerRecord(record, fingerprint, objectKey) {
  if (record == null) return null;
  if (!isPlainObject(record) ||
      record.key !== ledgerKey(fingerprint, objectKey) ||
      record.schema !== LOCAL_PUBLICATION_LEDGER_SCHEMA ||
      record.schemaVersion !== LOCAL_PUBLICATION_LEDGER_SCHEMA_VERSION ||
      record.peerFingerprintSha256Hex !== fingerprint ||
      !isNonEmptyId(record.objectId) ||
      record.objectKey !== objectKey ||
      /* The single convergence-direction cell for this (peer, objectKey). It
       * records ONLY which anchor is current; the payload identity stays on the
       * anchor that owns it, so this can never become a second authority.
       * Absent ⇒ the legacy comparator regime. */
      (record.convergedDirection != null &&
        !isConvergedDirection(record.convergedDirection)) ||
      !isIsoTimestamp(record.updatedAt)) {
    fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
  }
  const retiredForeignIntents = validateRetiredForeignIntents(
    record.retiredForeignIntents
  );
  const pending = validatePendingPublication(record.pending, objectKey);
  if (pending && pending.request.objectId !== record.objectId) {
    fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
  }
  return {
    ...record,
    retiredForeignIntents,
    tip: validatePublicationTip(record.tip, objectKey),
    pending
  };
}

function clonePublicationTip(tip) {
  return tip ? Object.freeze({ ...tip }) : null;
}

function safePending(pending) {
  if (!pending) return null;
  return Object.freeze({
    state: pending.state,
    errorCode: pending.errorCode,
    request: Object.freeze({
      ...pending.request,
      revisionBlobBytes: bytesFrom(pending.request.revisionBlobBytes),
      headBytes: bytesFrom(pending.request.headBytes)
    })
  });
}

function immutablePublicationRequestMatches(left, right) {
  return left.objectId === right.objectId &&
    left.objectKey === right.objectKey &&
    left.revisionId === right.revisionId &&
    left.previousRevisionId === right.previousRevisionId &&
    left.revisionBlobSha256Hex === right.revisionBlobSha256Hex &&
    left.headSha256Hex === right.headSha256Hex &&
    bytesEqual(left.revisionBlobBytes, right.revisionBlobBytes) &&
    bytesEqual(left.headBytes, right.headBytes) &&
    JSON.stringify(left.p02Plan ?? null) === JSON.stringify(right.p02Plan ?? null);
}

export function createChromeSyncObjectStore({
  identityProvider,
  indexedDBFactory = globalThis.indexedDB,
  cryptoImplementation = globalThis.crypto,
  clock = () => new Date().toISOString(),
  migrations = MIGRATIONS
} = {}) {
  const identityReadiness = createChromePeerIdentityReadiness({
    identityProvider,
    cryptoImplementation
  });
  let readyPromise = null;
  let database = null;
  let peerFingerprintSha256Hex = null;

  function authorityRecordMatches(record, fingerprint) {
    return isPlainObject(record) &&
      record.schema === AUTHORITY_SCHEMA &&
      record.schemaVersion === AUTHORITY_SCHEMA_VERSION &&
      record.peerFingerprintSha256Hex === fingerprint;
  }

  async function ensureAuthority(db, fingerprint) {
    const transaction = db.transaction(
      [
        AUTHORITY_STORE,
        OBSERVATION_STORE,
        LOCAL_PUBLICATION_LEDGER_STORE,
        ADMISSION_EVIDENCE_STORE,
        APPLY_STATE_STORE
      ],
      'readwrite'
    );
    const completion = transactionResult(transaction);
    try {
      const authorityStore = transaction.objectStore(AUTHORITY_STORE);
      const observationStore = transaction.objectStore(OBSERVATION_STORE);
      const ledgerStore = transaction.objectStore(
        LOCAL_PUBLICATION_LEDGER_STORE
      );
      const evidenceStore = transaction.objectStore(ADMISSION_EVIDENCE_STORE);
      const applyStateStore = transaction.objectStore(APPLY_STATE_STORE);
      const existing = await requestResult(authorityStore.get(AUTHORITY_KEY));
      if (existing) {
        if (!authorityRecordMatches(existing, fingerprint)) {
          fail(ERROR_CODE.PEER_AUTHORITY_MISMATCH);
        }
      } else {
        const observationCount = await requestResult(observationStore.count());
        const ledgerCount = await requestResult(ledgerStore.count());
        const evidenceCount = await requestResult(evidenceStore.count());
        const applyStateCount = await requestResult(applyStateStore.count());
        if (observationCount !== 0 ||
            ledgerCount !== 0 ||
            evidenceCount !== 0 ||
            applyStateCount !== 0) {
          fail(ERROR_CODE.PEER_AUTHORITY_MISMATCH);
        }
        await requestResult(authorityStore.add({
          key: AUTHORITY_KEY,
          schema: AUTHORITY_SCHEMA,
          schemaVersion: AUTHORITY_SCHEMA_VERSION,
          peerFingerprintSha256Hex: fingerprint
        }));
      }
      await completion;
    } catch (error) {
      abortQuietly(transaction);
      try { await completion; } catch (_) { /* expected after abort */ }
      fail(safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED));
    }
  }

  async function verifyAuthority(db, fingerprint) {
    const transaction = db.transaction([AUTHORITY_STORE], 'readonly');
    const completion = transactionResult(transaction);
    let existing;
    try {
      existing = await requestResult(
        transaction.objectStore(AUTHORITY_STORE).get(AUTHORITY_KEY)
      );
      await completion;
    } catch (error) {
      abortQuietly(transaction);
      try { await completion; } catch (_) { /* expected after abort */ }
      fail(safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED));
    }
    if (!authorityRecordMatches(existing, fingerprint)) {
      fail(ERROR_CODE.PEER_AUTHORITY_MISMATCH);
    }
    return existing;
  }

  function invalidateDatabase(changedDatabase) {
    if (database !== changedDatabase) return;
    database = null;
    peerFingerprintSha256Hex = null;
    readyPromise = null;
  }

  async function initialize() {
    const identity = await identityReadiness.whenReady();
    let opened;
    try {
      opened = await openDatabase(
        indexedDBFactory,
        migrations,
        invalidateDatabase
      );
      await ensureAuthority(opened, identity.peerFingerprintSha256Hex);
    } catch (error) {
      try { opened?.close(); } catch (_) { /* ignore */ }
      throw new Item9StoreError(safeCode(error, ERROR_CODE.DATABASE_OPEN_FAILED));
    }
    database = opened;
    peerFingerprintSha256Hex = identity.peerFingerprintSha256Hex;
    return Object.freeze({
      ok: true,
      databaseSchemaVersion: DATABASE_VERSION,
      peerFingerprintSha256Hex
    });
  }

  async function ready() {
    if (!readyPromise) {
      readyPromise = initialize().catch((error) => {
        readyPromise = null;
        throw error;
      });
    }
    return readyPromise;
  }

  async function activeDatabase() {
    await ready();
    if (!database) fail(ERROR_CODE.DATABASE_OPEN_FAILED);
    await verifyAuthority(database, peerFingerprintSha256Hex);
    return database;
  }

  function safeBranchEvidence(record) {
    const { revisionBlobBytes, ...rest } = record;
    return Object.freeze({
      ...rest,
      revisionBlobByteLength: revisionBlobBytes?.byteLength ?? 0
    });
  }

  async function identityKeys(objectId, revisionId) {
    const objectKeySha256Hex = await sha256Hex(
      cryptoImplementation,
      textBytes(objectId),
      ERROR_CODE.OBSERVATION_INVALID
    );
    const revisionKeySha256Hex = await sha256Hex(
      cryptoImplementation,
      textBytes(revisionId),
      ERROR_CODE.OBSERVATION_INVALID
    );
    return {
      objectKeySha256Hex,
      revisionKeySha256Hex,
      peerObjectKey: `v1:${peerFingerprintSha256Hex}:${objectKeySha256Hex}`,
      key: `v1:${peerFingerprintSha256Hex}:${objectKeySha256Hex}:${revisionKeySha256Hex}`
    };
  }

  async function validateStoredObservation(record, expectedObjectId, expectedRevisionId = null) {
    const bytes = bytesFrom(record?.revisionBlobBytes);
    if (!isPlainObject(record) ||
        record.schema !== OBSERVATION_SCHEMA ||
        record.schemaVersion !== OBSERVATION_SCHEMA_VERSION ||
        record.peerFingerprintSha256Hex !== peerFingerprintSha256Hex ||
        record.objectId !== expectedObjectId ||
        (expectedRevisionId !== null && record.revisionId !== expectedRevisionId) ||
        !isNonEmptyId(record.revisionId) ||
        !SHA256_RE.test(record.revisionBlobSha256Hex || '') ||
        (record.payloadSha256Hex != null && !SHA256_RE.test(record.payloadSha256Hex)) ||
        (record.parentRevisionId != null && !isNonEmptyId(record.parentRevisionId)) ||
        record.observedState !== 'observed' ||
        record.applyState !== 'not-applied' ||
        record.statusCode !== null ||
        !isIsoTimestamp(record.firstObservedAt) ||
        !isIsoTimestamp(record.lastObservedAt) ||
        !Number.isSafeInteger(record.observationCount) ||
        record.observationCount < 1 ||
        !bytes ||
        bytes.byteLength === 0 ||
        bytes.byteLength > MAX_BLOB_BYTES) {
      fail(ERROR_CODE.OBSERVATION_CONFLICT);
    }
    const keys = await identityKeys(record.objectId, record.revisionId);
    if (record.key !== keys.key ||
        record.peerObjectKey !== keys.peerObjectKey ||
        record.objectKeySha256Hex !== keys.objectKeySha256Hex ||
        record.revisionKeySha256Hex !== keys.revisionKeySha256Hex) {
      fail(ERROR_CODE.OBSERVATION_CONFLICT);
    }
    const actualBlobHash = await sha256Hex(
      cryptoImplementation,
      bytes,
      ERROR_CODE.OBSERVATION_CONFLICT
    );
    if (actualBlobHash !== record.revisionBlobSha256Hex) {
      fail(ERROR_CODE.OBSERVATION_CONFLICT);
    }
    return record;
  }

  async function readAuthority() {
    const db = await activeDatabase();
    const transaction = db.transaction([AUTHORITY_STORE], 'readonly');
    const completion = transactionResult(transaction);
    let record;
    try {
      record = await requestResult(
        transaction.objectStore(AUTHORITY_STORE).get(AUTHORITY_KEY)
      );
      await completion;
    } catch (error) {
      abortQuietly(transaction);
      try { await completion; } catch (_) { /* expected after abort */ }
      fail(safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED));
    }
    if (!authorityRecordMatches(record, peerFingerprintSha256Hex)) {
      fail(ERROR_CODE.PEER_AUTHORITY_MISMATCH);
    }
    return Object.freeze({
      schema: record.schema,
      schemaVersion: record.schemaVersion,
      peerFingerprintSha256Hex: record.peerFingerprintSha256Hex
    });
  }

  async function readObservation(objectId, revisionId) {
    if (!isNonEmptyId(objectId) || !isNonEmptyId(revisionId)) {
      fail(ERROR_CODE.OBSERVATION_INVALID);
    }
    const db = await activeDatabase();
    const keys = await identityKeys(objectId, revisionId);
    const transaction = db.transaction([OBSERVATION_STORE], 'readonly');
    const completion = transactionResult(transaction);
    let record;
    try {
      record = await requestResult(
        transaction.objectStore(OBSERVATION_STORE).get(keys.key)
      );
      await completion;
    } catch (error) {
      abortQuietly(transaction);
      try { await completion; } catch (_) { /* expected after abort */ }
      fail(safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED));
    }
    if (record && record.peerFingerprintSha256Hex !== peerFingerprintSha256Hex) {
      fail(ERROR_CODE.PEER_AUTHORITY_MISMATCH);
    }
    if (record) await validateStoredObservation(record, objectId, revisionId);
    return cloneObservation(record);
  }

  async function listObservationsForObject(objectId) {
    if (!isNonEmptyId(objectId)) fail(ERROR_CODE.OBSERVATION_INVALID);
    const db = await activeDatabase();
    const keys = await identityKeys(objectId, 'list-scope');
    const transaction = db.transaction([OBSERVATION_STORE], 'readonly');
    const completion = transactionResult(transaction);
    let records;
    try {
      records = await requestResult(
        transaction.objectStore(OBSERVATION_STORE).getAll()
      );
      await completion;
    } catch (error) {
      abortQuietly(transaction);
      try { await completion; } catch (_) { /* expected after abort */ }
      fail(safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED));
    }
    const matching = records
      .filter((record) =>
        isPlainObject(record) &&
        record.peerFingerprintSha256Hex === peerFingerprintSha256Hex &&
        record.peerObjectKey === keys.peerObjectKey);
    for (const record of matching) {
      await validateStoredObservation(record, objectId);
    }
    return matching
      .sort((left, right) => left.revisionId.localeCompare(right.revisionId))
      .map(cloneObservation);
  }

  async function listReadOnlyObjectIds() {
    const db = await activeDatabase();
    const transaction = db.transaction(
      [
        AUTHORITY_STORE,
        OBSERVATION_STORE,
        LOCAL_PUBLICATION_LEDGER_STORE,
        APPLY_STATE_STORE,
        BRANCH_EVIDENCE_STORE
      ],
      'readonly'
    );
    const completion = transactionResult(transaction);
    let authority;
    let observations;
    let ledgers;
    let applyStates;
    let branchEvidence;
    try {
      [authority, observations, ledgers, applyStates, branchEvidence] = await Promise.all([
        requestResult(transaction.objectStore(AUTHORITY_STORE).get(AUTHORITY_KEY)),
        requestResult(transaction.objectStore(OBSERVATION_STORE).getAll()),
        requestResult(
          transaction.objectStore(LOCAL_PUBLICATION_LEDGER_STORE).getAll()
        ),
        requestResult(transaction.objectStore(APPLY_STATE_STORE).getAll()),
        requestResult(transaction.objectStore(BRANCH_EVIDENCE_STORE).getAll())
      ]);
      await completion;
    } catch (error) {
      abortQuietly(transaction);
      try { await completion; } catch (_) { /* expected after abort */ }
      fail(safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED));
    }
    if (!authorityRecordMatches(authority, peerFingerprintSha256Hex)) {
      fail(ERROR_CODE.PEER_AUTHORITY_MISMATCH);
    }

    const objectIds = new Set();
    const observationsByObject = new Map();
    for (const record of observations) {
      if (!isPlainObject(record) || !isNonEmptyId(record.objectId)) {
        fail(ERROR_CODE.OBSERVATION_INVALID);
      }
      await validateStoredObservation(record, record.objectId);
      objectIds.add(record.objectId);
      const values = observationsByObject.get(record.objectId) || [];
      values.push(record);
      observationsByObject.set(record.objectId, values);
    }
    for (const values of observationsByObject.values()) {
      validateLinearObservationGraph(values);
    }

    for (const record of ledgers) {
      if (!isPlainObject(record) ||
          !isNonEmptyId(record.objectId) ||
          !SHA256_RE.test(record.objectKey || '')) {
        fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
      }
      validateLedgerRecord(record, peerFingerprintSha256Hex, record.objectKey);
      objectIds.add(record.objectId);
    }

    for (const record of applyStates) {
      if (!isPlainObject(record) || !isNonEmptyId(record.objectId)) {
        fail(ERROR_CODE.APPLY_STATE_INVALID);
      }
      const keys = await identityKeys(record.objectId, 'enumeration-scope');
      validateApplyStateRecord(
        record,
        peerFingerprintSha256Hex,
        keys,
        record.objectId
      );
      objectIds.add(record.objectId);
    }
    for (const record of branchEvidence) {
      if (!isPlainObject(record) ||
          record.schema !== BRANCH_EVIDENCE_SCHEMA ||
          record.schemaVersion !== BRANCH_EVIDENCE_SCHEMA_VERSION ||
          record.peerFingerprintSha256Hex !== peerFingerprintSha256Hex ||
          !isNonEmptyId(record.objectId) ||
          !isNonEmptyId(record.revisionId) ||
          !SHA256_RE.test(record.revisionBlobSha256Hex || '') ||
          record.applyState !== 'not-applied') {
        fail(ERROR_CODE.BRANCH_EVIDENCE_INVALID);
      }
      objectIds.add(record.objectId);
    }
    return Object.freeze([...objectIds].sort());
  }

  async function recordObservation(input) {
    const revisionBlobBytes = validateObservationInput(input);
    const db = await activeDatabase();
    const actualBlobHash = await sha256Hex(
      cryptoImplementation,
      revisionBlobBytes,
      ERROR_CODE.OBSERVATION_INVALID
    );
    if (actualBlobHash !== input.revisionBlobSha256Hex) {
      fail(ERROR_CODE.BLOB_HASH_MISMATCH);
    }
    const timestamp = clock();
    if (!isIsoTimestamp(timestamp)) fail(ERROR_CODE.OBSERVATION_INVALID);
    const keys = await identityKeys(input.objectId, input.revisionId);
    const proposed = {
      key: keys.key,
      peerObjectKey: keys.peerObjectKey,
      schema: OBSERVATION_SCHEMA,
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      peerFingerprintSha256Hex,
      objectId: input.objectId,
      objectKeySha256Hex: keys.objectKeySha256Hex,
      revisionId: input.revisionId,
      revisionKeySha256Hex: keys.revisionKeySha256Hex,
      revisionBlobSha256Hex: input.revisionBlobSha256Hex,
      payloadSha256Hex: input.payloadSha256Hex || null,
      parentRevisionId: input.parentRevisionId || null,
      observedState: 'observed',
      applyState: 'not-applied',
      firstObservedAt: timestamp,
      lastObservedAt: timestamp,
      observationCount: 1,
      statusCode: null,
      revisionBlobBytes
    };

    const transaction = db.transaction([OBSERVATION_STORE], 'readwrite');
    const completion = transactionResult(transaction);
    try {
      const store = transaction.objectStore(OBSERVATION_STORE);
      const existing = await requestResult(store.get(keys.key));
      if (existing) {
        if (!immutableObservationFieldsMatch(existing, proposed)) {
          fail(ERROR_CODE.OBSERVATION_CONFLICT);
        }
        const updated = {
          ...existing,
          lastObservedAt: timestamp,
          observationCount: Number(existing.observationCount) + 1
        };
        if (!Number.isSafeInteger(updated.observationCount)) {
          fail(ERROR_CODE.OBSERVATION_CONFLICT);
        }
        await requestResult(store.put(updated));
        await completion;
        return Object.freeze({
          ok: true,
          verdict: 'identical-replay',
          unchangedNoOp: true,
          observation: safeObservation(updated)
        });
      }
      await requestResult(store.add(proposed));
      await completion;
      return Object.freeze({
        ok: true,
        verdict: 'observation-created',
        unchangedNoOp: false,
        observation: safeObservation(proposed)
      });
    } catch (error) {
      abortQuietly(transaction);
      try { await completion; } catch (_) { /* expected after abort */ }
      fail(safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED));
    }
  }

  async function recordLinearObservation(input) {
    const revisionBlobBytes = validateObservationInput(input);
    const headBytes = bytesFrom(input?.headBytes);
    if (!headBytes ||
        headBytes.byteLength === 0 ||
        headBytes.byteLength > MAX_HEAD_BYTES ||
        !SHA256_RE.test(input?.headSha256Hex || '')) {
      fail(ERROR_CODE.ADMISSION_EVIDENCE_INVALID);
    }
    const actualBlobHash = await sha256Hex(
      cryptoImplementation,
      revisionBlobBytes,
      ERROR_CODE.OBSERVATION_INVALID
    );
    if (actualBlobHash !== input.revisionBlobSha256Hex) {
      fail(ERROR_CODE.BLOB_HASH_MISMATCH);
    }
    const actualHeadHash = await sha256Hex(
      cryptoImplementation,
      headBytes,
      ERROR_CODE.ADMISSION_EVIDENCE_INVALID
    );
    if (actualHeadHash !== input.headSha256Hex) {
      fail(ERROR_CODE.ADMISSION_EVIDENCE_INVALID);
    }
    const timestamp = clock();
    if (!isIsoTimestamp(timestamp)) fail(ERROR_CODE.OBSERVATION_INVALID);
    const keys = await identityKeys(input.objectId, input.revisionId);
    const proposed = {
      key: keys.key,
      peerObjectKey: keys.peerObjectKey,
      schema: OBSERVATION_SCHEMA,
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      peerFingerprintSha256Hex,
      objectId: input.objectId,
      objectKeySha256Hex: keys.objectKeySha256Hex,
      revisionId: input.revisionId,
      revisionKeySha256Hex: keys.revisionKeySha256Hex,
      revisionBlobSha256Hex: input.revisionBlobSha256Hex,
      payloadSha256Hex: input.payloadSha256Hex || null,
      parentRevisionId: input.parentRevisionId || null,
      observedState: 'observed',
      applyState: 'not-applied',
      firstObservedAt: timestamp,
      lastObservedAt: timestamp,
      observationCount: 1,
      statusCode: null,
      revisionBlobBytes
    };
    const proposedEvidence = {
      key: keys.key,
      schema: ADMISSION_EVIDENCE_SCHEMA,
      schemaVersion: ADMISSION_EVIDENCE_SCHEMA_VERSION,
      peerFingerprintSha256Hex,
      headSha256Hex: input.headSha256Hex,
      headBytes
    };
    const hasExplicitCanonicalAnchor = Object.prototype.hasOwnProperty.call(
      input,
      'canonicalAnchorRevisionId'
    );
    const canonicalAnchorRevisionId = input.canonicalAnchorRevisionId == null
      ? null
      : input.canonicalAnchorRevisionId;
    if (canonicalAnchorRevisionId !== null &&
        !isNonEmptyId(canonicalAnchorRevisionId)) {
      fail(ERROR_CODE.LINEAGE_MISSING);
    }

    // Cryptographic integrity checks are intentionally completed before the
    // write transaction. The transaction then compares this validated
    // snapshot with its own current records and permits no unvalidated change
    // other than an identical concurrently admitted candidate.
    const validatedSnapshot = await listObservationsForObject(input.objectId);
    const db = await activeDatabase();

    return new Promise((resolve, reject) => {
      let transaction;
      let result = null;
      let failureCode = null;
      let settled = false;
      function rejectOnce(code) {
        if (settled) return;
        settled = true;
        reject(new Item9StoreError(code));
      }
      function abortWith(error) {
        failureCode = safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED);
        try {
          transaction.abort();
        } catch (_) {
          rejectOnce(failureCode);
        }
      }
      try {
        transaction = db.transaction(
          [AUTHORITY_STORE, OBSERVATION_STORE, ADMISSION_EVIDENCE_STORE],
          'readwrite'
        );
      } catch (_) {
        rejectOnce(ERROR_CODE.DATABASE_TRANSACTION_FAILED);
        return;
      }
      transaction.oncomplete = () => {
        if (settled) return;
        if (!result) {
          rejectOnce(ERROR_CODE.DATABASE_TRANSACTION_FAILED);
          return;
        }
        settled = true;
        resolve(result);
      };
      transaction.onerror = () => {
        if (!failureCode) failureCode = ERROR_CODE.DATABASE_TRANSACTION_FAILED;
      };
      transaction.onabort = () => {
        rejectOnce(failureCode || ERROR_CODE.DATABASE_TRANSACTION_FAILED);
      };

      const authorityRequest = transaction
        .objectStore(AUTHORITY_STORE)
        .get(AUTHORITY_KEY);
      authorityRequest.onerror = () => abortWith(
        new Item9StoreError(ERROR_CODE.DATABASE_TRANSACTION_FAILED)
      );
      authorityRequest.onsuccess = () => {
        try {
          if (!authorityRecordMatches(
            authorityRequest.result,
            peerFingerprintSha256Hex
          )) {
            fail(ERROR_CODE.PEER_AUTHORITY_MISMATCH);
          }
        } catch (error) {
          abortWith(error);
          return;
        }

        const observationStore = transaction.objectStore(OBSERVATION_STORE);
        const evidenceStore = transaction.objectStore(ADMISSION_EVIDENCE_STORE);
        const observationsRequest = observationStore.getAll();
        observationsRequest.onerror = () => abortWith(
          new Item9StoreError(ERROR_CODE.DATABASE_TRANSACTION_FAILED)
        );
        const evidenceRequest = evidenceStore.get(keys.key);
        evidenceRequest.onerror = () => abortWith(
          new Item9StoreError(ERROR_CODE.DATABASE_TRANSACTION_FAILED)
        );
        let observationsReady = false;
        let evidenceReady = false;
        function persistValidatedAdmission() {
          if (!observationsReady || !evidenceReady) return;
          try {
            const current = observationsRequest.result.filter((record) =>
              isPlainObject(record) &&
              record.peerFingerprintSha256Hex === peerFingerprintSha256Hex &&
              (record.peerObjectKey === keys.peerObjectKey ||
                record.objectId === input.objectId)
            );
            validateAtomicObservationSnapshot(
              current,
              validatedSnapshot,
              proposed
            );
            validateLinearObservationGraph(current);
            const legacyStructuralTip = uniqueStructuralTip(current);
            const existing = current.find(
              (observation) =>
                observation.revisionId === proposed.revisionId
            );
            const existingEvidence = evidenceRequest.result || null;
            let writeRequest;
            let evidenceWriteRequest = null;
            if (existing) {
              if (!immutableObservationFieldsMatch(existing, proposed)) {
                fail(ERROR_CODE.OBSERVATION_CONFLICT);
              }
              if (existingEvidence) {
                if (!immutableAdmissionEvidenceMatches(
                  existingEvidence,
                  proposedEvidence
                )) {
                  fail(ERROR_CODE.OBSERVATION_CONFLICT);
                }
              } else {
                evidenceWriteRequest = evidenceStore.add(proposedEvidence);
              }
              const updated = {
                ...existing,
                lastObservedAt: timestamp,
                observationCount: Number(existing.observationCount) + 1
              };
              if (!Number.isSafeInteger(updated.observationCount)) {
                fail(ERROR_CODE.LINEAGE_CONFLICT);
              }
              writeRequest = observationStore.put(updated);
              result = Object.freeze({
                ok: true,
                verdict: 'identical-replay',
                unchangedNoOp: true,
                observation: safeObservation(updated)
              });
            } else {
              if (existingEvidence) fail(ERROR_CODE.OBSERVATION_CONFLICT);
              if (proposed.parentRevisionId === proposed.revisionId) {
                fail(ERROR_CODE.LINEAGE_CONFLICT);
              }
              const requiredParent = hasExplicitCanonicalAnchor
                ? canonicalAnchorRevisionId
                : legacyStructuralTip;
              if (proposed.parentRevisionId !== null &&
                  current.some((observation) =>
                    observation.parentRevisionId === proposed.parentRevisionId)) {
                fail(ERROR_CODE.LINEAGE_CONFLICT);
              }
              if (requiredParent === undefined ||
                  proposed.parentRevisionId !== requiredParent) {
                fail(ERROR_CODE.LINEAGE_MISSING);
              }
              if (proposed.parentRevisionId === null && current.length !== 0) {
                fail(ERROR_CODE.LINEAGE_CONFLICT);
              }
              validateLinearObservationGraph([...current, proposed]);
              writeRequest = observationStore.add(proposed);
              evidenceWriteRequest = evidenceStore.add(proposedEvidence);
              result = Object.freeze({
                ok: true,
                verdict: 'observation-created',
                unchangedNoOp: false,
                observation: safeObservation(proposed)
              });
            }
            writeRequest.onerror = () => abortWith(
              new Item9StoreError(ERROR_CODE.DATABASE_TRANSACTION_FAILED)
            );
            if (evidenceWriteRequest) {
              evidenceWriteRequest.onerror = () => abortWith(
                new Item9StoreError(ERROR_CODE.DATABASE_TRANSACTION_FAILED)
              );
            }
          } catch (error) {
            result = null;
            abortWith(error);
          }
        }
        observationsRequest.onsuccess = () => {
          observationsReady = true;
          persistValidatedAdmission();
        };
        evidenceRequest.onsuccess = () => {
          evidenceReady = true;
          persistValidatedAdmission();
        };
      };
    });
  }

  async function readAdmissionEvidence(objectId, revisionId) {
    if (!isNonEmptyId(objectId) || !isNonEmptyId(revisionId)) {
      fail(ERROR_CODE.ADMISSION_EVIDENCE_INVALID);
    }
    const observation = await readObservation(objectId, revisionId);
    if (!observation) return null;
    const db = await activeDatabase();
    const keys = await identityKeys(objectId, revisionId);
    const transaction = db.transaction([ADMISSION_EVIDENCE_STORE], 'readonly');
    const completion = transactionResult(transaction);
    let record;
    try {
      record = await requestResult(
        transaction.objectStore(ADMISSION_EVIDENCE_STORE).get(keys.key)
      );
      await completion;
    } catch (error) {
      abortQuietly(transaction);
      try { await completion; } catch (_) { /* expected after abort */ }
      fail(safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED));
    }
    if (!record) return null;
    const validated = validateAdmissionEvidenceRecord(
      record,
      observation,
      peerFingerprintSha256Hex
    );
    const actualHeadHash = await sha256Hex(
      cryptoImplementation,
      validated.headBytes,
      ERROR_CODE.ADMISSION_EVIDENCE_INVALID
    );
    if (actualHeadHash !== validated.headSha256Hex) {
      fail(ERROR_CODE.ADMISSION_EVIDENCE_INVALID);
    }
    return cloneAdmissionEvidence(validated);
  }

  async function readApplySnapshot(objectId) {
    if (!isNonEmptyId(objectId)) fail(ERROR_CODE.APPLY_STATE_INVALID);
    const db = await activeDatabase();
    const keys = await identityKeys(objectId, 'apply-scope');
    const transaction = db.transaction(
      [
        AUTHORITY_STORE,
        OBSERVATION_STORE,
        ADMISSION_EVIDENCE_STORE,
        APPLY_STATE_STORE,
        BRANCH_EVIDENCE_STORE
      ],
      'readonly'
    );
    const completion = transactionResult(transaction);
    let authority;
    let observationRecords;
    let evidenceRecords;
    let applyRecord;
    let branchRecords;
    try {
      const authorityRequest = transaction
        .objectStore(AUTHORITY_STORE)
        .get(AUTHORITY_KEY);
      const observationsRequest = transaction
        .objectStore(OBSERVATION_STORE)
        .getAll();
      const evidenceRequest = transaction
        .objectStore(ADMISSION_EVIDENCE_STORE)
        .getAll();
      const applyRequest = transaction
        .objectStore(APPLY_STATE_STORE)
        .get(keys.peerObjectKey);
      const branchRequest = transaction
        .objectStore(BRANCH_EVIDENCE_STORE)
        .getAll();
      [authority, observationRecords, evidenceRecords, applyRecord, branchRecords] =
        await Promise.all([
          requestResult(authorityRequest),
          requestResult(observationsRequest),
          requestResult(evidenceRequest),
          requestResult(applyRequest),
          requestResult(branchRequest)
        ]);
      await completion;
    } catch (error) {
      abortQuietly(transaction);
      try { await completion; } catch (_) { /* expected after abort */ }
      fail(safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED));
    }
    if (!authorityRecordMatches(authority, peerFingerprintSha256Hex)) {
      fail(ERROR_CODE.PEER_AUTHORITY_MISMATCH);
    }
    const observations = observationRecords
      .filter((record) =>
        isPlainObject(record) &&
        record.peerObjectKey === keys.peerObjectKey);
    for (const observation of observations) {
      await validateStoredObservation(observation, objectId);
    }
    validateLinearObservationGraph(observations);
    const observationByKey = new Map(
      observations.map((observation) => [observation.key, observation])
    );
    const evidencePrefix = `${keys.peerObjectKey}:`;
    const matchingEvidence = evidenceRecords.filter((record) =>
      isPlainObject(record) &&
      typeof record.key === 'string' &&
      record.key.startsWith(evidencePrefix));
    for (const record of matchingEvidence) {
      const observation = observationByKey.get(record.key);
      if (!observation) fail(ERROR_CODE.ADMISSION_EVIDENCE_INVALID);
      const validated = validateAdmissionEvidenceRecord(
        record,
        observation,
        peerFingerprintSha256Hex
      );
      const actualHeadHash = await sha256Hex(
        cryptoImplementation,
        validated.headBytes,
        ERROR_CODE.ADMISSION_EVIDENCE_INVALID
      );
      if (actualHeadHash !== validated.headSha256Hex) {
        fail(ERROR_CODE.ADMISSION_EVIDENCE_INVALID);
      }
    }
    const applyState = validateApplyStateRecord(
      applyRecord,
      peerFingerprintSha256Hex,
      keys,
      objectId
    );
    const matchingBranchEvidence = (Array.isArray(branchRecords) ? branchRecords : [])
      .filter((record) => record?.peerObjectKey === keys.peerObjectKey)
      .map(safeBranchEvidence);
    if (applyState && observations.length === 0 &&
        ![applyState.pending, applyState.lastApplied].some((reference) =>
          reference?.referenceKind === 'branch-evidence-v2')) {
      fail(ERROR_CODE.APPLY_STATE_CONFLICT);
    }
    return Object.freeze({
      ok: true,
      peerFingerprintSha256Hex,
      peerObjectKey: keys.peerObjectKey,
      observations: Object.freeze(
        observations.map((record) => Object.freeze(cloneObservation(record)))
      ),
      admissionEvidence: Object.freeze(
        matchingEvidence.map((record) =>
          Object.freeze(cloneAdmissionEvidence(record)))
      ),
      branchEvidence: Object.freeze(matchingBranchEvidence),
      applyState: cloneApplyState(applyState)
    });
  }

  async function stageApplyIntent(input) {
    if (!isPlainObject(input) ||
        !isNonEmptyId(input.objectId)) {
      fail(ERROR_CODE.APPLY_STATE_INVALID);
    }
    const reference = validateApplyReference(input);
    const canonicalAnchorRevisionId = input.canonicalAnchorRevisionId == null
      ? null
      : input.canonicalAnchorRevisionId;
    if (canonicalAnchorRevisionId !== null &&
        !isNonEmptyId(canonicalAnchorRevisionId)) {
      fail(ERROR_CODE.APPLY_STATE_INVALID);
    }
    const keys = await identityKeys(input.objectId, reference.revisionId);
    if (reference.referenceKind !== 'branch-evidence-v2' &&
        reference.observationKey !== keys.key) {
      fail(ERROR_CODE.APPLY_STATE_INVALID);
    }
    const db = await activeDatabase();
    const transaction = db.transaction(
      reference.referenceKind === 'branch-evidence-v2'
        ? [AUTHORITY_STORE, APPLY_STATE_STORE, BRANCH_EVIDENCE_STORE]
        : [AUTHORITY_STORE, APPLY_STATE_STORE],
      'readwrite'
    );
    const completion = transactionResult(transaction);
    let result;
    try {
      const authority = await requestResult(
        transaction.objectStore(AUTHORITY_STORE).get(AUTHORITY_KEY)
      );
      if (!authorityRecordMatches(authority, peerFingerprintSha256Hex)) {
        fail(ERROR_CODE.PEER_AUTHORITY_MISMATCH);
      }
      if (reference.referenceKind === 'branch-evidence-v2') {
        const branch = await requestResult(
          transaction.objectStore(BRANCH_EVIDENCE_STORE)
            .get(reference.branchEvidenceKey)
        );
        if (!isPlainObject(branch) ||
            branch.schema !== BRANCH_EVIDENCE_SCHEMA ||
            branch.schemaVersion !== BRANCH_EVIDENCE_SCHEMA_VERSION ||
            branch.peerFingerprintSha256Hex !== peerFingerprintSha256Hex ||
            branch.key !== reference.branchEvidenceKey ||
            branch.peerObjectKey !== keys.peerObjectKey ||
            branch.objectId !== input.objectId ||
            branch.revisionId !== reference.revisionId ||
            branch.revisionBlobSha256Hex !== reference.revisionBlobSha256Hex ||
            (branch.parentRevisionId ?? null) !== reference.parentRevisionId ||
            (branch.parentRevisionBlobSha256Hex ?? null) !==
              reference.parentRevisionBlobSha256Hex ||
            branch.applyState !== 'not-applied') {
          fail(ERROR_CODE.BRANCH_EVIDENCE_INVALID);
        }
      }
      const store = transaction.objectStore(APPLY_STATE_STORE);
      const existing = validateApplyStateRecord(
        await requestResult(store.get(keys.peerObjectKey)),
        peerFingerprintSha256Hex,
        keys,
        input.objectId
      );
      if (existing?.pending) {
        if (!applyReferenceMatches(existing.pending, reference)) {
          fail(ERROR_CODE.APPLY_PENDING_UNRESOLVED);
        }
        result = Object.freeze({
          ok: true,
          verdict: 'pending-existing',
          unchangedNoOp: true,
          applyState: cloneApplyState(existing)
        });
      } else if (existing?.lastApplied?.revisionId === reference.revisionId) {
        if (!applyReferenceMatches(existing.lastApplied, reference)) {
          fail(ERROR_CODE.APPLY_STATE_CONFLICT);
        }
        result = Object.freeze({
          ok: true,
          verdict: 'already-applied',
          unchangedNoOp: true,
          applyState: cloneApplyState(existing)
        });
      } else {
        if (reference.referenceKind === 'branch-evidence-v2'
          ? reference.canonicalAnchorRevisionId !== canonicalAnchorRevisionId
          : reference.parentRevisionId !== canonicalAnchorRevisionId) {
          fail(ERROR_CODE.APPLY_STATE_CONFLICT);
        }
        const updatedAt = clock();
        if (!isIsoTimestamp(updatedAt)) fail(ERROR_CODE.APPLY_STATE_INVALID);
        const updated = {
          key: keys.peerObjectKey,
          schema: APPLY_STATE_SCHEMA,
          schemaVersion: APPLY_STATE_SCHEMA_VERSION,
          peerFingerprintSha256Hex,
          objectId: input.objectId,
          objectKeySha256Hex: keys.objectKeySha256Hex,
          lastApplied: existing?.lastApplied || null,
          pending: reference,
          updatedAt
        };
        await requestResult(store.put(updated));
        result = Object.freeze({
          ok: true,
          verdict: 'intent-staged',
          unchangedNoOp: false,
          applyState: cloneApplyState(updated)
        });
      }
      await completion;
    } catch (error) {
      abortQuietly(transaction);
      try { await completion; } catch (_) { /* expected after abort */ }
      fail(safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED));
    }
    return result;
  }

  /*
   * Update ONLY the convergence-direction cell on an existing ledger record,
   * inside the transaction the caller already opened. Taking the transaction as
   * a parameter is the point: a direction that could land in its own
   * transaction could outlive or precede the anchor it names.
   *
   * A W-3 Apply may be the first protocol operation for an object, so there may
   * be no publication ledger row yet. In that case this same transaction
   * creates the minimal convergence row; it is direction evidence, never
   * publication authority or a publication tip.
   */
  async function writeLedgerDirection(
    transaction, objectId, objectKey, direction, updatedAt
  ) {
    if (!SHA256_RE.test(objectKey || '') || !isConvergedDirection(direction)) {
      fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
    }
    const store = transaction.objectStore(LOCAL_PUBLICATION_LEDGER_STORE);
    const key = ledgerKey(peerFingerprintSha256Hex, objectKey);
    const existing = await requestResult(store.get(key));
    if (isPlainObject(existing)) {
      validateLedgerRecord(existing, peerFingerprintSha256Hex, objectKey);
      if (existing.objectId !== objectId) {
        fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
      }
      await requestResult(store.put({ ...existing, convergedDirection: direction, updatedAt }));
      return;
    }
    await requestResult(store.add({
      key,
      schema: LOCAL_PUBLICATION_LEDGER_SCHEMA,
      schemaVersion: LOCAL_PUBLICATION_LEDGER_SCHEMA_VERSION,
      peerFingerprintSha256Hex,
      objectId,
      objectKey,
      tip: null,
      pending: null,
      convergedDirection: direction,
      updatedAt
    }));
  }

  /*
   * `objectKey` is the P02 identity of the object and is supplied by the
   * caller, never derived here: deriving it would require knowing the object
   * domain, and this store is deliberately domain-blind. Callers on the v2 path
   * always hold it already. Omitted ⇒ the apply anchor still advances, but no
   * direction is claimed, which is exactly the legacy regime.
   */
  async function commitApplyIntent(objectId, revisionId, options) {
    if (!isNonEmptyId(objectId) || !isNonEmptyId(revisionId)) {
      fail(ERROR_CODE.APPLY_STATE_INVALID);
    }
    const objectKey = isPlainObject(options) ? options.objectKey : undefined;
    const applyReference = isPlainObject(options?.applyReference)
      ? validateApplyReference(options.applyReference)
      : null;
    if (objectKey != null && !SHA256_RE.test(objectKey)) {
      fail(ERROR_CODE.APPLY_STATE_INVALID);
    }
    const keys = await identityKeys(objectId, revisionId);
    const db = await activeDatabase();
    /* The ledger joins this transaction only when there is a direction to
     * write, so the legacy path keeps its exact previous transaction scope. */
    const transactionStores = [AUTHORITY_STORE, APPLY_STATE_STORE];
    if (objectKey) transactionStores.push(LOCAL_PUBLICATION_LEDGER_STORE);
    if (applyReference?.referenceKind === 'branch-evidence-v2') {
      transactionStores.push(BRANCH_EVIDENCE_STORE);
    }
    const transaction = db.transaction(transactionStores, 'readwrite');
    const completion = transactionResult(transaction);
    let result;
    try {
      const authority = await requestResult(
        transaction.objectStore(AUTHORITY_STORE).get(AUTHORITY_KEY)
      );
      if (!authorityRecordMatches(authority, peerFingerprintSha256Hex)) {
        fail(ERROR_CODE.PEER_AUTHORITY_MISMATCH);
      }
      if (applyReference?.referenceKind === 'branch-evidence-v2') {
        const branch = await requestResult(
          transaction.objectStore(BRANCH_EVIDENCE_STORE)
            .get(applyReference.branchEvidenceKey)
        );
        if (!isPlainObject(branch) ||
            branch.key !== applyReference.branchEvidenceKey ||
            branch.peerObjectKey !== keys.peerObjectKey ||
            branch.objectId !== objectId ||
            branch.revisionId !== applyReference.revisionId ||
            branch.revisionBlobSha256Hex !==
              applyReference.revisionBlobSha256Hex ||
            (branch.parentRevisionId ?? null) !==
              applyReference.parentRevisionId ||
            (branch.parentRevisionBlobSha256Hex ?? null) !==
              applyReference.parentRevisionBlobSha256Hex ||
            branch.applyState !== 'not-applied') {
          fail(ERROR_CODE.BRANCH_EVIDENCE_INVALID);
        }
      }
      const store = transaction.objectStore(APPLY_STATE_STORE);
      const existing = validateApplyStateRecord(
        await requestResult(store.get(keys.peerObjectKey)),
        peerFingerprintSha256Hex,
        keys,
        objectId
      );
      if (!existing?.pending) {
        if (existing?.lastApplied?.revisionId !== revisionId) {
          fail(ERROR_CODE.APPLY_PENDING_UNRESOLVED);
        }
        result = Object.freeze({
          ok: true,
          verdict: 'committed-replay',
          unchangedNoOp: true,
          applyState: cloneApplyState(existing)
        });
      } else {
        if (existing.pending.revisionId !== revisionId ||
            (applyReference &&
              !applyReferenceMatches(existing.pending, applyReference))) {
          fail(ERROR_CODE.APPLY_PENDING_UNRESOLVED);
        }
        const updatedAt = clock();
        if (!isIsoTimestamp(updatedAt)) fail(ERROR_CODE.APPLY_STATE_INVALID);
        const updated = {
          ...existing,
          lastApplied: existing.pending,
          pending: null,
          updatedAt
        };
        await requestResult(store.put(updated));
        /* Lockstep: the direction naming this anchor advances inside the same
         * transaction. It lives on the ledger because that record is keyed by
         * (peer, objectKey) and exists independently of observations, so a
         * publish-only object can hold one without inventing an apply-state
         * record - which the store forbids when no observations exist. */
        if (objectKey) {
          await writeLedgerDirection(
            transaction, objectId, objectKey, CONVERGED_DIRECTION.APPLIED, updatedAt
          );
        }
        result = Object.freeze({
          ok: true,
          verdict: 'committed',
          unchangedNoOp: false,
          applyState: cloneApplyState(updated)
        });
      }
      await completion;
    } catch (error) {
      abortQuietly(transaction);
      try { await completion; } catch (_) { /* expected after abort */ }
      fail(safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED));
    }
    return result;
  }

  async function readLedgerRecord(objectKey) {
    if (!SHA256_RE.test(objectKey || '')) {
      fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
    }
    const db = await activeDatabase();
    const transaction = db.transaction(
      [LOCAL_PUBLICATION_LEDGER_STORE],
      'readonly'
    );
    const completion = transactionResult(transaction);
    let record;
    try {
      record = await requestResult(
        transaction.objectStore(LOCAL_PUBLICATION_LEDGER_STORE).get(
          ledgerKey(peerFingerprintSha256Hex, objectKey)
        )
      );
      await completion;
    } catch (error) {
      abortQuietly(transaction);
      try { await completion; } catch (_) { /* expected after abort */ }
      fail(safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED));
    }
    return validateLedgerRecord(
      record,
      peerFingerprintSha256Hex,
      objectKey
    );
  }

  async function readLocalPublicationTip(objectKey) {
    const record = await readLedgerRecord(objectKey);
    return clonePublicationTip(record?.tip || null);
  }

  /* The tip plus the direction cell naming which anchor is current. Kept
   * separate from readLocalPublicationTip so the existing tip contract is
   * untouched, and read-only so it can never be mistaken for authority. */
  async function readLocalPublicationConvergence(objectKey) {
    const record = await readLedgerRecord(objectKey);
    return Object.freeze({
      tip: clonePublicationTip(record?.tip || null),
      convergedDirection: record?.convergedDirection ?? null
    });
  }

  /* Read-only view of the append-only retirement history for one object. It is
   * evidence, never authority: no path consumes it to decide anything. */
  async function readLocalPublicationRetiredForeignIntents(objectKey) {
    const record = await readLedgerRecord(objectKey);
    return Object.freeze((record?.retiredForeignIntents || []).map(
      (entry) => Object.freeze({ ...entry })
    ));
  }

  async function resolveLocalPublicationPending(objectKey) {
    const record = await readLedgerRecord(objectKey);
    const pending = record?.pending || null;
    if (!pending) {
      return Object.freeze({ state: 'Clean', pending: null });
    }
    /* Retired foreign-lane residue is history, not work. It resolves Clean so
     * a fresh repository-native intent can be planned over it, and the row is
     * deliberately NOT returned as a pending request. */
    if (!isBlockingPendingPublication(pending)) {
      return Object.freeze({ state: 'Clean', pending: null });
    }
    if (pending.state === 'terminal-unresolved') {
      fail(ERROR_CODE.LOCAL_PUBLICATION_PENDING_UNRESOLVED);
    }
    return Object.freeze({
      state: pending.state === 'promote-ready'
        ? 'PromoteReady'
        : 'ResumeRetry',
      pending: safePending(pending)
    });
  }

  /* Background recovery has no page-local publication target. It may resume
   * only an already-durable publication intent, so expose the minimal object
   * identity needed to select that one P01 chain. Full request bytes remain in
   * the ledger and are re-read/revalidated by the writer. */
  async function listLocalPublicationRecoveryObjects() {
    const db = await activeDatabase();
    const transaction = db.transaction(
      [AUTHORITY_STORE, LOCAL_PUBLICATION_LEDGER_STORE],
      'readonly'
    );
    const completion = transactionResult(transaction);
    let authority;
    let records;
    try {
      [authority, records] = await Promise.all([
        requestResult(
          transaction.objectStore(AUTHORITY_STORE).get(AUTHORITY_KEY)
        ),
        requestResult(
          transaction.objectStore(LOCAL_PUBLICATION_LEDGER_STORE).getAll()
        )
      ]);
      await completion;
    } catch (error) {
      abortQuietly(transaction);
      try { await completion; } catch (_) { /* expected after abort */ }
      fail(safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED));
    }
    if (!authorityRecordMatches(authority, peerFingerprintSha256Hex)) {
      fail(ERROR_CODE.PEER_AUTHORITY_MISMATCH);
    }
    const prefix = `v1:${peerFingerprintSha256Hex}:`;
    const recovery = [];
    for (const raw of Array.isArray(records) ? records : []) {
      if (!isPlainObject(raw) || typeof raw.key !== 'string' ||
          !raw.key.startsWith(prefix) || !SHA256_RE.test(raw.objectKey || '')) {
        fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
      }
      const record = validateLedgerRecord(
        raw,
        peerFingerprintSha256Hex,
        raw.objectKey
      );
      /* Retired foreign-lane rows are evidence, never recovery work. */
      if (!isBlockingPendingPublication(record.pending)) continue;
      recovery.push(Object.freeze({
        objectId: record.objectId,
        objectKey: record.objectKey,
        revisionId: record.pending.request.revisionId,
        state: record.pending.state
      }));
    }
    recovery.sort((left, right) =>
      left.objectId.localeCompare(right.objectId) ||
        left.revisionId.localeCompare(right.revisionId));
    return Object.freeze(recovery);
  }

  async function stageLocalPublicationIntent(input) {
    if (!isPlainObject(input) ||
        !isNonEmptyId(input.objectId) ||
        !SHA256_RE.test(input.objectKey || '') ||
        !isNonEmptyId(input.revisionId) ||
        (input.previousRevisionId !== null &&
          !isNonEmptyId(input.previousRevisionId)) ||
        !SHA256_RE.test(input.revisionBlobSha256Hex || '') ||
        !SHA256_RE.test(input.headSha256Hex || '')) {
      fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
    }
    const revisionBlobBytes = bytesFrom(input.revisionBlobBytes);
    const headBytes = bytesFrom(input.headBytes);
    if (!revisionBlobBytes || !headBytes ||
        revisionBlobBytes.byteLength === 0 ||
        headBytes.byteLength === 0 ||
        revisionBlobBytes.byteLength > MAX_BLOB_BYTES ||
        headBytes.byteLength > MAX_BLOB_BYTES) {
      fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
    }
    if (await sha256Hex(
      cryptoImplementation,
      revisionBlobBytes,
      ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID
    ) !== input.revisionBlobSha256Hex ||
        await sha256Hex(
          cryptoImplementation,
          headBytes,
          ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID
        ) !== input.headSha256Hex) {
      fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
    }
    const producedAtIso = clock();
    if (!isIsoTimestamp(producedAtIso)) {
      fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
    }
    const proposedRequest = validatePublicationRequest({
      objectId: input.objectId,
      objectKey: input.objectKey,
      revisionId: input.revisionId,
      previousRevisionId: input.previousRevisionId,
      revisionBlobSha256Hex: input.revisionBlobSha256Hex,
      headSha256Hex: input.headSha256Hex,
      /* Optional content identity, carried through to the tip at promotion so
       * convergence never compares envelope hashes across domains. Omitted by
       * pre-amendment callers, who then stay in the legacy regime. */
      payloadSha256Hex: SHA256_RE.test(input.payloadSha256Hex || '')
        ? input.payloadSha256Hex
        : null,
      /* P02 binds the local writer, observed canonical anchor, complete heads
       * snapshot and plan-time CAS token into this existing durable journal.
       * P01 callers omit it and remain byte-for-byte on their prior contract. */
      p02Plan: input.p02Plan ?? null,
      producedAtIso,
      revisionBlobBytes,
      headBytes
    }, input.objectKey);
    const db = await activeDatabase();
    const transaction = db.transaction(
      [AUTHORITY_STORE, LOCAL_PUBLICATION_LEDGER_STORE],
      'readwrite'
    );
    const completion = transactionResult(transaction);
    let result = null;
    let terminalConflict = false;
    try {
      const authority = await requestResult(
        transaction.objectStore(AUTHORITY_STORE).get(AUTHORITY_KEY)
      );
      if (!authorityRecordMatches(authority, peerFingerprintSha256Hex)) {
        fail(ERROR_CODE.PEER_AUTHORITY_MISMATCH);
      }
      const store = transaction.objectStore(LOCAL_PUBLICATION_LEDGER_STORE);
      const key = ledgerKey(peerFingerprintSha256Hex, input.objectKey);
      const existing = validateLedgerRecord(
        await requestResult(store.get(key)),
        peerFingerprintSha256Hex,
        input.objectKey
      );
      if (existing && existing.objectId !== input.objectId) {
        fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_CONFLICT);
      }
      /*
       * The field/state distinction that VER found. A retained
       * 'retired-foreign-lane' row is NOT an unresolved pending publication:
       * reading `existing?.pending` here rewrote it to terminal-unresolved and
       * put the object back into recovery, defeating the retirement. Its
       * evidence has already been moved to retiredForeignIntents, so the single
       * pending slot is free for the fresh repository-native intent.
       */
      if (isBlockingPendingPublication(existing?.pending)) {
        if (existing.pending.state === 'terminal-unresolved') {
          terminalConflict = true;
        } else if (immutablePublicationRequestMatches(
          existing.pending.request,
          proposedRequest
        )) {
          result = Object.freeze({
            ok: true,
            verdict: existing.pending.state === 'promote-ready'
              ? 'promote-ready'
              : 'resume-retry',
            unchangedNoOp: true,
            pending: safePending(existing.pending)
          });
        } else {
          const terminal = {
            ...existing,
            pending: {
              ...existing.pending,
              state: 'terminal-unresolved',
              errorCode: ERROR_CODE.LOCAL_PUBLICATION_LEDGER_CONFLICT
            },
            updatedAt: producedAtIso
          };
          await requestResult(store.put(terminal));
          terminalConflict = true;
        }
      } else if (existing?.tip &&
          existing.tip.revisionId === proposedRequest.revisionId) {
        if (existing.tip.revisionBlobSha256Hex !==
            proposedRequest.revisionBlobSha256Hex ||
            existing.tip.headSha256Hex !== proposedRequest.headSha256Hex) {
          fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_CONFLICT);
        }
        result = Object.freeze({
          ok: true,
          verdict: 'committed-replay',
          unchangedNoOp: true,
          tip: clonePublicationTip(existing.tip)
        });
      } else {
        const record = {
          key,
          schema: LOCAL_PUBLICATION_LEDGER_SCHEMA,
          schemaVersion: LOCAL_PUBLICATION_LEDGER_SCHEMA_VERSION,
          peerFingerprintSha256Hex,
          objectId: input.objectId,
          objectKey: input.objectKey,
          tip: existing?.tip || null,
          /* Append-only: a reused pending slot never erases what was retired. */
          retiredForeignIntents: existing?.retiredForeignIntents || [],
          /* Staging is not an anchor advance, so it must carry the existing
           * direction forward. Rebuilding the record without it would silently
           * demote a converged object back to the legacy regime. */
          convergedDirection: existing?.convergedDirection ?? null,
          pending: {
            state: 'promote-ready',
            errorCode: null,
            request: proposedRequest
          },
          updatedAt: producedAtIso
        };
        await requestResult(store.put(record));
        result = Object.freeze({
          ok: true,
          verdict: 'promote-ready',
          unchangedNoOp: false,
          pending: safePending(record.pending)
        });
      }
      await completion;
    } catch (error) {
      abortQuietly(transaction);
      try { await completion; } catch (_) { /* expected after abort */ }
      fail(safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED));
    }
    if (terminalConflict) {
      fail(ERROR_CODE.LOCAL_PUBLICATION_PENDING_UNRESOLVED);
    }
    return result;
  }

  async function markLocalPublicationRetry(objectKey, revisionId) {
    if (!SHA256_RE.test(objectKey || '') || !isNonEmptyId(revisionId)) {
      fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
    }
    const db = await activeDatabase();
    const transaction = db.transaction(
      [LOCAL_PUBLICATION_LEDGER_STORE],
      'readwrite'
    );
    const completion = transactionResult(transaction);
    let pending;
    try {
      const store = transaction.objectStore(LOCAL_PUBLICATION_LEDGER_STORE);
      const key = ledgerKey(peerFingerprintSha256Hex, objectKey);
      const existing = validateLedgerRecord(
        await requestResult(store.get(key)),
        peerFingerprintSha256Hex,
        objectKey
      );
      if (!isBlockingPendingPublication(existing?.pending) ||
          existing.pending.state === 'terminal-unresolved' ||
          existing.pending.request.revisionId !== revisionId) {
        fail(ERROR_CODE.LOCAL_PUBLICATION_PENDING_UNRESOLVED);
      }
      const updatedAt = clock();
      if (!isIsoTimestamp(updatedAt)) {
        fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
      }
      const updated = {
        ...existing,
        pending: {
          ...existing.pending,
          state: 'resume-retry'
        },
        updatedAt
      };
      await requestResult(store.put(updated));
      await completion;
      pending = updated.pending;
    } catch (error) {
      abortQuietly(transaction);
      try { await completion; } catch (_) { /* expected after abort */ }
      fail(safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED));
    }
    return Object.freeze({
      ok: true,
      verdict: 'resume-retry',
      pending: safePending(pending)
    });
  }

  /*
   * Retire ONE exact pending row that the retired slot lane left behind.
   *
   * This is not a "clear pending intent" capability and cannot be used as one.
   * The caller must already know the object key, the revision id and the exact
   * stagedAt of the row it means; all three are checked against the stored row,
   * so a caller who is wrong about which row it holds gets a refusal rather than
   * a mutation. No discovery, no wildcard, no delete: the row transitions in
   * place to a retained historical state, and its staged bytes, identity and
   * evidence are preserved exactly.
   *
   * A row is foreign-lane residue only if it carries no p02Plan. A genuine
   * repository-native P02 intent always carries one, so this transition can
   * never consume real P02 work.
   */
  async function retireLocalPublicationForeignIntent(
    objectKey,
    revisionId,
    expectedStagedAt
  ) {
    if (!SHA256_RE.test(objectKey || '') || !isNonEmptyId(revisionId) ||
        !isIsoTimestamp(expectedStagedAt)) {
      fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
    }
    const db = await activeDatabase();
    const transaction = db.transaction(
      [AUTHORITY_STORE, LOCAL_PUBLICATION_LEDGER_STORE],
      'readwrite'
    );
    const completion = transactionResult(transaction);
    let result;
    try {
      const authority = await requestResult(
        transaction.objectStore(AUTHORITY_STORE).get(AUTHORITY_KEY)
      );
      if (!authorityRecordMatches(authority, peerFingerprintSha256Hex)) {
        fail(ERROR_CODE.PEER_AUTHORITY_MISMATCH);
      }
      const store = transaction.objectStore(LOCAL_PUBLICATION_LEDGER_STORE);
      const key = ledgerKey(peerFingerprintSha256Hex, objectKey);
      const existing = validateLedgerRecord(
        await requestResult(store.get(key)),
        peerFingerprintSha256Hex,
        objectKey
      );
      if (!existing || !existing.pending) {
        fail(ERROR_CODE.LOCAL_PUBLICATION_FOREIGN_INTENT_NOT_FOUND);
      }
      const pending = existing.pending;
      /* CAS on the row's own staged instant, plus exact revision identity. */
      if (pending.request.revisionId !== revisionId ||
          existing.updatedAt !== expectedStagedAt) {
        fail(ERROR_CODE.LOCAL_PUBLICATION_FOREIGN_INTENT_MISMATCH);
      }
      /* Already retired, or terminal for an unrelated reason: refuse rather
       * than re-retire, so the transition can never be ambiguous. */
      if (pending.state === LOCAL_PUBLICATION_RETIRED_FOREIGN_LANE ||
          pending.state === 'terminal-unresolved') {
        fail(ERROR_CODE.LOCAL_PUBLICATION_FOREIGN_INTENT_NOT_PENDING);
      }
      if (pending.request.p02Plan !== null) {
        fail(ERROR_CODE.LOCAL_PUBLICATION_FOREIGN_INTENT_NOT_FOREIGN);
      }
      const updatedAt = clock();
      if (!isIsoTimestamp(updatedAt)) {
        fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
      }
      const priorState = pending.state;
      const updated = {
        ...existing,
        /* The request is carried through untouched - same bytes, same hashes,
         * same identity. Only the state changes. */
        pending: { ...pending, state: LOCAL_PUBLICATION_RETIRED_FOREIGN_LANE },
        /* And the same identity is ALSO recorded in append-only history, so the
         * evidence survives the day a fresh intent legitimately occupies the
         * row's single pending slot. */
        retiredForeignIntents: [
          ...(existing.retiredForeignIntents || []),
          {
            revisionId: pending.request.revisionId,
            previousRevisionId: pending.request.previousRevisionId ?? null,
            revisionBlobSha256Hex: pending.request.revisionBlobSha256Hex,
            headSha256Hex: pending.request.headSha256Hex,
            producedAtIso: pending.request.producedAtIso ?? null,
            stagedAt: expectedStagedAt,
            retiredAt: updatedAt,
            stagedBytes: pending.request.revisionBlobBytes.byteLength,
            priorState,
            retiredState: LOCAL_PUBLICATION_RETIRED_FOREIGN_LANE
          }
        ],
        updatedAt
      };
      await requestResult(store.put(updated));
      result = Object.freeze({
        ok: true,
        verdict: 'foreign-intent-retired',
        matched: true,
        objectId: existing.objectId,
        objectKey,
        revisionId,
        priorState,
        retiredState: LOCAL_PUBLICATION_RETIRED_FOREIGN_LANE,
        stagedAt: expectedStagedAt,
        retiredAt: updatedAt,
        stagedBytes: pending.request.revisionBlobBytes.byteLength,
        revisionBlobSha256Hex: pending.request.revisionBlobSha256Hex,
        headSha256Hex: pending.request.headSha256Hex,
        evidenceRetained: true,
        rowsDeleted: 0,
        repositoryMutated: false,
        published: false
      });
      await completion;
    } catch (error) {
      abortQuietly(transaction);
      try { await completion; } catch (_) { /* expected after abort */ }
      fail(safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED));
    }
    return result;
  }

  async function commitLocalPublicationIntent(objectKey, revisionId) {
    if (!SHA256_RE.test(objectKey || '') || !isNonEmptyId(revisionId)) {
      fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
    }
    const db = await activeDatabase();
    const transaction = db.transaction(
      [AUTHORITY_STORE, LOCAL_PUBLICATION_LEDGER_STORE],
      'readwrite'
    );
    const completion = transactionResult(transaction);
    let result;
    try {
      const authority = await requestResult(
        transaction.objectStore(AUTHORITY_STORE).get(AUTHORITY_KEY)
      );
      if (!authorityRecordMatches(authority, peerFingerprintSha256Hex)) {
        fail(ERROR_CODE.PEER_AUTHORITY_MISMATCH);
      }
      const store = transaction.objectStore(LOCAL_PUBLICATION_LEDGER_STORE);
      const key = ledgerKey(peerFingerprintSha256Hex, objectKey);
      const existing = validateLedgerRecord(
        await requestResult(store.get(key)),
        peerFingerprintSha256Hex,
        objectKey
      );
      /* Historical retirement evidence is not a committable intent. */
      if (!isBlockingPendingPublication(existing?.pending)) {
        if (existing?.tip?.revisionId === revisionId) {
          result = Object.freeze({
            ok: true,
            verdict: 'committed-replay',
            unchangedNoOp: true,
            tip: clonePublicationTip(existing.tip)
          });
        } else {
          fail(ERROR_CODE.LOCAL_PUBLICATION_PENDING_UNRESOLVED);
        }
      } else {
        if (existing.pending.state === 'terminal-unresolved' ||
            existing.pending.request.revisionId !== revisionId) {
          fail(ERROR_CODE.LOCAL_PUBLICATION_PENDING_UNRESOLVED);
        }
        const request = existing.pending.request;
        const tip = {
          objectKey,
          revisionId: request.revisionId,
          previousRevisionId: request.previousRevisionId,
          revisionBlobSha256Hex: request.revisionBlobSha256Hex,
          headSha256Hex: request.headSha256Hex,
          /* Optional: absent for pre-amendment requests, which then stay in the
           * legacy regime rather than claiming an identity they do not carry. */
          payloadSha256Hex: SHA256_RE.test(request.payloadSha256Hex || '')
            ? request.payloadSha256Hex
            : null,
          producedAtIso: request.producedAtIso
        };
        const updatedAt = clock();
        if (!isIsoTimestamp(updatedAt)) {
          fail(ERROR_CODE.LOCAL_PUBLICATION_LEDGER_INVALID);
        }
        await requestResult(store.put({
          ...existing,
          tip,
          pending: null,
          /* Same record, same transaction as the tip it describes: the anchor
           * and the direction naming it commit together or not at all. */
          convergedDirection: CONVERGED_DIRECTION.PUBLISHED,
          updatedAt
        }));

        result = Object.freeze({
          ok: true,
          verdict: 'committed',
          unchangedNoOp: false,
          tip: clonePublicationTip(tip)
        });
      }
      await completion;
    } catch (error) {
      abortQuietly(transaction);
      try { await completion; } catch (_) { /* expected after abort */ }
      fail(safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED));
    }
    return result;
  }

  /*
   * P02 Wave 1 / Z6 (frozen Y-8 + G.2). Durable retention for structurally
   * valid revisions the accepted linear path terminally rejected: sibling
   * forks, unknown/unproven parents and typed closures.
   *
   * Retained is NOT admitted for Apply. `applyState` is pinned 'not-applied'
   * and this store is never consulted as an Apply source (G.5); the Y-9
   * classifier reads it only through the derived branch index. The caller
   * supplies the G.1 disposition computed by the shared branch-evidence
   * module, so no conflict semantics live in storage code.
   */
  async function recordBranchEvidence(input) {
    const objectId = input?.objectId;
    const revisionId = input?.revisionId;
    const disposition = input?.disposition;
    if (!isNonEmptyId(objectId) ||
        !isNonEmptyId(revisionId) ||
        !isNonEmptyId(disposition) ||
        !SHA256_RE.test(input?.revisionBlobSha256Hex || '')) {
      fail(ERROR_CODE.BRANCH_EVIDENCE_INVALID);
    }
    const closureType = input?.closureType ?? null;
    if (closureType !== null &&
        closureType !== 'branch-superseded' &&
        closureType !== 'object-deleted') {
      fail(ERROR_CODE.BRANCH_EVIDENCE_INVALID);
    }
    const revisionBlobBytes = bytesFrom(input?.revisionBlobBytes);
    if (!revisionBlobBytes ||
        revisionBlobBytes.byteLength === 0 ||
        revisionBlobBytes.byteLength > MAX_BLOB_BYTES) {
      fail(ERROR_CODE.BRANCH_EVIDENCE_INVALID);
    }
    /* Address is derived from bytes and verified, never trusted (E.2). */
    const actualBlobHash = await sha256Hex(
      cryptoImplementation,
      revisionBlobBytes,
      ERROR_CODE.BRANCH_EVIDENCE_INVALID
    );
    if (actualBlobHash !== input.revisionBlobSha256Hex) {
      fail(ERROR_CODE.BLOB_HASH_MISMATCH);
    }
    const timestamp = clock();
    if (!isIsoTimestamp(timestamp)) fail(ERROR_CODE.BRANCH_EVIDENCE_INVALID);
    const db = await activeDatabase();
    const keys = await identityKeys(objectId, revisionId);
    const proposed = {
      key: keys.key,
      peerObjectKey: keys.peerObjectKey,
      schema: BRANCH_EVIDENCE_SCHEMA,
      schemaVersion: BRANCH_EVIDENCE_SCHEMA_VERSION,
      peerFingerprintSha256Hex,
      objectId,
      objectKeySha256Hex: keys.objectKeySha256Hex,
      revisionId,
      revisionKeySha256Hex: keys.revisionKeySha256Hex,
      revisionBlobSha256Hex: input.revisionBlobSha256Hex,
      parentRevisionId: input?.parentRevisionId ?? null,
      parentRevisionBlobSha256Hex: input?.parentRevisionBlobSha256Hex ?? null,
      disposition,
      reason: input?.reason ?? null,
      closureType,
      /* Pinned: retained branch evidence is never Apply-eligible by itself. */
      applyState: 'not-applied',
      firstObservedAt: timestamp,
      lastObservedAt: timestamp,
      observationCount: 1,
      revisionBlobBytes
    };

    const transaction = db.transaction(
      [AUTHORITY_STORE, BRANCH_EVIDENCE_STORE],
      'readwrite'
    );
    const completion = transactionResult(transaction);
    try {
      const authority = await requestResult(
        transaction.objectStore(AUTHORITY_STORE).get(AUTHORITY_KEY)
      );
      if (!authorityRecordMatches(authority, peerFingerprintSha256Hex)) {
        fail(ERROR_CODE.PEER_AUTHORITY_MISMATCH);
      }
      const store = transaction.objectStore(BRANCH_EVIDENCE_STORE);
      const existing = await requestResult(store.get(keys.key));
      if (existing) {
        /*
         * Immutability: same revision identity with divergent canonical bytes
         * fails closed. Retained evidence is never rewritten to "resolve" a
         * conflict; only the replay counter advances.
         */
        if (existing.revisionBlobSha256Hex !== proposed.revisionBlobSha256Hex ||
            existing.revisionId !== proposed.revisionId ||
            existing.objectId !== proposed.objectId ||
            existing.parentRevisionId !== proposed.parentRevisionId ||
            existing.closureType !== proposed.closureType) {
          fail(ERROR_CODE.BRANCH_EVIDENCE_CONFLICT);
        }
        const updated = {
          ...existing,
          lastObservedAt: timestamp,
          observationCount: Number(existing.observationCount) + 1
        };
        if (!Number.isSafeInteger(updated.observationCount)) {
          fail(ERROR_CODE.BRANCH_EVIDENCE_CONFLICT);
        }
        await requestResult(store.put(updated));
        await completion;
        return Object.freeze({
          ok: true,
          verdict: 'identical-replay',
          unchangedNoOp: true,
          applyEligible: false,
          record: safeBranchEvidence(updated)
        });
      }
      await requestResult(store.add(proposed));
      await completion;
      return Object.freeze({
        ok: true,
        verdict: 'branch-evidence-retained',
        unchangedNoOp: false,
        applyEligible: false,
        record: safeBranchEvidence(proposed)
      });
    } catch (error) {
      abortQuietly(transaction);
      try { await completion; } catch (_) { /* expected after abort */ }
      fail(safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED));
    }
  }

  async function listBranchEvidence(objectId) {
    if (!isNonEmptyId(objectId)) fail(ERROR_CODE.BRANCH_EVIDENCE_INVALID);
    const db = await activeDatabase();
    const transaction = db.transaction([BRANCH_EVIDENCE_STORE], 'readonly');
    const completion = transactionResult(transaction);
    try {
      const all = await requestResult(
        transaction.objectStore(BRANCH_EVIDENCE_STORE).getAll()
      );
      await completion;
      return Object.freeze(all
        .filter((record) =>
          isPlainObject(record) &&
          record.schema === BRANCH_EVIDENCE_SCHEMA &&
          record.peerFingerprintSha256Hex === peerFingerprintSha256Hex &&
          record.objectId === objectId)
        .sort((left, right) => left.revisionId.localeCompare(right.revisionId))
        .map((record) => safeBranchEvidence(record)));
    } catch (error) {
      abortQuietly(transaction);
      try { await completion; } catch (_) { /* expected after abort */ }
      fail(safeCode(error, ERROR_CODE.DATABASE_TRANSACTION_FAILED));
    }
  }

  function close() {
    try { database?.close(); } catch (_) { /* ignore */ }
    database = null;
    readyPromise = null;
    peerFingerprintSha256Hex = null;
  }

  return Object.freeze({
    ensureReady: ready,
    readAuthority,
    readObservation,
    listObservationsForObject,
    listReadOnlyObjectIds,
    recordObservation,
    recordLinearObservation,
    recordBranchEvidence,
    listBranchEvidence,
    readAdmissionEvidence,
    readApplySnapshot,
    stageApplyIntent,
    commitApplyIntent,
    readLocalPublicationTip,
    readLocalPublicationConvergence,
    resolveLocalPublicationPending,
    listLocalPublicationRecoveryObjects,
    stageLocalPublicationIntent,
    retireLocalPublicationForeignIntent,
    readLocalPublicationRetiredForeignIntents,
    markLocalPublicationRetry,
    commitLocalPublicationIntent,
    close
  });
}

export const ITEM9_1_CONSTANTS = Object.freeze({
  DATABASE_NAME,
  DATABASE_VERSION,
  AUTHORITY_STORE,
  AUTHORITY_KEY,
  AUTHORITY_SCHEMA_VERSION,
  OBSERVATION_STORE,
  LOCAL_PUBLICATION_LEDGER_STORE,
  ADMISSION_EVIDENCE_STORE,
  APPLY_STATE_STORE,
  BRANCH_EVIDENCE_STORE,
  AUTHORITY_SCHEMA,
  OBSERVATION_SCHEMA,
  OBSERVATION_SCHEMA_VERSION,
  LOCAL_PUBLICATION_LEDGER_SCHEMA,
  LOCAL_PUBLICATION_LEDGER_SCHEMA_VERSION,
  ADMISSION_EVIDENCE_SCHEMA,
  ADMISSION_EVIDENCE_SCHEMA_VERSION,
  APPLY_STATE_SCHEMA,
  APPLY_STATE_SCHEMA_VERSION,
  BRANCH_EVIDENCE_SCHEMA,
  BRANCH_EVIDENCE_SCHEMA_VERSION,
  MAX_BLOB_BYTES,
  MAX_HEAD_BYTES,
  EXPECTED_IDENTITY,
  ERROR_CODE
});
