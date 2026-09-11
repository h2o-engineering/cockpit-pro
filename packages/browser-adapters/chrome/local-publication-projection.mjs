/*
 * Chrome adapter for local saved-chat publication projection and provenance.
 *
 * M1 stops at deterministic projection, ancestry proof, and ledger planning.
 * This module has no file, permission, transport, network, or UI capability.
 */

import {
  LOCAL_PUBLICATION_PROJECTION_ERROR,
  LocalPublicationProjectionError,
  createCanonicalSyncObjectProjectionCore
} from '../../core/sync-object-projection.mjs';

/* The shared core owns the projection error vocabulary, but that vocabulary is
 * part of this adapter's projection contract: a Chrome consumer that holds only
 * the adapter must still be able to enumerate the projection codes it can
 * receive. Re-exported by reference so exactly one vocabulary exists. */
export { LOCAL_PUBLICATION_PROJECTION_ERROR };

const CHROME_IDENTITY = Object.freeze({
  schema: 'h2o.studio.peer-identity.v1',
  surfaceKind: 'studio-chrome',
  appKind: 'mv3-chrome',
  storeKind: 'idb-archive'
});

export const LOCAL_PUBLICATION_PROVENANCE_ERROR = Object.freeze({
  IDENTITY_CONFLICT: 'local-publication-revision-identity-conflict',
  IDENTITY_UNAVAILABLE: 'local-publication-writer-identity-unavailable',
  LEDGER_UNAVAILABLE: 'local-publication-ledger-unavailable',
  PROVENANCE_UNPROVABLE: 'local-publication-provenance-unprovable'
});

export class LocalPublicationProvenanceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LocalPublicationProvenanceError';
    this.code = code;
  }
}

function fail(code) {
  throw new LocalPublicationProvenanceError(code);
}

function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]';
}

function isStrictIdentifier(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function storeList(store, method, argument) {
  if (!store || typeof store[method] !== 'function') {
    throw new LocalPublicationProjectionError(
      LOCAL_PUBLICATION_PROJECTION_ERROR.RELATIONSHIP_PROOF_UNAVAILABLE
    );
  }
  return store[method](argument);
}

const SYSTEM_CATEGORY_ALGORITHM_VERSION = 'h2o-category-deterministic-v1';
const SYSTEM_CATEGORY_KEYS = new Set([
  'primaryCategoryId',
  'secondaryCategoryId',
  'source',
  'algorithmVersion',
  'classifiedAt',
  'overriddenAt',
  'confidence'
]);

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function isSemanticallyEmptyRelationshipValue(value, seen) {
  if (value == null || value === false) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((item) =>
        isSemanticallyEmptyRelationshipValue(item, seen));
    }
    if (!isPlainObject(value)) return false;
    return Object.keys(value).every((key) =>
      isSemanticallyEmptyRelationshipValue(value[key], seen));
  } finally {
    seen.delete(value);
  }
}

function isDeterministicSystemCategory(value) {
  if (!isPlainObject(value)) return false;
  if (typeof value.primaryCategoryId !== 'string' ||
      !clean(value.primaryCategoryId) ||
      typeof value.source !== 'string' ||
      clean(value.source).toLowerCase() !== 'system' ||
      typeof value.algorithmVersion !== 'string' ||
      clean(value.algorithmVersion) !== SYSTEM_CATEGORY_ALGORITHM_VERSION ||
      typeof value.classifiedAt !== 'string' || !clean(value.classifiedAt) ||
      !Number.isFinite(Date.parse(value.classifiedAt)) ||
      !isSemanticallyEmptyRelationshipValue(value.overriddenAt, new Set())) {
    return false;
  }
  if (!isSemanticallyEmptyRelationshipValue(
    value.secondaryCategoryId,
    new Set()
  ) && (typeof value.secondaryCategoryId !== 'string' ||
      !clean(value.secondaryCategoryId))) {
    return false;
  }
  if (!isSemanticallyEmptyRelationshipValue(value.confidence, new Set())) {
    if (typeof value.confidence !== 'number' ||
        !Number.isFinite(value.confidence) ||
        value.confidence < 0 || value.confidence > 1) return false;
  }
  return Object.keys(value).every((key) =>
    SYSTEM_CATEGORY_KEYS.has(key) ||
      isSemanticallyEmptyRelationshipValue(value[key], new Set()));
}

