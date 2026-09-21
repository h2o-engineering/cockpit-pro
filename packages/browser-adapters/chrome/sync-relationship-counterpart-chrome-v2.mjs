/*
 * P02 T05 — Chrome relationship COUNTERPART (Receive / admission / Apply of
 * studio.folder.v1 and studio.chat-folder-binding.v1 on the Chrome surface).
 *
 * WHAT THIS MODULE IS. The single Sync-owned Chrome owner of the receiving
 * half of the relationship families. It turns a trusted peer's advertised
 * relationship heads into read-only descriptors, admits their revisions
 * through the EXISTING v2 branch-admission core over the store's
 * DOMAIN-QUALIFIED evidence ports (T05 / D3), classifies them with the shared
 * classifier, evaluates dependencies against the strict page-world source, and
 * materializes exactly one admitted hop per Apply through the strict H2O
 * Folder owner write adapter (H2O.folders.applyMetadataOperation for
 * create-with-verbatim-id / rename, H2O.folders.setBinding for bind / move /
 * unbind). Every read-back is a strict owner read.
 *
 * WHAT THIS MODULE IS NOT. It is not a scheduler (the accepted P02 runtime
 * dispatches it), not a second conflict model (the shared classifier and the
 * anchor contract decide), not a Folder authority (it only invokes the owner
 * API and fails closed when the owner refuses), and never a path into the
 * saved-chat archive importer: a relationship payload cannot reach
 * importFullBundle from here by construction. It never touches localStorage,
 * the legacy FOLDER_STATE mirror, caches or fallback helpers, and never
 * mutates native ChatGPT projects/folders. Delete / restore / colour /
 * hierarchy / sort / project-backed operations are not implemented and are
 * refused as ineligible.
 *
 * IDENTITY. Every store read and write goes through the domain-qualified
 * ports keyed by (objectDomain, objectId) / P02 objectKey, so a binding that
 * shares a chat's objectId string never inherits or overwrites the chat's
 * accepted objectId-keyed state.
 *
 * ANCHOR-PROVEN PARENTS. The shared classifier proves a retained node only
 * through retained parents or a root. A relationship revision this peer
 * PUBLISHED (its ledger tip) or APPLIED is a repository-proven anchor pair but
 * is not itself retained branch evidence, so a Desktop descendant of it would
 * otherwise read as retained-unproven-parent forever. The branch index proves
 * such a hop through the typed anchor set (matchAnchorPair, blob-keyed,
 * id-cross-checked); this module carries that SAME proof into the classifier
 * input by projecting each anchor pair a proven node chains to as a validated
 * root node (`anchorProjected: true`). Nothing is fabricated: the pair is the
 * peer's own recorded anchor, its bytes were verified when it was published
 * or applied, and only nodes the index already proved through it are affected.
 *
 * NO ECHO, NO FABRICATED REVISION. Apply commits the applied anchor and the
 * ledger direction in one store transaction; the anchor carries the applied
 * payload identity, so the publication enumerator sees byte-identical page
 * state as converged and never re-mints it. Already-applied replays are
 * zero-write. Typed fail-closed outcomes everywhere.
 */

import {
  P02_RELATIONSHIP_DOMAINS_V2,
  canonicalFolderName,
  isRelationshipObjectDomain,
  relationshipDomainDescriptor,
  validateRelationshipPayload
} from '../../core/sync-relationship-domains-v2.mjs';
import {
  classifyObjectState,
  createReadOnlyObjectDescriptor,
  sortReadOnlyObjectDescriptors
} from '../../core/sync-object-classifier-v2.mjs';
import {
  P02_ANCHOR_MATCH,
  createP02AnchorSet,
  matchAnchorPair,
  requireP02AnchorSet
} from '../../core/sync-p02-anchor-set-v2.mjs';
import {
  P02_ADMISSION_DISPOSITION,
  buildBranchIndex
} from '../../core/sync-branch-evidence-v2.mjs';
import { P02_APPLY_ERROR, P02_APPLY_VERDICT, selectApplyHop }
  from '../../core/sync-object-apply-v2.mjs';
import { P02_ATTEMPT_OUTCOME } from '../../core/sync-object-scheduler-v2.mjs';
import { createChromeV2BranchAdmission } from './sync-branch-admission-v2.mjs';
import { readChromeDomainProtocolState }
  from './sync-p02-domain-protocol-state-chrome-v2.mjs';
import { canonicalJson, objectKeyHex, writerKeyHex } from './sync-contract-v2.mjs';
import {
  P02_RELATIONSHIP_DOMAIN_V2,
  projectFolderCatalogState
} from './sync-revision-domain-relationship-v2.mjs';

const FOLDER_DOMAIN = P02_RELATIONSHIP_DOMAINS_V2.FOLDER.OBJECT_DOMAIN;
const BINDING_DOMAIN = P02_RELATIONSHIP_DOMAINS_V2.BINDING.OBJECT_DOMAIN;
const CHAT_DOMAIN = P02_RELATIONSHIP_DOMAINS_V2.CHAT_OBJECT_DOMAIN;

export const P02_CHROME_RELATIONSHIP_COUNTERPART_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncChromeRelationshipCounterpart.p02.v1',
  RESULT_SCHEMA: 'h2o.studio.syncChromeRelationshipApplyResult.p02.v1',
  DEPENDENCY_SCHEMA: 'h2o.studio.syncChromeRelationshipDependency.p02.v1',
  FOLDER_OBJECT_DOMAIN: FOLDER_DOMAIN,
  BINDING_OBJECT_DOMAIN: BINDING_DOMAIN,
  RELATIONSHIP_OBJECT_DOMAINS: P02_RELATIONSHIP_DOMAINS_V2.RELATIONSHIP_OBJECT_DOMAINS,
  /* Deterministic family order for a merged descriptor set: a referent
   * (folder) precedes its referrers (chat, then binding). Same order the
   * Chrome publication owner uses; reproducibility only, never authority. */
  FAMILY_ORDER: Object.freeze([FOLDER_DOMAIN, CHAT_DOMAIN, BINDING_DOMAIN]),
  /* The ONLY write authority: the page-world H2O Folder owner, in strict mode. */
  WRITER_AUTHORITY: P02_RELATIONSHIP_DOMAIN_V2.SOURCE_AUTHORITY,
  REFERENCE_KIND: 'branch-evidence-v2',
  DIRECTION_APPLIED: 'applied',
  KIND: Object.freeze({
    CREATE_FOLDER: 'create-folder',
    RENAME_FOLDER: 'rename-folder',
    BIND_CHAT: 'bind-chat',
    UNBIND_CHAT: 'unbind-chat'
  }),
  MATERIALIZATION: Object.freeze({
    CREATED: 'created',
    RENAMED: 'renamed',
    BOUND: 'bound',
    UNFILED: 'unfiled',
    IDENTICAL: 'identical',
    NONE: 'none'
  }),
  BLOCK_REASON: 'dependency',
  DEPENDENCY_DETAIL: Object.freeze({
    FOLDER_MISSING: 'folder-missing',
    CHAT_MISSING: 'chat-missing'
  }),
  NON_CHAT_RECEIVE: 'domain-qualified-idb-state',
  DIRECTION_COVERAGE: P02_RELATIONSHIP_DOMAIN_V2.DIRECTION_COVERAGE
});

