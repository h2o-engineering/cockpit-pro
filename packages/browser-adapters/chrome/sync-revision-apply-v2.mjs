/*
 * O1-T14 — Chrome v2 Apply, beside the v1 path.
 *
 * The v1 apply engine consumes v1 observations and a six-key revision document.
 * A v2 envelope is a nine-key document carrying a minted identity and a parent
 * PAIR, so this is a separate lane over the T11 branch evidence, exactly as
 * admission is. Nothing here modifies the v1 engine, and nothing down-converts
 * a v2 envelope so the v1 engine can swallow it.
 *
 * WHAT THIS ADAPTER ADDS to the platform-neutral Apply core: the Chrome
 * capabilities, and only those. The ordering, the byte re-verification, the
 * one-hop rule and the identity split all live in the core, so Desktop and
 * Chrome cannot drift apart on the parts that must not differ.
 *
 * THE SAME-TRANSACTION COMMIT is the Chrome-specific obligation. The applied
 * anchor and the ledger's convergence direction are written in ONE transaction,
 * as T02b established. Two transactions would leave a window in which the
 * anchor says applied and the direction still says published, and enumeration
 * reading that window would classify a converged object as dirty and republish
 * it - an echo caused purely by write ordering.
 *
 * No DATABASE_VERSION change and no new store: every record this writes already
 * has a home.
 */
import {
  createP02ApplyComposition,
  P02_APPLY_ERROR
} from '../../core/sync-object-apply-v2.mjs';
import {
  P02_ANCHOR_MATCH,
  matchAnchorPair,
  requireP02AnchorSet
} from '../../core/sync-p02-anchor-set-v2.mjs';

export const P02_CHROME_APPLY_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncChromeApplyV2.p02.v1',
  DIRECTION_APPLIED: 'applied',
  REFERENCE_KIND: 'branch-evidence-v2',
  ARCHIVE_SCHEMA: 'h2o.chatArchive.bundle.v1',
  FULL_BUNDLE_SCHEMA: 'h2o.studio.fullBundle.v2'
});

export const P02_CHROME_APPLY_ERROR = Object.freeze({
  DEPENDENCY_INVALID: 'p02-chrome-apply-v2-dependency-invalid',
  EVIDENCE_UNAVAILABLE: 'p02-chrome-apply-v2-evidence-unavailable',
  CANDIDATE_AMBIGUOUS: 'p02-chrome-apply-v2-candidate-ambiguous',
  CANDIDATE_INELIGIBLE: 'p02-chrome-apply-v2-candidate-ineligible',
  PEER_AUTHORITY_INVALID: 'p02-chrome-apply-v2-peer-authority-invalid',
  BRANCH_EVIDENCE_INVALID: 'p02-chrome-apply-v2-branch-evidence-invalid',
  ANCHOR_INVALID: 'p02-chrome-apply-v2-anchor-invalid',
  ARCHIVE_IMPORT_FAILED: 'p02-chrome-apply-v2-archive-import-failed',
  READBACK_MISMATCH: 'p02-chrome-apply-v2-readback-mismatch'
});

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