function isAllowedSourceOnlyRelationship(kind, path, key, value) {
  const location = path.concat(key).join('.');
  if (kind === 'folders' && key === 'folderId' &&
      typeof value === 'string' && clean(value)) {
    return location === 'row.folderId' ||
      location === 'snapshot.meta.folderId';
  }
  if (kind === 'categories' && key === 'category' &&
      (location === 'row.category' ||
        location === 'snapshot.meta.category')) {
    return isDeterministicSystemCategory(value);
  }
  return false;
}

function containsRelationship(value, pattern, kind, seen, path) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  try {
    return Object.keys(value).some((key) => {
      const item = value[key];
      if (pattern.test(key)) {
        if (isSemanticallyEmptyRelationshipValue(item, new Set())) {
          return false;
        }
        if (isAllowedSourceOnlyRelationship(kind, path, key, item)) {
          return false;
        }
        return true;
      }
      return containsRelationship(
        item,
        pattern,
        kind,
        seen,
        path.concat(key)
      );
    });
  } finally {
    seen.delete(value);
  }
}

function relationEvidence(value, pattern, kind) {
  return containsRelationship(value, pattern, kind, new Set(), [])
    ? [true]
    : [];
}

/* The Studio page and the service worker both read the same archive authority.
 * This adapter is the one canonical shape translation into the object
 * projector, so background reconciliation cannot drift from foreground
 * publication semantics. */