export const P02_CHROME_RELATIONSHIP_COUNTERPART_ERROR = Object.freeze({
  DEPENDENCY_INVALID: 'p02-t05-relationship-counterpart-dependency-invalid',
  DOMAIN_UNSUPPORTED: 'p02-t05-relationship-counterpart-domain-unsupported',
  ADVERTISEMENT_INVALID: 'p02-t05-relationship-counterpart-advertisement-invalid',
  CANDIDATE_INELIGIBLE: 'p02-t05-relationship-counterpart-candidate-ineligible',
  CANDIDATE_AMBIGUOUS: 'p02-t05-relationship-counterpart-candidate-ambiguous',
  BRANCH_EVIDENCE_INVALID: 'p02-t05-relationship-counterpart-branch-evidence-invalid',
  ANCHOR_INVALID: 'p02-t05-relationship-counterpart-anchor-invalid',
  PEER_AUTHORITY_INVALID: 'p02-t05-relationship-counterpart-peer-authority-invalid',
  SOURCE_UNAVAILABLE: 'relationship-source-unavailable',
  SOURCE_NOT_STRICT: 'relationship-source-not-strict',
  WRITER_UNAVAILABLE: 'p02-t05-relationship-writer-unavailable',
  WRITER_NOT_STRICT: 'p02-t05-relationship-writer-not-strict',
  WRITER_REFUSED: 'p02-t05-relationship-writer-refused',
  READBACK_MISMATCH: 'p02-t05-relationship-readback-mismatch',
  PAYLOAD_INVALID: 'p02-t05-relationship-payload-invalid',
  OPERATION_NOT_ELIGIBLE: 'p02-t05-relationship-operation-not-eligible'
});

const HEX64 = /^[0-9a-f]{64}$/;
const hex64 = (value) => typeof value === 'string' && HEX64.test(value);
const clean = (value) => String(value == null ? '' : value).trim();
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const strictIdentifier = (value) =>
  typeof value === 'string' && Array.from(value).length > 0 &&
  Array.from(value).length <= 512 && value.trim() === value && !/\p{Cc}/u.test(value);

function fail(code, detail = null) {
  const error = new Error(code);
  error.code = code;
  if (detail !== null && detail !== undefined) error.detail = String(detail);
  throw error;
}

function requireRelationshipDomain(objectDomain) {
  if (!isRelationshipObjectDomain(objectDomain)) {
    fail(P02_CHROME_RELATIONSHIP_COUNTERPART_ERROR.DOMAIN_UNSUPPORTED, objectDomain);
  }
  return objectDomain;
}

const familyRank = (objectDomain) => {
  const rank = P02_CHROME_RELATIONSHIP_COUNTERPART_V2.FAMILY_ORDER.indexOf(objectDomain);
  return rank < 0 ? P02_CHROME_RELATIONSHIP_COUNTERPART_V2.FAMILY_ORDER.length : rank;
};

/* Deterministic ordering of a MERGED (chat + relationship) descriptor set:
 * family rank first, then the descriptor's own ordering key. */
export function sortMergedDescriptors(descriptors) {
  return Object.freeze([...descriptors].sort((left, right) =>
    familyRank(left.objectDomain) - familyRank(right.objectDomain) ||
    left.orderingKey.localeCompare(right.orderingKey) ||
    left.objectKey.localeCompare(right.objectKey)));
}

/* Split trusted peer advertisements by family: relationship heads go to this
 * counterpart, everything else keeps the accepted chat path (where an unknown
 * domain still fails closed exactly as before). */
export function partitionTrustedPeerAdvertisements(advertisements) {
  const chat = [];
  const relationship = [];
  for (const advertisement of Array.isArray(advertisements) ? advertisements : []) {
    const heads = Array.isArray(advertisement?.heads) ? advertisement.heads : [];
    const relationshipHeads = heads.filter((head) =>
      isPlainObject(head) && isRelationshipObjectDomain(head.objectDomain));
    const otherHeads = heads.filter((head) => !relationshipHeads.includes(head));
    chat.push(Object.freeze({ ...advertisement, heads: Object.freeze(otherHeads) }));
    if (relationshipHeads.length > 0) {
      relationship.push(Object.freeze({ ...advertisement, heads: Object.freeze(relationshipHeads) }));
    }
  }
  return Object.freeze({ chat: Object.freeze(chat), relationship: Object.freeze(relationship) });
}

/* A strict owner envelope: tagged by the bridge as the page-world authority
 * read/written in strict mode. Anything else is refused as not-strict. */
function strictEnvelope(value, code) {
  if (!isPlainObject(value) || value.strict !== true ||
      value.source !== P02_CHROME_RELATIONSHIP_COUNTERPART_V2.WRITER_AUTHORITY) {
    fail(code, 'not-strict');
  }
  return value;
}

function typedSourceError(error) {
  const code = clean(error?.code);
  const wrapped = new Error(code || P02_CHROME_RELATIONSHIP_COUNTERPART_ERROR.SOURCE_UNAVAILABLE);
  wrapped.code = code === P02_CHROME_RELATIONSHIP_COUNTERPART_ERROR.SOURCE_NOT_STRICT
    ? code
    : P02_CHROME_RELATIONSHIP_COUNTERPART_ERROR.SOURCE_UNAVAILABLE;
  wrapped.detail = clean(error?.detail || error?.message) || null;
  return wrapped;
}

/* The selected leaf's proven ancestry, root-first, terminating at a retained
 * root or at a PROVEN anchor pair (the same walk the accepted chat Apply
 * performs). */