function canonicalJson(value) {
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize);
    if (isPlainObject(input)) {
      return Object.fromEntries(Object.keys(input).sort()
        .map((key) => [key, normalize(input[key])]));
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function canonicalState(value) {
  if (value == null) return null;
  if (!isPlainObject(value) || !clean(value.objectId) ||
      !clean(value.revisionId) || !hex64(value.payloadSha256Hex)) {
    fail(P02_CHROME_APPLY_ERROR.ANCHOR_INVALID);
  }
  return Object.freeze({
    objectId: value.objectId,
    revisionId: value.revisionId,
    payloadSha256Hex: value.payloadSha256Hex
  });
}

function sameCanonicalState(left, right) {
  return left === null || right === null
    ? left === right
    : left.objectId === right.objectId &&
      left.revisionId === right.revisionId &&
      left.payloadSha256Hex === right.payloadSha256Hex;
}

function branchChain(records, leaf, anchorSet) {
  const byId = new Map();
  for (const record of records) {
    const id = clean(record?.revisionId);
    const blob = clean(record?.revisionBlobSha256Hex ?? record?.revisionBlobSha256);
    if (!id || !hex64(blob) || byId.has(id) || record?.proven === false) {
      fail(P02_CHROME_APPLY_ERROR.BRANCH_EVIDENCE_INVALID);
    }
    byId.set(id, record);
  }
  const chain = [];
  const seen = new Set();
  let cursor = clean(leaf?.revisionId);
  let anchor = null;
  const leafBlob = clean(leaf?.revisionBlobSha256);
  if (matchAnchorPair(anchorSet, {
    revisionId: cursor,
    revisionBlobSha256: leafBlob
  }) === P02_ANCHOR_MATCH.PROVEN) {
    anchor = anchorSet.pairs.find((pair) =>
      pair.revisionId === cursor && pair.revisionBlobSha256 === leafBlob);
    return Object.freeze({
      chain: Object.freeze([{ revisionId: cursor, revisionBlobSha256: leafBlob }]),
      anchor
    });
  }
  for (;;) {
    const record = byId.get(cursor);
    if (!record || seen.has(cursor)) {
      fail(P02_CHROME_APPLY_ERROR.BRANCH_EVIDENCE_INVALID);
    }
    seen.add(cursor);
    chain.unshift({
      revisionId: clean(record.revisionId),
      revisionBlobSha256: clean(
        record.revisionBlobSha256Hex ?? record.revisionBlobSha256)
    });
    const parentId = record.parentRevisionId ?? null;
    const parentBlob = record.parentRevisionBlobSha256Hex ?? null;
    if (parentId === null && parentBlob === null) break;
    if (!clean(parentId) || !hex64(parentBlob)) {
      fail(P02_CHROME_APPLY_ERROR.BRANCH_EVIDENCE_INVALID);
    }
    const match = matchAnchorPair(anchorSet, {
      revisionId: parentId,
      revisionBlobSha256: parentBlob
    });
    if (match === P02_ANCHOR_MATCH.IDENTITY_CONFLICT) {
      fail(P02_CHROME_APPLY_ERROR.ANCHOR_INVALID);
    }
    if (match === P02_ANCHOR_MATCH.PROVEN) {
      anchor = anchorSet.pairs.find((pair) =>
        pair.revisionId === parentId && pair.revisionBlobSha256 === parentBlob);
      chain.unshift({ revisionId: parentId, revisionBlobSha256: parentBlob });
      break;
    }
    cursor = parentId;
  }
  return Object.freeze({ chain: Object.freeze(chain), anchor });
}

function expectedSnapshot(payload, objectId, sourceRevisionId) {
  if (!isPlainObject(payload) ||
      payload.schema !== P02_CHROME_APPLY_V2.FULL_BUNDLE_SCHEMA ||
      !isPlainObject(payload.chatArchive) ||
      !Array.isArray(payload.chatArchive.chats) ||
      payload.chatArchive.chats.length !== 1 ||
      !isPlainObject(payload.chromeStorageLocal) ||
      Object.keys(payload.chromeStorageLocal).length !== 0 ||
      !Array.isArray(payload.libraryKv) || payload.libraryKv.length !== 0) {
    fail(P02_CHROME_APPLY_ERROR.ARCHIVE_IMPORT_FAILED);
  }
  const chat = payload.chatArchive.chats[0];
  const snapshots = Array.isArray(chat?.snapshots) ? chat.snapshots : [];
  if (chat?.chatId !== objectId || snapshots.length !== 1 ||
      snapshots[0]?.snapshotId !== sourceRevisionId) {
    fail(P02_CHROME_APPLY_ERROR.ARCHIVE_IMPORT_FAILED);
  }
  return snapshots[0];
}

function semanticMessageRows(value) {
  if (!Array.isArray(value)) return null;
  const rows = [];
  for (const row of value) {
    if (!isPlainObject(row) ||
        !Number.isSafeInteger(row.order) ||
        typeof row.role !== 'string' ||
        typeof row.text !== 'string') {
      return null;
    }
    rows.push({ order: row.order, role: row.role, text: row.text });
  }
  return rows;
}

function snapshotConverged(actual, expected) {
  const actualMessages = semanticMessageRows(actual?.messages);
  const expectedMessages = semanticMessageRows(expected?.messages);
  return isPlainObject(actual) && isPlainObject(expected) &&
    actual.snapshotId === expected.snapshotId &&
    actual.chatId === expected.chatId &&
    actual.createdAt === expected.createdAt &&
    Number(actual.messageCount) === Number(expected.messageCount) &&
    actualMessages !== null && expectedMessages !== null &&
    canonicalJson(actualMessages) === canonicalJson(expectedMessages) &&
    canonicalJson(actual.meta?.richTurns ?? []) ===
      canonicalJson(expected.meta?.richTurns ?? []);
}

/*
 * W-3 owner. This entry point accepts only the leaf chosen by the fresh
 * classifier. The page cannot name a peer, object, revision, path, anchor or
 * mode.
 */
export function createChromeV2Apply({
  evidenceStore,
  archiveAuthority,
  canonicalStateProvider,
  sha256HexBytes,
  readRevisionBytes,
  objectDomain = 'studio.chat.saved-state.v1'
} = {}) {
  if (!isPlainObject(evidenceStore) ||
      typeof evidenceStore.listBranchEvidence !== 'function' ||
      typeof evidenceStore.stageApplyIntent !== 'function' ||
      typeof evidenceStore.commitApplyIntent !== 'function' ||
      typeof evidenceStore.readApplySnapshot !== 'function' ||
      !isPlainObject(archiveAuthority) ||
      typeof archiveAuthority.importFullBundle !== 'function' ||
      typeof archiveAuthority.loadSnapshot !== 'function' ||
      typeof canonicalStateProvider !== 'function' ||
      typeof sha256HexBytes !== 'function' ||
      typeof readRevisionBytes !== 'function') {
    fail(P02_CHROME_APPLY_ERROR.DEPENDENCY_INVALID);
  }

  async function applySelectedAdmittedV2Revision({
    descriptor,
    classifierVerdict,
    configuredPeer
  } = {}) {
    if (!isPlainObject(descriptor) || !isPlainObject(classifierVerdict) ||
        classifierVerdict.classification !== 'remote-ahead' ||
        classifierVerdict.applyEligibleByEvidence !== true ||
        !clean(classifierVerdict.applyCandidateRevisionId) ||
        !isPlainObject(configuredPeer) ||
        configuredPeer.syncPeerId !== descriptor.syncPeerId ||
        !hex64(configuredPeer.writerKey)) {
      fail(P02_CHROME_APPLY_ERROR.CANDIDATE_INELIGIBLE);
    }
    const objectId = clean(descriptor.objectId);
    const objectKey = clean(descriptor.objectKey);
    if (!objectId || !hex64(objectKey) || descriptor.objectDomain !== objectDomain) {
      fail(P02_CHROME_APPLY_ERROR.CANDIDATE_INELIGIBLE);
    }
    const anchorSet = requireP02AnchorSet(descriptor.p02AnchorSet);
    if (!anchorSet || anchorSet.objectDomain !== objectDomain ||
        anchorSet.objectId !== objectId) {
      fail(P02_CHROME_APPLY_ERROR.ANCHOR_INVALID);
    }

    const records = await evidenceStore.listBranchEvidence(objectId);
    if (!Array.isArray(records)) fail(P02_CHROME_APPLY_ERROR.EVIDENCE_UNAVAILABLE);
    const selected = records.filter((record) =>
      record.revisionId === classifierVerdict.applyCandidateRevisionId);
    if (selected.length !== 1 || selected[0]?.closureType != null) {
      fail(selected.length > 1
        ? P02_CHROME_APPLY_ERROR.CANDIDATE_AMBIGUOUS
        : P02_CHROME_APPLY_ERROR.BRANCH_EVIDENCE_INVALID);
    }
    const leafRecord = selected[0];
    const selectedLeaf = Object.freeze({
      revisionId: leafRecord.revisionId,
      revisionBlobSha256: leafRecord.revisionBlobSha256Hex
    });
    const ancestry = branchChain(records, selectedLeaf, anchorSet);
    const currentAnchor = ancestry.anchor
      ? Object.freeze({
        revisionId: ancestry.anchor.revisionId,
        revisionBlobSha256: ancestry.anchor.revisionBlobSha256,
        payloadSha256: ancestry.anchor.payloadSha256 ?? null
      })
      : null;
    const existingApply = await evidenceStore.readApplySnapshot(objectId);
    const retainedPending = existingApply?.applyState?.pending;
    const recoveringPending = retainedPending?.referenceKind ===
        P02_CHROME_APPLY_V2.REFERENCE_KIND &&
      retainedPending.revisionId === selectedLeaf.revisionId &&
      retainedPending.revisionBlobSha256Hex === selectedLeaf.revisionBlobSha256;
    const observedCanonical = canonicalState(await canonicalStateProvider(objectId));
    const initialCanonical = recoveringPending
      ? (retainedPending.canonicalPreStateRevisionId === null
        ? null
        : Object.freeze({
          objectId,
          revisionId: retainedPending.canonicalPreStateRevisionId,
          payloadSha256Hex: retainedPending.canonicalPreStatePayloadSha256Hex
        }))
      : observedCanonical;
    if (!recoveringPending && currentAnchor === null) {
      if (initialCanonical !== null || anchorSet.pairs.length !== 0) {
        fail(P02_CHROME_APPLY_ERROR.ANCHOR_INVALID);
      }
    } else if (!recoveringPending &&
        (initialCanonical === null || !hex64(currentAnchor.payloadSha256) ||
        initialCanonical.payloadSha256Hex !== currentAnchor.payloadSha256)) {
      fail(P02_CHROME_APPLY_ERROR.ANCHOR_INVALID);
    }

    let applyReference = null;
    let expected = null;
    const composition = createP02ApplyComposition({
      sha256HexBytes,
      readRevisionBytes,
      provenChainFor: async () => ancestry.chain,
      admittedPairsFor: async () => records.map((record) => ({
        revisionId: record.revisionId,
        revisionBlobSha256: record.revisionBlobSha256Hex
      })),
      stageApplyIntent: async ({ hop, verification }) => {
        const branch = records.find((record) =>
          record.revisionId === hop.revisionId &&
          record.revisionBlobSha256Hex === hop.revisionBlobSha256);
        if (!branch?.key) fail(P02_CHROME_APPLY_ERROR.BRANCH_EVIDENCE_INVALID);
        expected = expectedSnapshot(
          verification.source.payload, objectId, verification.source.revisionId);
        applyReference = Object.freeze({
          referenceKind: P02_CHROME_APPLY_V2.REFERENCE_KIND,
          objectDomain,
          objectKey,
          writerSyncPeerId: configuredPeer.syncPeerId,
          writerKey: configuredPeer.writerKey,
          selectedLeafRevisionId: selectedLeaf.revisionId,
          selectedLeafRevisionBlobSha256Hex: selectedLeaf.revisionBlobSha256,
          revisionId: verification.envelope.revisionId,
          parentRevisionId: branch.parentRevisionId ?? null,
          parentRevisionBlobSha256Hex:
            branch.parentRevisionBlobSha256Hex ?? null,
          branchEvidenceKey: branch.key,
          revisionBlobSha256Hex: verification.envelope.revisionBlobSha256,
          payloadSha256Hex: verification.envelope.payloadSha256,
          sourceRevisionId: verification.source.revisionId,
          canonicalAnchorRevisionId: currentAnchor?.revisionId ?? null,
          canonicalAnchorRevisionBlobSha256Hex:
            currentAnchor?.revisionBlobSha256 ?? null,
          canonicalPreStateRevisionId: initialCanonical?.revisionId ?? null,
          canonicalPreStatePayloadSha256Hex:
            initialCanonical?.payloadSha256Hex ?? null
        });
        const staged = await evidenceStore.stageApplyIntent({
          objectId,
          canonicalAnchorRevisionId: currentAnchor?.revisionId ?? null,
          ...applyReference
        });
        const readback = await evidenceStore.readApplySnapshot(objectId);
        const retained = staged?.verdict === 'already-applied'
          ? readback?.applyState?.lastApplied
          : readback?.applyState?.pending;
        if (!retained || canonicalJson(retained) !== canonicalJson(applyReference)) {
          fail(P02_APPLY_ERROR.INTENT_STAGE_FAILED);
        }
        return staged;
      },
      recheckCanonicalPrecondition: async () => ({
        ok: sameCanonicalState(
          canonicalState(await canonicalStateProvider(objectId)),
          initialCanonical),
        reason: P02_APPLY_ERROR.PRECONDITION_FAILED
      }),
      importCanonicalPayload: async ({ payload, sourceRevisionId }) => {
        expected = expectedSnapshot(payload, objectId, sourceRevisionId);
        const bundle = {
          ...payload,
          chatArchive: {
            ...payload.chatArchive,
            schema: P02_CHROME_APPLY_V2.ARCHIVE_SCHEMA
          }
        };
        const result = await archiveAuthority.importFullBundle({ bundle, mode: 'merge' });
        const ok = result?.schema === P02_CHROME_APPLY_V2.FULL_BUNDLE_SCHEMA &&
          result?.mode === 'merge' && result?.chats?.ok === true &&
          result.chats.importedChats === 1 && result.chats.importedSnapshots === 1;
        return ok
          ? { ok: true }
          : { ok: false, reason: P02_CHROME_APPLY_ERROR.ARCHIVE_IMPORT_FAILED };
      },
      readCanonicalConvergence: async ({ verification }) => {
        expected ||= expectedSnapshot(
          verification.source.payload, objectId, verification.source.revisionId);
        const [snapshot, projected] = await Promise.all([
          archiveAuthority.loadSnapshot(verification.source.revisionId),
          canonicalStateProvider(objectId)
        ]);
        const state = canonicalState(projected);
        return snapshotConverged(snapshot, expected) &&
          state?.objectId === objectId &&
          state?.payloadSha256Hex === verification.envelope.payloadSha256
          ? { state: 'converged' }
          : { state: 'mismatch', reason: P02_CHROME_APPLY_ERROR.READBACK_MISMATCH };
      },
      commitApplied: async ({ revisionId }) => {
        if (!applyReference || applyReference.revisionId !== revisionId) {
          fail(P02_APPLY_ERROR.COMMIT_FAILED);
        }
        const committed = await evidenceStore.commitApplyIntent(objectId, revisionId, {
          objectKey,
          applyReference,
          convergedDirection: P02_CHROME_APPLY_V2.DIRECTION_APPLIED
        });
        const readback = await evidenceStore.readApplySnapshot(objectId);
        if (readback?.applyState?.pending !== null ||
            canonicalJson(readback?.applyState?.lastApplied) !==
              canonicalJson(applyReference)) {
          fail(P02_APPLY_ERROR.COMMIT_FAILED);
        }
        return committed;
      },
      applyClosure: null
    });

    return composition.applyOneHop({
      objectDomain,
      objectId,
      objectKey,
      syncPeerId: configuredPeer.syncPeerId,
      selectedLeaf,
      currentAnchor
    });
  }

  return Object.freeze({
    schema: P02_CHROME_APPLY_V2.SCHEMA,
    applySelectedAdmittedV2Revision
  });
}