export function createChromeArchiveProjectionAdapter({ archiveAuthority } = {}) {
  if (!archiveAuthority ||
      typeof archiveAuthority.listWorkbenchRows !== 'function' ||
      typeof archiveAuthority.listSnapshots !== 'function' ||
      typeof archiveAuthority.loadSnapshot !== 'function') {
    fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.PROVENANCE_UNPROVABLE);
  }

  async function rawArchiveRecord(chatId, snapshotId) {
    const rows = await archiveAuthority.listWorkbenchRows();
    const matches = Array.isArray(rows)
      ? rows.filter((row) => clean(row?.chatId) === chatId)
      : [];
    if (matches.length !== 1) {
      fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.PROVENANCE_UNPROVABLE);
    }
    const snapshot = await archiveAuthority.loadSnapshot(snapshotId);
    if (!snapshot || clean(snapshot.chatId) !== chatId ||
        clean(snapshot.snapshotId) !== snapshotId) {
      fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.PROVENANCE_UNPROVABLE);
    }
    return { row: matches[0], snapshot };
  }

  const stores = Object.freeze({
    chats: Object.freeze({
      async get(objectId) {
        const rows = await archiveAuthority.listWorkbenchRows();
        const matches = Array.isArray(rows)
          ? rows.filter((row) => clean(row?.chatId) === objectId)
          : [];
        if (matches.length !== 1) return null;
        const row = matches[0];
        return {
          id: objectId,
          title: clean(row.title),
          lastSnapshotId: clean(row.snapshotId),
          updatedAt: clean(row.updatedAt || row.createdAt)
        };
      }
    }),
    snapshots: Object.freeze({
      async listByChat(objectId) {
        const rows = await archiveAuthority.listSnapshots(objectId);
        return Array.isArray(rows) ? rows.map((row) => ({
          snapshotId: clean(row?.snapshotId),
          chatId: objectId,
          createdAt: clean(row?.createdAt)
        })) : [];
      },
      async get(revisionId) {
        const raw = await archiveAuthority.loadSnapshot(revisionId);
        if (!raw) return null;
        const messages = Array.isArray(raw.messages) ? raw.messages : [];
        const richTurns = Array.isArray(raw.meta?.richTurns)
          ? raw.meta.richTurns
          : [];
        if (!messages.length) return null;
        const turns = messages.map((message, index) => {
          const candidate = richTurns[index] || {};
          const rich = richTurns.length === messages.length &&
            clean(candidate.role) === clean(message.role)
            ? candidate
            : {};
          const meta = isPlainObject(rich.meta) ? { ...rich.meta } : {};
          Object.keys(rich).forEach((key) => {
            if (!['turnIdx', 'role', 'outerHTML', 'html', 'meta'].includes(key)) {
              meta[key] = rich[key];
            }
          });
          return {
            turnIdx: Number(message.order),
            role: clean(message.role),
            text: typeof message.text === 'string' ? message.text : '',
            outerHtml: clean(rich.outerHTML || rich.html),
            meta
          };
        });
        return {
          snapshot: {
            snapshotId: clean(raw.snapshotId),
            chatId: clean(raw.chatId),
            title: clean(raw.meta?.title),
            createdAt: clean(raw.createdAt)
          },
          turns
        };
      }
    })
  });

  async function relationshipProbe(input) {
    const record = await rawArchiveRecord(input.chatId, input.snapshotId);
    const combined = { row: record.row, snapshot: record.snapshot };
    return {
      assets: relationEvidence(
        combined,
        /^(assets?|attachments?|externalAssets?)$/i,
        'assets'
      ),
      categories: relationEvidence(
        combined,
        /^(category(Id|Relationship)?|categories)$/i,
        'categories'
      ),
      folders: relationEvidence(
        combined,
        /^(folder(Id|Ids|Bindings?)?|folders)$/i,
        'folders'
      ),
      labels: relationEvidence(combined, /^(labels?|labelIds?)$/i, 'labels'),
      organizations: relationEvidence(
        combined,
        /^(organization(State|Id|Ids|Relationship)?|organizations|org(Id|State)?)$/i,
        'organizations'
      ),
      projects: relationEvidence(
        combined,
        /^(project(Id|Ids|Relationship)?|projects|originProjectRef)$/i,
        'projects'
      ),
      tags: relationEvidence(
        combined,
        /^(tags?|tagIds?|tagCatalog)$/i,
        'tags'
      )
    };
  }

  return Object.freeze({ stores, relationshipProbe });
}

export function createChromeStoreRelationshipProbe(stores) {
  return async function proveChromeContentOnlyRelationships({
    chatId,
    snapshotId
  }) {
    const [assets, categories, folders, labels, organizations, projects, tags] =
      await Promise.all([
        storeList(stores?.assets, 'listBySnapshot', snapshotId),
        storeList(stores?.categories, 'listForChat', chatId),
        storeList(stores?.folders, 'listForChat', chatId),
        storeList(stores?.labels, 'listForChat', chatId),
        storeList(stores?.organizations, 'listForChat', chatId),
        storeList(stores?.projects, 'listForChat', chatId),
        storeList(stores?.tags, 'listForChat', chatId)
      ]);
    return {
      assets,
      categories,
      folders,
      labels,
      organizations,
      projects,
      tags
    };
  };
}

function contentSequence(projection) {
  const snapshot = projection?.payload?.chatArchive?.chats?.[0]?.snapshots?.[0];
  const messages = snapshot?.messages;
  const richTurns = snapshot?.meta?.richTurns;
  if (!Array.isArray(messages) || !Array.isArray(richTurns) ||
      messages.length !== richTurns.length || messages.length === 0) {
    fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.PROVENANCE_UNPROVABLE);
  }
  return messages.map((message, index) => ({
    order: message.order,
    role: message.role,
    text: message.text,
    richTurn: richTurns[index]
  }));
}

export function isStrictCanonicalContentDescendant(base, current, canonicalize) {
  const baseTurns = contentSequence(base);
  const currentTurns = contentSequence(current);
  if (currentTurns.length <= baseTurns.length) return false;
  for (let index = 0; index < baseTurns.length; index += 1) {
    if (canonicalize(baseTurns[index]) !== canonicalize(currentTurns[index])) {
      return false;
    }
  }
  return true;
}