function branchChain(records, leaf, anchorSet) {
  const E = P02_CHROME_RELATIONSHIP_COUNTERPART_ERROR;
  const byId = new Map();
  for (const record of records) {
    const id = clean(record?.revisionId);
    const blob = clean(record?.revisionBlobSha256Hex);
    if (!id || !hex64(blob) || byId.has(id)) fail(E.BRANCH_EVIDENCE_INVALID);
    byId.set(id, record);
  }
  const leafId = clean(leaf?.revisionId);
  const leafBlob = clean(leaf?.revisionBlobSha256);
  if (matchAnchorPair(anchorSet, { revisionId: leafId, revisionBlobSha256: leafBlob }) ===
      P02_ANCHOR_MATCH.PROVEN) {
    return Object.freeze({
      chain: Object.freeze([{ revisionId: leafId, revisionBlobSha256: leafBlob }]),
      anchor: anchorSet.pairs.find((pair) =>
        pair.revisionId === leafId && pair.revisionBlobSha256 === leafBlob)
    });
  }
  const chain = [];
  const seen = new Set();
  let cursor = leafId;
  let anchor = null;
  for (;;) {
    const record = byId.get(cursor);
    if (!record || seen.has(cursor)) fail(E.BRANCH_EVIDENCE_INVALID);
    seen.add(cursor);
    chain.unshift({ revisionId: record.revisionId, revisionBlobSha256: record.revisionBlobSha256Hex });
    const parentId = record.parentRevisionId ?? null;
    const parentBlob = record.parentRevisionBlobSha256Hex ?? null;
    if (parentId === null && parentBlob === null) break;
    if (!clean(parentId) || !hex64(parentBlob)) fail(E.BRANCH_EVIDENCE_INVALID);
    const match = matchAnchorPair(anchorSet, { revisionId: parentId, revisionBlobSha256: parentBlob });
    if (match === P02_ANCHOR_MATCH.IDENTITY_CONFLICT) fail(E.ANCHOR_INVALID);
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

const refuse = (verdict, reason, extra = {}) => Object.freeze({
  schema: P02_CHROME_RELATIONSHIP_COUNTERPART_V2.RESULT_SCHEMA,
  verdict, reason, applied: false, canonicalMutated: false,
  outcome: verdict === P02_APPLY_VERDICT.BLOCKED
    ? P02_ATTEMPT_OUTCOME.BLOCKED
    : verdict === P02_APPLY_VERDICT.INTEGRITY
      ? P02_ATTEMPT_OUTCOME.INTEGRITY
      : P02_ATTEMPT_OUTCOME.NO_EFFECT,
  ...extra
});

export function createChromeRelationshipCounterpart({
  syncStore,
  relationshipAuthority,
  archiveAuthority,
  readRevisionBytes,
  sha256HexBytes,
  cryptoImplementation = globalThis.crypto
} = {}) {
  const E = P02_CHROME_RELATIONSHIP_COUNTERPART_ERROR;
  const C = P02_CHROME_RELATIONSHIP_COUNTERPART_V2;
  if (!isPlainObject(syncStore) ||
      typeof syncStore.recordRelationshipBranchEvidence !== 'function' ||
      typeof syncStore.listRelationshipBranchEvidence !== 'function' ||
      typeof syncStore.readRelationshipApplyState !== 'function' ||
      typeof syncStore.stageRelationshipApplyIntent !== 'function' ||
      typeof syncStore.commitRelationshipApplyIntent !== 'function' ||
      typeof syncStore.readLocalPublicationTip !== 'function' ||
      typeof syncStore.resolveLocalPublicationPending !== 'function' ||
      typeof syncStore.readApplySnapshot !== 'function') {
    fail(E.DEPENDENCY_INVALID, 'sync-store-ports');
  }
  if (!isPlainObject(relationshipAuthority) ||
      typeof relationshipAuthority.listFolders !== 'function' ||
      typeof relationshipAuthority.resolveBindings !== 'function') {
    fail(E.DEPENDENCY_INVALID, 'relationship-authority-reads');
  }
  for (const capability of ['applyFolderOperation', 'setBinding']) {
    if (relationshipAuthority[capability] !== undefined &&
        typeof relationshipAuthority[capability] !== 'function') {
      fail(E.DEPENDENCY_INVALID, `relationship-authority-${capability}`);
    }
  }
  if (!isPlainObject(archiveAuthority) || typeof archiveAuthority.listWorkbenchRows !== 'function') {
    fail(E.DEPENDENCY_INVALID, 'archive-authority');
  }
  if (typeof readRevisionBytes !== 'function' || typeof sha256HexBytes !== 'function') {
    fail(E.DEPENDENCY_INVALID, 'revision-reader');
  }
  const writerCapabilities = Object.freeze({
    applyFolderOperation: typeof relationshipAuthority.applyFolderOperation === 'function',
    setBinding: typeof relationshipAuthority.setBinding === 'function'
  });

  /* ---------------- domain-qualified evidence ports ---------------- */

  const admissions = new Map();
  function evidencePortsFor(objectDomain) {
    requireRelationshipDomain(objectDomain);
    return Object.freeze({
      listBranchEvidence: (objectId) =>
        syncStore.listRelationshipBranchEvidence({ objectDomain, objectId }),
      recordBranchEvidence: (record) =>
        syncStore.recordRelationshipBranchEvidence({ ...record, objectDomain })
    });
  }
  function admissionFor(objectDomain) {
    requireRelationshipDomain(objectDomain);
    let admission = admissions.get(objectDomain);
    if (!admission) {
      admission = createChromeV2BranchAdmission({
        evidenceStore: evidencePortsFor(objectDomain), sha256HexBytes, objectDomain
      });
      admissions.set(objectDomain, admission);
    }
    return admission;
  }

  async function readAdmittedEvidence({ objectDomain, objectId } = {}) {
    requireRelationshipDomain(objectDomain);
    const rows = await syncStore.listRelationshipBranchEvidence({ objectDomain, objectId });
    return (rows || []).map((record) => ({
      revisionId: record.revisionId,
      revisionBlobSha256: record.revisionBlobSha256Hex,
      disposition: record.disposition
    }));
  }

  /* ---------------- protocol state / anchors / canonical head ---------------- */

  async function domainState({ objectDomain, objectId }) {
    requireRelationshipDomain(objectDomain);
    return readChromeDomainProtocolState({ objectDomain, objectId, syncStore, cryptoImplementation });
  }

  function decoratedProtocolState(state) {
    const published = state.protocolState.lastPublished;
    return {
      ...state.protocolState,
      lastPublished: published && hex64(state.identity.publishedPayloadSha256)
        ? { ...published, payloadSha256: state.identity.publishedPayloadSha256 }
        : published
    };
  }

  /* Pairs are promoted into the typed anchor set only under a recorded
   * direction, exactly as the accepted enumerators do. */
  function anchorSetFromState(state) {
    return createP02AnchorSet({
      objectDomain: state.objectDomain,
      objectId: state.objectId,
      protocolState: state.identity.direction ? decoratedProtocolState(state) : {}
    });
  }

  /* The canonical local head of a relationship object on the receive side IS
   * its latest convergence anchor (the direction names it), mirroring the
   * Desktop T03 rule: no anchor -> remote-first; leaf == anchor -> converged;
   * proven descendant -> remote-ahead. */
  function canonicalLocalHeadFromState(state) {
    const decorated = decoratedProtocolState(state);
    const pair = state.identity.direction === 'applied'
      ? decorated.lastApplied
      : state.identity.direction === 'published'
        ? decorated.lastPublished
        : null;
    if (!pair || !strictIdentifier(pair.revisionId) || !hex64(pair.revisionBlobSha256)) return null;
    return {
      revisionId: pair.revisionId,
      revisionBlobSha256: pair.revisionBlobSha256,
      ...(hex64(pair.payloadSha256) ? { payloadSha256: pair.payloadSha256 } : {}),
      deleted: false
    };
  }

  async function anchorSetFor(scope) {
    return anchorSetFromState(await domainState(scope));
  }

  async function protocolStateFor(scope) {
    return (await domainState(scope)).protocolState;
  }

  /*
   * Retained evidence in classifier shape. Proof comes from the shared branch
   * index built against the typed anchor set; a node the index proved through
   * an anchor hop gets that anchor projected beside it as a validated root so
   * the classifier's parent walk reaches it (see the module header).
   */
  async function retainedEvidenceFor({ objectDomain, objectId, anchorSet }) {
    const records = await syncStore.listRelationshipBranchEvidence({ objectDomain, objectId });
    const raw = (records || []).map((record) => ({
      document: {
        objectDomain, objectId,
        revisionId: record.revisionId,
        previousRevisionId: record.parentRevisionId ?? null,
        previousRevisionBlobSha256: record.parentRevisionBlobSha256Hex ?? null,
        ...(record.closureType ? { closureType: record.closureType } : {})
      },
      revisionBlobSha256: record.revisionBlobSha256Hex,
      disposition: record.disposition
    }));
    const index = buildBranchIndex({
      objectDomain, objectId, records: raw, p02AnchorSet: anchorSet,
      quarantineIdentityConflicts: true
    });
    const proven = new Set(index.provenRevisionIds);
    const retainedIds = new Set(index.revisionIds);
    const projectedAnchors = new Map();
    const retainedEvidence = index.nodes.map((node) => {
      const quarantined = node.disposition === P02_ADMISSION_DISPOSITION.QUARANTINED;
      if (proven.has(node.revisionId) && !quarantined && node.previousRevisionId !== null &&
          !retainedIds.has(node.previousRevisionId)) {
        const pair = anchorSet.pairs.find((candidate) =>
          candidate.revisionId === node.previousRevisionId &&
          candidate.revisionBlobSha256 === node.previousRevisionBlobSha256);
        if (pair) projectedAnchors.set(pair.revisionId, pair);
      }
      return {
        document: node.document,
        revisionBlobSha256: node.revisionBlobSha256,
        validated: proven.has(node.revisionId) && !quarantined
      };
    });
    for (const pair of projectedAnchors.values()) {
      retainedEvidence.push({
        document: {
          objectDomain, objectId, revisionId: pair.revisionId,
          previousRevisionId: null, previousRevisionBlobSha256: null
        },
        revisionBlobSha256: pair.revisionBlobSha256,
        validated: true,
        anchorProjected: true
      });
    }
    const integrityQuarantined = raw.some((record) =>
      record.disposition === P02_ADMISSION_DISPOSITION.QUARANTINED) ||
      index.identitySquattedRevisionIds.length > 0 ||
      index.identityConflictRevisionIds.length > 0;
    return { retainedEvidence, integrityQuarantined, index };
  }

  async function describe({ syncPeerId, objectDomain, objectId, objectKey, tips = [] }) {
    const state = await domainState({ objectDomain, objectId });
    if (state.objectKey !== objectKey) fail(E.ADVERTISEMENT_INVALID, 'object-key-mismatch');
    const p02AnchorSet = anchorSetFromState(state);
    const retained = await retainedEvidenceFor({ objectDomain, objectId, anchorSet: p02AnchorSet });
    return createReadOnlyObjectDescriptor({
      objectDomain, objectId, objectKey, syncPeerId,
      canonicalLocalHead: canonicalLocalHeadFromState(state),
      p02AnchorSet,
      protocolState: state.protocolState,
      retainedEvidence: retained.retainedEvidence,
      advertisedTips: tips,
      trustedPeerAdvertisementPending: tips.length > 0,
      dirty: false,
      publishable: false,
      pending: state.pending,
      blockReason: null,
      integrityQuarantined: retained.integrityQuarantined
    });
  }

  /* Remote relationship descriptors from the trusted peers' verified heads
   * snapshots (already partitioned by family by the composition). */
  async function enumerateRemoteDescriptors({ trustedPeerAdvertisements = [] } = {}) {
    const scopes = new Map();
    for (const advertisement of trustedPeerAdvertisements) {
      if (!isPlainObject(advertisement) || !strictIdentifier(advertisement.syncPeerId) ||
          !hex64(advertisement.writerKey) || !Array.isArray(advertisement.heads) ||
          advertisement.writerKey !== await writerKeyHex(advertisement.syncPeerId, cryptoImplementation)) {
        fail(E.ADVERTISEMENT_INVALID, 'advertisement');
      }
      for (const head of advertisement.heads) {
        if (!isPlainObject(head) || !isRelationshipObjectDomain(head.objectDomain) ||
            !strictIdentifier(head.objectId) || !hex64(head.objectKey) ||
            !strictIdentifier(head.revisionId) || !hex64(head.revisionBlobSha256) ||
            head.writerSyncPeerId !== advertisement.syncPeerId ||
            head.objectKey !== await objectKeyHex(head.objectDomain, head.objectId, cryptoImplementation)) {
          fail(E.ADVERTISEMENT_INVALID, 'head');
        }
        const key = `${advertisement.syncPeerId}\u0000${head.objectDomain}\u0000${head.objectId}`;
        const scope = scopes.get(key) || {
          syncPeerId: advertisement.syncPeerId, objectDomain: head.objectDomain,
          objectId: head.objectId, objectKey: head.objectKey, tips: new Map()
        };
        const prior = scope.tips.get(head.revisionId);
        if (prior && prior.revisionBlobSha256 !== head.revisionBlobSha256) {
          fail(E.ADVERTISEMENT_INVALID, 'head-conflict');
        }
        scope.tips.set(head.revisionId, { revisionId: head.revisionId, revisionBlobSha256: head.revisionBlobSha256 });
        scopes.set(key, scope);
      }
    }
    const descriptors = [];
    for (const scope of scopes.values()) {
      descriptors.push(await describe({
        ...scope,
        tips: [...scope.tips.values()].sort((left, right) =>
          left.revisionId.localeCompare(right.revisionId) ||
          left.revisionBlobSha256.localeCompare(right.revisionBlobSha256))
      }));
    }
    return sortReadOnlyObjectDescriptors(descriptors);
  }

  async function describeScope({ syncPeerId, objectDomain, objectId, objectKey = null } = {}) {
    requireRelationshipDomain(objectDomain);
    const key = objectKey ?? await objectKeyHex(objectDomain, objectId, cryptoImplementation);
    return describe({ syncPeerId, objectDomain, objectId, objectKey: key, tips: [] });
  }

  /* ---------------- strict source reads ---------------- */

  async function strictFolders() {
    let value;
    try { value = await relationshipAuthority.listFolders(); }
    catch (error) { throw typedSourceError(error); }
    const envelope = strictEnvelope(value, E.SOURCE_NOT_STRICT);
    if (!Array.isArray(envelope.folders)) fail(E.SOURCE_NOT_STRICT, 'folders');
    return envelope.folders;
  }

  async function strictBinding(chatId) {
    let value;
    try { value = await relationshipAuthority.resolveBindings([chatId]); }
    catch (error) { throw typedSourceError(error); }
    const envelope = strictEnvelope(value, E.SOURCE_NOT_STRICT);
    const binding = isPlainObject(envelope.bindings) ? envelope.bindings[chatId] : null;
    if (!isPlainObject(binding) || clean(binding.error)) {
      fail(E.SOURCE_UNAVAILABLE, clean(binding?.error) || 'binding-not-resolved');
    }
    return { folderId: clean(binding.folderId) || null, folderName: clean(binding.folderName) };
  }

  async function liveChatIds() {
    const rows = await archiveAuthority.listWorkbenchRows();
    const ids = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = clean(row?.chatId || row?.id);
      if (id && row?.isDeleted !== true) ids.add(id);
    }
    return ids;
  }

  /* The strict page-world projection of ONE relationship object's CURRENT
   * state, in canonical payload form - the receive side's pre/post-state. */
  async function pageState(objectDomain, objectId) {
    if (objectDomain === FOLDER_DOMAIN) {
      const folders = await strictFolders();
      const record = folders.find((row) => clean(row?.id ?? row?.folderId) === objectId) ?? null;
      if (!record) return { present: false, payload: null, payloadSha256: null, record: null, eligibility: null };
      const projection = await projectFolderCatalogState(record, { cryptoImplementation });
      const name = canonicalFolderName(typeof record.name === 'string' ? record.name
        : typeof record.title === 'string' ? record.title : '');
      const payload = { schema: P02_RELATIONSHIP_DOMAINS_V2.FOLDER.PAYLOAD_SCHEMA, folderId: objectId, name };
      return {
        present: true, record, payload, name,
        payloadSha256: projection.eligible ? projection.payloadSha256Hex
          : await sha256HexBytes(new TextEncoder().encode(canonicalJson(payload))),
        eligibility: projection.eligible ? null : projection
      };
    }
    const binding = await strictBinding(objectId);
    const payload = { schema: P02_RELATIONSHIP_DOMAINS_V2.BINDING.PAYLOAD_SCHEMA, chatId: objectId, folderId: binding.folderId };
    return {
      present: true, payload, folderId: binding.folderId,
      payloadSha256: await sha256HexBytes(new TextEncoder().encode(canonicalJson(payload))),
      eligibility: null
    };
  }

  /* ---------------- dependencies ---------------- */

  const dependencyReady = (extra = {}) => Object.freeze({
    schema: C.DEPENDENCY_SCHEMA, ready: true, blockReason: null, detail: null, ...extra
  });
  const dependencyBlocked = (detail, extra = {}) => Object.freeze({
    schema: C.DEPENDENCY_SCHEMA, ready: false, blockReason: C.BLOCK_REASON, detail, ...extra
  });

  async function readDependencyState({ objectDomain, objectId, canonical } = {}) {
    requireRelationshipDomain(objectDomain);
    if (!isPlainObject(canonical) || canonical.objectId !== objectId) {
      fail(E.PAYLOAD_INVALID, 'canonical-object-mismatch');
    }
    if (objectDomain === FOLDER_DOMAIN) return dependencyReady({ requires: Object.freeze([]) });
    const chats = await liveChatIds();
    if (!chats.has(canonical.chatId)) {
      return dependencyBlocked(C.DEPENDENCY_DETAIL.CHAT_MISSING, { chatId: canonical.chatId });
    }
    if (canonical.folderId === null) {
      return dependencyReady({ requires: Object.freeze(['chat']), chatId: canonical.chatId });
    }
    const folders = await strictFolders();
    const folder = folders.find((row) => clean(row?.id ?? row?.folderId) === canonical.folderId) ?? null;
    if (!folder) {
      return dependencyBlocked(C.DEPENDENCY_DETAIL.FOLDER_MISSING, {
        chatId: canonical.chatId, folderId: canonical.folderId
      });
    }
    const projection = await projectFolderCatalogState(folder, { cryptoImplementation });
    if (!projection.eligible) {
      return dependencyBlocked(C.DEPENDENCY_DETAIL.FOLDER_MISSING, {
        chatId: canonical.chatId, folderId: canonical.folderId,
        folderEligibility: projection.eligibility
      });
    }
    return dependencyReady({
      requires: Object.freeze(['chat', 'folder']), chatId: canonical.chatId, folderId: canonical.folderId
    });
  }

  /* ---------------- admitted leaf reads ---------------- */

  async function readLeaf({ objectDomain, objectId, objectKey, syncPeerId, revisionId }) {
    const records = await syncStore.listRelationshipBranchEvidence({ objectDomain, objectId });
    const record = (records || []).find((row) => row.revisionId === revisionId) ?? null;
    if (!record) return { status: 'leaf-not-retained' };
    let read;
    try {
      read = await readRevisionBytes({
        objectDomain, objectId, objectKey, syncPeerId,
        revisionId, revisionBlobSha256: record.revisionBlobSha256Hex
      });
    } catch (error) {
      return { status: 'revision-unreadable', reason: clean(error?.code) || 'revision-read-failed' };
    }
    const status = clean(read?.status);
    if (status === 'absent' || status === 'missing') return { status: 'revision-missing' };
    if (status === 'blocked(permission)') return { status: 'blocked(permission)' };
    if (status !== 'verified' || !(read?.bytes instanceof Uint8Array)) {
      return { status: 'revision-unreadable', reason: clean(read?.reason) || status || 'unverified' };
    }
    const observed = clean(await sha256HexBytes(read.bytes));
    const value = read.value;
    if (observed !== record.revisionBlobSha256Hex || !isPlainObject(value) ||
        value.revisionId !== revisionId || value.objectDomain !== objectDomain ||
        value.objectId !== objectId || !hex64(value.payloadSha256) ||
        (value.previousRevisionId ?? null) !== (record.parentRevisionId ?? null) ||
        (value.previousRevisionBlobSha256 ?? null) !== (record.parentRevisionBlobSha256Hex ?? null)) {
      return { status: 'revision-unreadable', reason: P02_APPLY_ERROR.BYTES_CHANGED };
    }
    let canonical;
    try {
      canonical = validateRelationshipPayload(objectDomain, value.payload, objectId);
    } catch (error) {
      return { status: 'payload-invalid', reason: clean(error?.code) || E.PAYLOAD_INVALID };
    }
    return {
      status: 'verified', record, revision: value, canonical,
      leaf: Object.freeze({
        revisionId, revisionBlobSha256: record.revisionBlobSha256Hex, payloadSha256: value.payloadSha256
      })
    };
  }

  /* ---------------- classification ---------------- */

  async function classifyRelationshipDescriptor(descriptor) {
    if (!isPlainObject(descriptor) || !isRelationshipObjectDomain(descriptor.objectDomain)) {
      fail(E.DOMAIN_UNSUPPORTED, descriptor?.objectDomain);
    }
    const verdict = classifyObjectState(descriptor);
    const { objectDomain, objectId, objectKey, syncPeerId } = descriptor;
    if (verdict.classification !== 'remote-ahead' || !strictIdentifier(verdict.applyCandidateRevisionId || '')) {
      return Object.freeze({ ...verdict, objectDomain, objectId, dependency: null });
    }
    if (verdict.applyEligibleByEvidence !== true) {
      return Object.freeze({ ...verdict, objectDomain, objectId, dependency: null });
    }
    const read = await readLeaf({ objectDomain, objectId, objectKey, syncPeerId, revisionId: verdict.applyCandidateRevisionId });
    if (read.status === 'payload-invalid') {
      return Object.freeze({
        ...classifyObjectState({ ...descriptor, integrityQuarantined: true }),
        reason: read.reason, objectDomain, objectId, dependency: null
      });
    }
    if (read.status !== 'verified') {
      const blockReason = read.status === 'blocked(permission)' ? 'permission' : 'transport';
      return Object.freeze({
        ...classifyObjectState({ ...descriptor, blockReason }),
        reason: read.reason || read.status, objectDomain, objectId, dependency: null
      });
    }
    let dependency;
    try {
      dependency = await readDependencyState({ objectDomain, objectId, canonical: read.canonical });
    } catch (error) {
      return Object.freeze({
        ...classifyObjectState({ ...descriptor, blockReason: 'transport' }),
        reason: clean(error?.code) || E.SOURCE_UNAVAILABLE, objectDomain, objectId, dependency: null
      });
    }
    if (dependency.ready !== true) {
      return Object.freeze({
        ...classifyObjectState({ ...descriptor, blockReason: C.BLOCK_REASON }),
        objectDomain, objectId,
        applyCandidateRevisionId: verdict.applyCandidateRevisionId,
        dependency, dependencyDetail: dependency.detail
      });
    }
    return Object.freeze({ ...verdict, objectDomain, objectId, dependency });
  }

  /* ---------------- strict owner writes ---------------- */

  async function ownerWrite(kind, request) {
    const bindingKind = kind === C.KIND.BIND_CHAT || kind === C.KIND.UNBIND_CHAT;
    const write = bindingKind
      ? relationshipAuthority.setBinding
      : relationshipAuthority.applyFolderOperation;
    if (typeof write !== 'function') fail(E.WRITER_UNAVAILABLE, kind);
    let result;
    try {
      result = await write(bindingKind
        ? { chatId: request.chatId, folderId: request.folderId ?? '' }
        : { operationType: kind, folderId: request.folderId, name: request.name });
    } catch (error) {
      const code = clean(error?.code);
      fail(code === E.WRITER_UNAVAILABLE || code === E.WRITER_NOT_STRICT ? code : E.WRITER_REFUSED,
        clean(error?.detail || error?.message) || 'writer-threw');
    }
    strictEnvelope(result, E.WRITER_NOT_STRICT);
    if (result.ok !== true) {
      const blocker = Array.isArray(result.blockers) && result.blockers.length > 0
        ? clean(result.blockers[0]?.code ?? result.blockers[0])
        : '';
      fail(E.WRITER_REFUSED, blocker || clean(result.reason || result.status) || 'owner-refused');
    }
    return result;
  }

  /* State-based plan: the admitted payload IS the desired page state. */
  async function plan(objectDomain, canonical, current) {
    const M = C.MATERIALIZATION;
    if (objectDomain === FOLDER_DOMAIN) {
      if (!current.present) {
        return { kind: C.KIND.CREATE_FOLDER, request: { folderId: canonical.folderId, name: canonical.name } };
      }
      if (current.eligibility) {
        return { kind: null, refusal: E.OPERATION_NOT_ELIGIBLE,
          detail: `${current.eligibility.eligibility}:${current.eligibility.detail || ''}` };
      }
      if (current.name === canonical.name) return { kind: null, materialization: M.IDENTICAL };
      return { kind: C.KIND.RENAME_FOLDER, request: { folderId: canonical.folderId, name: canonical.name } };
    }
    if (canonical.folderId === null) {
      if (current.folderId === null) return { kind: null, materialization: M.IDENTICAL };
      return { kind: C.KIND.UNBIND_CHAT, request: { chatId: canonical.chatId, folderId: '' } };
    }
    if (current.folderId === canonical.folderId) return { kind: null, materialization: M.IDENTICAL };
    return { kind: C.KIND.BIND_CHAT, request: { chatId: canonical.chatId, folderId: canonical.folderId } };
  }

  /* ---------------- Apply ---------------- */

  async function applySelectedRelationshipRevision({ descriptor, classifierVerdict, configuredPeer } = {}) {
    const M = C.MATERIALIZATION;
    if (!isPlainObject(descriptor) || !isPlainObject(classifierVerdict) ||
        classifierVerdict.classification !== 'remote-ahead' ||
        classifierVerdict.applyEligibleByEvidence !== true ||
        !clean(classifierVerdict.applyCandidateRevisionId) ||
        !isPlainObject(configuredPeer) ||
        configuredPeer.syncPeerId !== descriptor.syncPeerId ||
        !hex64(configuredPeer.writerKey)) {
      fail(E.CANDIDATE_INELIGIBLE);
    }
    const objectDomain = requireRelationshipDomain(descriptor.objectDomain);
    const objectId = clean(descriptor.objectId);
    const objectKey = clean(descriptor.objectKey);
    const syncPeerId = descriptor.syncPeerId;
    if (!objectId || !hex64(objectKey)) fail(E.CANDIDATE_INELIGIBLE);
    const family = relationshipDomainDescriptor(objectDomain).family;
    const anchorSet = requireP02AnchorSet(descriptor.p02AnchorSet) ??
      createP02AnchorSet({ objectDomain, objectId, protocolState: {} });
    if (anchorSet.objectDomain !== objectDomain || anchorSet.objectId !== objectId) fail(E.ANCHOR_INVALID);

    const base = {
      schema: C.RESULT_SCHEMA, objectDomain, objectId, objectKey, family,
      writerAuthority: C.WRITER_AUTHORITY, kind: null, materialization: M.NONE,
      relationshipWrites: 0, ownerResult: null, dependency: null, convergedDirection: null
    };

    const records = await syncStore.listRelationshipBranchEvidence({ objectDomain, objectId });
    const selected = (records || []).filter((record) =>
      record.revisionId === classifierVerdict.applyCandidateRevisionId);
    if (selected.length !== 1 || selected[0]?.closureType != null) {
      fail(selected.length > 1 ? E.CANDIDATE_AMBIGUOUS : E.BRANCH_EVIDENCE_INVALID);
    }
    const leafRecord = selected[0];
    const selectedLeaf = Object.freeze({
      revisionId: leafRecord.revisionId, revisionBlobSha256: leafRecord.revisionBlobSha256Hex
    });
    let ancestry;
    try { ancestry = branchChain(records, selectedLeaf, anchorSet); }
    catch (error) { return refuse(P02_APPLY_VERDICT.INTEGRITY, clean(error?.code) || E.BRANCH_EVIDENCE_INVALID, base); }
    const currentAnchor = ancestry.anchor
      ? Object.freeze({
        revisionId: ancestry.anchor.revisionId,
        revisionBlobSha256: ancestry.anchor.revisionBlobSha256,
        payloadSha256: ancestry.anchor.payloadSha256 ?? null
      })
      : null;
    if (currentAnchor === null && anchorSet.pairs.length !== 0) {
      return refuse(P02_APPLY_VERDICT.INTEGRITY, E.ANCHOR_INVALID, { ...base, detail: 'leaf-does-not-descend-from-anchor' });
    }

    /* One proven hop beyond the anchor; never the leaf by fiat. */
    const admittedPairs = new Set((records || []).map((record) =>
      `${record.revisionId} ${record.revisionBlobSha256Hex}`));
    const selection = selectApplyHop({
      chain: ancestry.chain, currentAnchor,
      admittedPairs: new Set([...admittedPairs, ...anchorSet.pairs.map((pair) =>
        `${pair.revisionId} ${pair.revisionBlobSha256}`)])
    });
    if (selection.alreadyApplied === true) {
      return Object.freeze({ ...base, verdict: P02_APPLY_VERDICT.ALREADY_APPLIED, applied: false,
        canonicalMutated: false, reason: null, remaining: 0, outcome: P02_ATTEMPT_OUTCOME.NO_EFFECT });
    }
    if (selection.hop === null) {
      const blocked = selection.reason === P02_APPLY_ERROR.HOP_NOT_ADMITTED;
      return refuse(blocked ? P02_APPLY_VERDICT.BLOCKED : P02_APPLY_VERDICT.NO_ELIGIBLE_HOP,
        selection.reason, { ...base, ...(blocked ? { blockReason: 'transport' } : {}) });
    }
    const hop = selection.hop;

    /* Apply-time byte re-verification and strict payload validation. */
    const read = await readLeaf({ objectDomain, objectId, objectKey, syncPeerId, revisionId: hop.revisionId });
    if (read.status === 'revision-missing') {
      return refuse(P02_APPLY_VERDICT.BLOCKED, P02_APPLY_ERROR.BYTES_MISSING, { ...base, blockReason: 'transport' });
    }
    if (read.status === 'blocked(permission)') {
      return refuse(P02_APPLY_VERDICT.BLOCKED, 'permission', { ...base, blockReason: 'permission' });
    }
    if (read.status === 'payload-invalid') return refuse(P02_APPLY_VERDICT.INTEGRITY, read.reason, base);
    if (read.status !== 'verified') {
      const changed = read.reason === P02_APPLY_ERROR.BYTES_CHANGED;
      return refuse(changed ? P02_APPLY_VERDICT.INTEGRITY : P02_APPLY_VERDICT.BLOCKED,
        read.reason || read.status, { ...base, ...(changed ? {} : { blockReason: 'transport' }) });
    }
    if (currentAnchor !== null &&
        ((read.revision.previousRevisionId ?? null) !== currentAnchor.revisionId ||
          (read.revision.previousRevisionBlobSha256 ?? null) !== currentAnchor.revisionBlobSha256)) {
      return refuse(P02_APPLY_VERDICT.INTEGRITY, P02_APPLY_ERROR.PARENT_PAIR_MISMATCH, base);
    }
    if (read.revision.writerSyncPeerId !== configuredPeer.syncPeerId) {
      return refuse(P02_APPLY_VERDICT.INTEGRITY, E.PEER_AUTHORITY_INVALID, base);
    }
    const canonical = read.canonical;
    const envelope = Object.freeze({
      revisionId: read.revision.revisionId,
      revisionBlobSha256: read.leaf.revisionBlobSha256,
      payloadSha256: read.leaf.payloadSha256
    });

    /* Apply state: a retained pending intent is uncertainty, never retry
     * permission. Recovery reads back before it decides anything. */
    const existing = await syncStore.readRelationshipApplyState({ objectDomain, objectId });
    const retainedPending = existing?.applyState?.pending ?? null;
    const recoveringPending = retainedPending?.referenceKind === C.REFERENCE_KIND &&
      retainedPending.revisionId === hop.revisionId &&
      retainedPending.revisionBlobSha256Hex === hop.revisionBlobSha256;

    /* Dependencies, immediately before any materialization. */
    let dependency;
    let current;
    try {
      dependency = await readDependencyState({ objectDomain, objectId, canonical });
      current = await pageState(objectDomain, objectId);
    } catch (error) {
      return refuse(P02_APPLY_VERDICT.BLOCKED, clean(error?.code) || E.SOURCE_UNAVAILABLE,
        { ...base, blockReason: 'transport', detail: clean(error?.detail) || null });
    }
    base.dependency = dependency;
    if (dependency.ready !== true) {
      return refuse(P02_APPLY_VERDICT.BLOCKED, dependency.blockReason, {
        ...base, blockReason: dependency.blockReason, dependencyDetail: dependency.detail
      });
    }

    const convergedNow = current.present && current.payloadSha256 === envelope.payloadSha256;
    /*
     * Fail-closed divergence: page state that moved away from an anchored
     * payload is a local change the protocol has not seen. It is never
     * overwritten by a remote hop (no last-writer-wins) unless it already
     * equals the target, which is convergence, not a conflict.
     */
    if (!recoveringPending && !convergedNow && currentAnchor !== null &&
        hex64(currentAnchor.payloadSha256) && current.present &&
        current.payloadSha256 !== currentAnchor.payloadSha256) {
      return refuse(P02_APPLY_VERDICT.BLOCKED, P02_APPLY_ERROR.PRECONDITION_FAILED, {
        ...base, blockReason: null, divergence: 'page-state-diverged-from-anchor'
      });
    }

    const planned = await plan(objectDomain, canonical, current);
    if (planned.refusal) {
      return refuse(P02_APPLY_VERDICT.INTEGRITY, planned.refusal, { ...base, detail: planned.detail ?? null });
    }
    const requiredCapability = planned.kind === null ? null
      : planned.kind === C.KIND.BIND_CHAT || planned.kind === C.KIND.UNBIND_CHAT
        ? 'setBinding' : 'applyFolderOperation';
    if (requiredCapability !== null && !writerCapabilities[requiredCapability]) {
      return refuse(P02_APPLY_VERDICT.BLOCKED, E.WRITER_UNAVAILABLE, { ...base, blockReason: 'permission', kind: planned.kind });
    }

    /* Durable intent is the mutation boundary. */
    const preState = current.present ? current.payloadSha256 : null;
    const applyReference = Object.freeze({
      referenceKind: C.REFERENCE_KIND,
      objectDomain, objectKey,
      writerSyncPeerId: configuredPeer.syncPeerId,
      writerKey: configuredPeer.writerKey,
      selectedLeafRevisionId: selectedLeaf.revisionId,
      selectedLeafRevisionBlobSha256Hex: selectedLeaf.revisionBlobSha256,
      revisionId: envelope.revisionId,
      parentRevisionId: read.record.parentRevisionId ?? null,
      parentRevisionBlobSha256Hex: read.record.parentRevisionBlobSha256Hex ?? null,
      branchEvidenceKey: read.record.key,
      revisionBlobSha256Hex: envelope.revisionBlobSha256,
      payloadSha256Hex: envelope.payloadSha256,
      /* Relationship payloads carry no source snapshot identity; the payload
       * digest is its own content identity ("relstate-<sha256>"). */
      sourceRevisionId: `${P02_RELATIONSHIP_DOMAIN_V2.LOCAL_SOURCE_REVISION_PREFIX}${envelope.payloadSha256}`,
      canonicalAnchorRevisionId: currentAnchor?.revisionId ?? null,
      canonicalAnchorRevisionBlobSha256Hex: currentAnchor?.revisionBlobSha256 ?? null,
      canonicalPreStateRevisionId: preState === null ? null
        : `${P02_RELATIONSHIP_DOMAIN_V2.LOCAL_SOURCE_REVISION_PREFIX}${preState}`,
      canonicalPreStatePayloadSha256Hex: preState
    });
    let staged;
    try {
      staged = await syncStore.stageRelationshipApplyIntent({
        objectDomain, objectId, canonicalAnchorRevisionId: currentAnchor?.revisionId ?? null,
        ...applyReference
      });
    } catch (error) {
      return refuse(P02_APPLY_VERDICT.BLOCKED, clean(error?.code) || P02_APPLY_ERROR.INTENT_STAGE_FAILED, base);
    }
    const stageVerdict = clean(staged?.verdict);

    const commit = async () => {
      const committed = await syncStore.commitRelationshipApplyIntent({
        objectDomain, objectId, revisionId: envelope.revisionId, applyReference
      });
      const readback = await syncStore.readRelationshipApplyState({ objectDomain, objectId });
      if (readback?.applyState?.pending !== null ||
          canonicalJson(readback?.applyState?.lastApplied) !== canonicalJson(applyReference)) {
        fail(P02_APPLY_ERROR.COMMIT_FAILED);
      }
      return committed;
    };

    /*
     * A retained pending intent is resolved by READ-BACK, never by a blind
     * re-import. Relationship state is small and fully observable through the
     * strict owner reads, so three cases are decidable: the page already
     * holds the target (converged -> commit without a write); the page still
     * holds the recorded pre-state (the earlier attempt provably wrote
     * nothing -> the same intent proceeds to one import); anything else is
     * an unresolved intent and blocks.
     */
    const pendingUntouched = stageVerdict === 'pending-existing' && !convergedNow &&
      (current.present ? current.payloadSha256 : null) ===
        (retainedPending?.canonicalPreStatePayloadSha256Hex ?? null);
    if ((stageVerdict === 'already-applied' || stageVerdict === 'pending-existing') && !pendingUntouched) {
      if (!convergedNow) {
        return refuse(P02_APPLY_VERDICT.BLOCKED,
          stageVerdict === 'pending-existing' ? P02_APPLY_ERROR.PENDING_UNRESOLVED : P02_APPLY_ERROR.READBACK_FAILED,
          { ...base, pending: stageVerdict === 'pending-existing' });
      }
      if (stageVerdict === 'already-applied') {
        return Object.freeze({ ...base, verdict: P02_APPLY_VERDICT.ALREADY_APPLIED, applied: false,
          canonicalMutated: false, reason: null, materialization: M.IDENTICAL,
          remaining: selection.remaining, outcome: P02_ATTEMPT_OUTCOME.NO_EFFECT,
          convergedDirection: C.DIRECTION_APPLIED });
      }
      try { await commit(); }
      catch (error) {
        return refuse(P02_APPLY_VERDICT.BLOCKED, clean(error?.code) || P02_APPLY_ERROR.COMMIT_FAILED, { ...base, pending: true });
      }
      return Object.freeze({ ...base, verdict: P02_APPLY_VERDICT.PENDING_RECOVERED, applied: true,
        canonicalMutated: false, recovered: true, reason: null, materialization: M.IDENTICAL,
        envelope, remaining: selection.remaining, isLeaf: selection.isLeaf === true,
        outcome: P02_ATTEMPT_OUTCOME.PROGRESS, convergedDirection: C.DIRECTION_APPLIED });
    }
    if (stageVerdict !== 'intent-staged' && !pendingUntouched) {
      return refuse(P02_APPLY_VERDICT.BLOCKED, P02_APPLY_ERROR.INTENT_STAGE_FAILED, base);
    }

    /* Precondition recheck against the strict source, after the durable intent. */
    let recheck;
    try { recheck = await pageState(objectDomain, objectId); }
    catch (error) {
      return refuse(P02_APPLY_VERDICT.BLOCKED, clean(error?.code) || E.SOURCE_UNAVAILABLE, { ...base, pending: true, blockReason: 'transport' });
    }
    if ((recheck.present ? recheck.payloadSha256 : null) !== preState) {
      return refuse(P02_APPLY_VERDICT.BLOCKED, P02_APPLY_ERROR.PRECONDITION_FAILED, { ...base, pending: true });
    }

    let ownerResult = null;
    let materialization = planned.materialization ?? M.NONE;
    let relationshipWrites = 0;
    if (planned.kind !== null) {
      try {
        ownerResult = await ownerWrite(planned.kind, planned.request);
      } catch (error) {
        const code = clean(error?.code) || E.WRITER_REFUSED;
        return refuse(code === E.WRITER_UNAVAILABLE ? P02_APPLY_VERDICT.BLOCKED : P02_APPLY_VERDICT.INTEGRITY,
          code, { ...base, kind: planned.kind, pending: true, detail: clean(error?.detail) || null,
            ...(code === E.WRITER_UNAVAILABLE ? { blockReason: 'permission' } : {}) });
      }
      relationshipWrites = Number(ownerResult.writesPerformed ?? 1) || 1;
      materialization = planned.kind === C.KIND.CREATE_FOLDER ? M.CREATED
        : planned.kind === C.KIND.RENAME_FOLDER ? M.RENAMED
          : planned.kind === C.KIND.BIND_CHAT ? M.BOUND : M.UNFILED;
    }

    /* Strict owner read-back: the page state must now be the admitted payload. */
    let after;
    try { after = await pageState(objectDomain, objectId); }
    catch (error) {
      return refuse(P02_APPLY_VERDICT.BLOCKED, clean(error?.code) || P02_APPLY_ERROR.READBACK_FAILED,
        { ...base, kind: planned.kind, pending: true, canonicalMutated: planned.kind !== null });
    }
    if (!after.present || after.payloadSha256 !== envelope.payloadSha256) {
      return refuse(P02_APPLY_VERDICT.INTEGRITY, E.READBACK_MISMATCH,
        { ...base, kind: planned.kind, pending: true, canonicalMutated: planned.kind !== null });
    }
    try { await commit(); }
    catch (error) {
      return refuse(P02_APPLY_VERDICT.BLOCKED, clean(error?.code) || P02_APPLY_ERROR.COMMIT_FAILED,
        { ...base, kind: planned.kind, pending: true, canonicalMutated: planned.kind !== null });
    }
    return Object.freeze({
      ...base, verdict: P02_APPLY_VERDICT.APPLIED, applied: true,
      canonicalMutated: planned.kind !== null, closure: false, reason: null,
      kind: planned.kind, materialization, relationshipWrites, ownerResult,
      envelope, remaining: selection.remaining, isLeaf: selection.isLeaf === true,
      outcome: P02_ATTEMPT_OUTCOME.PROGRESS, convergedDirection: C.DIRECTION_APPLIED
    });
  }

  function diagnose() {
    return Object.freeze({
      schema: C.SCHEMA,
      families: C.RELATIONSHIP_OBJECT_DOMAINS,
      writerAuthority: C.WRITER_AUTHORITY,
      writerCapabilities,
      nonChatReceive: C.NON_CHAT_RECEIVE,
      directionCoverage: C.DIRECTION_COVERAGE,
      archiveImport: 'never',
      nativeChatGptMutation: 'never'
    });
  }

  return Object.freeze({
    schema: C.SCHEMA,
    admissionFor,
    readAdmittedEvidence,
    anchorSetFor,
    protocolStateFor,
    describeScope,
    enumerateRemoteDescriptors,
    classifyRelationshipDescriptor,
    readDependencyState,
    applySelectedRelationshipRevision,
    diagnose
  });
}