function validateTip(tip, expectedObjectKey) {
  if (!isPlainObject(tip) ||
      tip.objectKey !== expectedObjectKey ||
      !isStrictIdentifier(tip.revisionId) ||
      (tip.previousRevisionId !== null &&
        !isStrictIdentifier(tip.previousRevisionId)) ||
      !/^[0-9a-f]{64}$/.test(tip.revisionBlobSha256Hex || '') ||
      !/^[0-9a-f]{64}$/.test(tip.headSha256Hex || '')) {
    fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.LEDGER_UNAVAILABLE);
  }
  return tip;
}

function validateAppliedTip(reference, expectedObjectId) {
  if (reference == null) return null;
  if (!isPlainObject(reference) ||
      !isStrictIdentifier(reference.revisionId) ||
      (reference.parentRevisionId !== null &&
        !isStrictIdentifier(reference.parentRevisionId)) ||
      !/^[0-9a-f]{64}$/.test(reference.revisionBlobSha256Hex || '') ||
      !/^[0-9a-f]{64}$/.test(reference.payloadSha256Hex || '')) {
    fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.PROVENANCE_UNPROVABLE);
  }
  return Object.freeze({
    objectId: expectedObjectId,
    revisionId: reference.revisionId,
    previousRevisionId: reference.parentRevisionId,
    revisionBlobSha256Hex: reference.revisionBlobSha256Hex,
    payloadSha256Hex: reference.payloadSha256Hex,
    provenance: 'remote-applied'
  });
}

export function createChromeLocalPublicationProjection({
  stores,
  relationshipProbe = null,
  identityProvider,
  cryptoImplementation = globalThis.crypto
} = {}) {
  const core = createCanonicalSyncObjectProjectionCore({
    cryptoImplementation
  });
  const proveRelationships = relationshipProbe ||
    createChromeStoreRelationshipProbe(stores);

  async function writerSyncPeerId() {
    if (!identityProvider || typeof identityProvider.whenSyncReady !== 'function') {
      fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.IDENTITY_UNAVAILABLE);
    }
    let identity;
    try {
      identity = await identityProvider.whenSyncReady();
    } catch (_) {
      fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.IDENTITY_UNAVAILABLE);
    }
    if (!isPlainObject(identity) ||
        identity.schema !== CHROME_IDENTITY.schema ||
        identity.surfaceKind !== CHROME_IDENTITY.surfaceKind ||
        identity.appKind !== CHROME_IDENTITY.appKind ||
        identity.storeKind !== CHROME_IDENTITY.storeKind ||
        !isStrictIdentifier(identity.syncPeerId)) {
      fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.IDENTITY_UNAVAILABLE);
    }
    return identity.syncPeerId;
  }

  async function projectCurrent(objectId, previousRevisionId = null) {
    return core.projectObject({
      objectId,
      stores,
      relationshipProbe: proveRelationships,
      writerSyncPeerId: await writerSyncPeerId(),
      previousRevisionId
    });
  }

  async function projectRevision(
    objectId,
    revisionId,
    previousRevisionId = null
  ) {
    return core.projectObjectRevision({
      objectId,
      revisionId,
      stores,
      relationshipProbe: proveRelationships,
      writerSyncPeerId: await writerSyncPeerId(),
      previousRevisionId
    });
  }

  async function proveParent({ objectId, tip, currentProjection }) {
    let historical;
    try {
      historical = await projectRevision(
        objectId,
        tip.revisionId,
        tip.previousRevisionId
      );
    } catch (_) {
      fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.PROVENANCE_UNPROVABLE);
    }
    const baseIntegrity =
      historical.revisionBlobSha256Hex === tip.revisionBlobSha256Hex;
    const contentDescent = baseIntegrity &&
      isStrictCanonicalContentDescendant(
        historical,
        currentProjection,
        core.canonicalJson
      );
    if (!baseIntegrity || !contentDescent) {
      fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.PROVENANCE_UNPROVABLE);
    }
    return Object.freeze({
      baseIntegrity: true,
      contentDescent: true,
      historicalProjection: historical
    });
  }

  async function selectParent({ objectId, currentProjection, ledgerTip }) {
    if (ledgerTip == null) {
      return Object.freeze({
        disposition: 'new-root',
        parentRevisionId: null,
        projection: currentProjection,
        advanceLedger: true
      });
    }
    const tip = validateTip(ledgerTip, currentProjection.objectKeyHex);
    if (tip.revisionId === currentProjection.revisionId) {
      if (tip.revisionBlobSha256Hex !==
          currentProjection.revisionBlobSha256Hex) {
        fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.IDENTITY_CONFLICT);
      }
      const replayProjection = await projectCurrent(
        objectId,
        tip.previousRevisionId
      );
      if (replayProjection.revisionId !== tip.revisionId ||
          replayProjection.revisionBlobSha256Hex !==
            tip.revisionBlobSha256Hex ||
          replayProjection.headSha256Hex !== tip.headSha256Hex) {
        fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.IDENTITY_CONFLICT);
      }
      return Object.freeze({
        disposition: 'committed-replay',
        parentRevisionId: tip.previousRevisionId,
        projection: replayProjection,
        advanceLedger: false
      });
    }
    await proveParent({ objectId, tip, currentProjection });
    const parentedProjection = await projectCurrent(objectId, tip.revisionId);
    if (parentedProjection.revisionBlobSha256Hex !==
        currentProjection.revisionBlobSha256Hex) {
      fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.PROVENANCE_UNPROVABLE);
    }
    return Object.freeze({
      disposition: 'new-revision',
      parentRevisionId: tip.revisionId,
      projection: parentedProjection,
      advanceLedger: true
    });
  }

  function selectNewestProvenance(localTip, appliedTip) {
    if (!localTip) return appliedTip;
    if (!appliedTip) return localTip;
    if (localTip.revisionId === appliedTip.revisionId) {
      if (localTip.revisionBlobSha256Hex !==
          appliedTip.revisionBlobSha256Hex) {
        fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.IDENTITY_CONFLICT);
      }
      return Object.freeze({ ...localTip, provenance: 'local-and-remote' });
    }
    if (appliedTip.previousRevisionId === localTip.revisionId) {
      return appliedTip;
    }
    if (localTip.previousRevisionId === appliedTip.revisionId) {
      return localTip;
    }
    fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.PROVENANCE_UNPROVABLE);
  }

  async function resolveCanonicalAnchor({ objectId, ledger } = {}) {
    if (!isStrictIdentifier(objectId) || !ledger ||
        typeof ledger.readLocalPublicationTip !== 'function' ||
        typeof ledger.readApplySnapshot !== 'function') {
      fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.LEDGER_UNAVAILABLE);
    }
    const currentProjection = await projectCurrent(objectId);
    const localRaw = await ledger.readLocalPublicationTip(
      currentProjection.objectKeyHex
    );
    const localTip = localRaw
      ? Object.freeze({
        ...validateTip(localRaw, currentProjection.objectKeyHex),
        provenance: 'local-published'
      })
      : null;
    const applySnapshot = await ledger.readApplySnapshot(objectId);
    const appliedTip = validateAppliedTip(
      applySnapshot?.applyState?.lastApplied || null,
      objectId
    );
    if (localTip && appliedTip &&
        localTip.revisionId === appliedTip.revisionId &&
        localTip.revisionBlobSha256Hex !==
          appliedTip.revisionBlobSha256Hex) {
      fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.IDENTITY_CONFLICT);
    }
    for (const tip of [localTip, appliedTip]) {
      if (tip && tip.revisionId === currentProjection.revisionId &&
          tip.revisionBlobSha256Hex !==
            currentProjection.revisionBlobSha256Hex) {
        fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.IDENTITY_CONFLICT);
      }
    }
    const localPublishedMatch = !!localTip &&
      localTip.revisionId === currentProjection.revisionId &&
      localTip.revisionBlobSha256Hex ===
        currentProjection.revisionBlobSha256Hex;
    const remoteAppliedMatch = !!appliedTip &&
      appliedTip.revisionId === currentProjection.revisionId &&
      appliedTip.revisionBlobSha256Hex ===
        currentProjection.revisionBlobSha256Hex &&
      appliedTip.payloadSha256Hex === currentProjection.payloadSha256Hex;
    const classification = localPublishedMatch && remoteAppliedMatch
      ? 'KNOWN_CANONICAL_BOTH'
      : (localPublishedMatch
        ? 'KNOWN_CANONICAL_LOCAL_PUBLISHED'
        : (remoteAppliedMatch
          ? 'KNOWN_CANONICAL_REMOTE_APPLIED'
          : 'LOCAL_UNPUBLISHED_CHANGE'));
    return Object.freeze({
      ok: true,
      classification,
      objectId,
      revisionId: currentProjection.revisionId,
      revisionBlobSha256Hex: currentProjection.revisionBlobSha256Hex,
      payloadSha256Hex: currentProjection.payloadSha256Hex,
      localPublishedMatch,
      remoteAppliedMatch,
      currentProjection,
      localTip,
      appliedTip,
      newestProvenance: selectNewestProvenance(localTip, appliedTip),
      applySnapshot
    });
  }

  async function planPublication({ objectId, ledger }) {
    if (!ledger ||
        typeof ledger.resolveLocalPublicationPending !== 'function' ||
        typeof ledger.readLocalPublicationTip !== 'function') {
      fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.LEDGER_UNAVAILABLE);
    }
    const objectKey = await core.objectKeyHex(objectId);
    const pending = await ledger.resolveLocalPublicationPending(objectKey);
    if (!pending || typeof pending.state !== 'string') {
      fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.LEDGER_UNAVAILABLE);
    }
    if (pending.state !== 'Clean') {
      return Object.freeze({
        disposition: pending.state,
        objectKey,
        pending,
        advanceLedger: false
      });
    }
    const anchor = await resolveCanonicalAnchor({ objectId, ledger });
    const currentProjection = anchor.currentProjection;
    if (anchor.localPublishedMatch) {
      return selectParent({
        objectId,
        currentProjection,
        ledgerTip: anchor.localTip
      });
    }
    if (anchor.remoteAppliedMatch) {
      return Object.freeze({
        disposition: 'remote-applied-current',
        parentRevisionId: anchor.appliedTip.previousRevisionId,
        projection: currentProjection,
        canonicalAnchor: anchor,
        advanceLedger: false
      });
    }
    const base = anchor.newestProvenance;
    if (!base) {
      return Object.freeze({
        disposition: 'new-root',
        parentRevisionId: null,
        projection: currentProjection,
        canonicalAnchor: anchor,
        advanceLedger: true
      });
    }
    if (base.revisionId === currentProjection.revisionId) {
      fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.IDENTITY_CONFLICT);
    }
    await proveParent({ objectId, tip: base, currentProjection });
    const parentedProjection = await projectCurrent(objectId, base.revisionId);
    if (parentedProjection.revisionBlobSha256Hex !==
        currentProjection.revisionBlobSha256Hex) {
      fail(LOCAL_PUBLICATION_PROVENANCE_ERROR.PROVENANCE_UNPROVABLE);
    }
    return Object.freeze({
      disposition: 'new-revision',
      parentRevisionId: base.revisionId,
      projection: parentedProjection,
      canonicalAnchor: anchor,
      advanceLedger: true
    });
  }

  return Object.freeze({
    projectCurrent,
    projectRevision,
    proveParent,
    selectParent,
    resolveCanonicalAnchor,
    planPublication,
    objectKeyHex: core.objectKeyHex,
    canonicalJson: core.canonicalJson
  });
}

export const LOCAL_PUBLICATION_CHROME_PROJECTION_CONSTANTS = Object.freeze({
  CHROME_IDENTITY
});
