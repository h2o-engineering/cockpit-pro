/*
 * Minimal Desktop endpoint for Chrome -> Desktop P02.
 *
 * This module composes existing configured-peer storage, the shared v2 reader
 * and Receive core, Desktop branch admission, and the existing canonical
 * Desktop pull/import/proof/commit runtime. Receive and Apply are separate
 * trusted Human operations; importing the module starts neither.
 */
import { createP02ReceiveComposition }
  from '../core/sync-object-reconcile-v2.mjs';
import { classifyObjectState }
  from '../core/sync-object-classifier-v2.mjs';
import { createP02AnchorSet } from '../core/sync-p02-anchor-set-v2.mjs';
import { P02_ADMISSION_DISPOSITION } from '../core/sync-branch-evidence-v2.mjs';
import { evaluateFormatGate } from '../core/sync-format-gate-v2.mjs';
import { createLocalReaderTransportPrimitives }
  from '../browser-adapters/chrome/sync-reader-transport-v2.mjs';
import { objectKeyHex, writerKeyHex }
  from '../browser-adapters/chrome/sync-contract-v2.mjs';
import { createDesktopLocalWriterStorage }
  from './sync-writer-storage-desktop-v2.tauri.mjs';
import { createDesktopBranchEvidenceAdmission }
  from './sync-branch-evidence-desktop-v2.tauri.mjs';
import { createDesktopVerifiedTipMemo }
  from './sync-p02-tip-memo-desktop-v2.tauri.mjs';

export const P02_DESKTOP_REVERSE_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncDesktopReverse.p02.v1',
  CONFIG_RESULT_SCHEMA: 'h2o.studio.syncConfiguredPeerWriteResult.v1',
  RECEIVE_RESULT_SCHEMA: 'h2o.studio.syncDesktopP02ReceiveResult.v1',
  APPLY_RESULT_SCHEMA: 'h2o.studio.syncDesktopP02ApplyResult.v1',
  CHAT_OBJECT_DOMAIN: 'studio.chat.saved-state.v1',
  DB_URL: 'sqlite:studio-v1.db',
  /* The DEDICATED generation-authority reader. generation.json is not a J.1
   * generic-storage shape and must never be routed through one. */
  READ_GENERATION_AUTHORITY_COMMAND: 'h2o_p02_read_writer_generation_authority',
  GENERATION_AUTHORITY_SCHEMA: 'h2o.studio.syncWriterGenerationAuthority.p02.v1'
});

const HEX64 = /^[0-9a-f]{64}$/;
const clean = (value) => String(value == null ? '' : value).trim();
const strictId = (value) => typeof value === 'string' && value.length > 0 &&
  value.length <= 512 && value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value);
const fail = (code, detail = null) => {
  const error = new Error(code); error.code = code;
  /* RECEIVE_ERROR_OBSERVABILITY: a bounded predicate name only — never a
   * writer key, path, credential or raw configuration value. */
  if (detail) error.detail = String(detail);
  throw error;
};
const SYNC_MODE_OFF = 'off';
const SYNC_PEER_MODES = Object.freeze(['manual', 'notify', 'auto']);

function invokeFrom(scope) {
  if (typeof scope?.__TAURI_INTERNALS__?.invoke === 'function') {
    return scope.__TAURI_INTERNALS__.invoke.bind(scope.__TAURI_INTERNALS__);
  }
  if (typeof scope?.__TAURI__?.core?.invoke === 'function') {
    return scope.__TAURI__.core.invoke.bind(scope.__TAURI__.core);
  }
  if (typeof scope?.__TAURI__?.invoke === 'function') {
    return scope.__TAURI__.invoke.bind(scope.__TAURI__);
  }
  return null;
}

async function sha256HexText(value, cryptoImplementation) {
  const bytes = new TextEncoder().encode(value);
  const digest = await cryptoImplementation.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function configResult(outcome, extra = {}) {
  return Object.freeze({
    schema: P02_DESKTOP_REVERSE_V2.CONFIG_RESULT_SCHEMA,
    ok: outcome === 'configured' || outcome === 'already-configured',
    outcome, ...extra
  });
}

export function createDesktopP02ReverseRuntime({
  invoke,
  configOwner,
  localIdentity,
  canonicalApply,
  cryptoImplementation = globalThis.crypto,
  clock = () => new Date().toISOString()
} = {}) {
  if (typeof invoke !== 'function' ||
      typeof configOwner?.getConfig !== 'function' ||
      typeof configOwner?.setConfig !== 'function' ||
      typeof configOwner?.mutateCanonicalConfig !== 'function' ||
      typeof localIdentity !== 'function' ||
      typeof canonicalApply?.applyNextAdmittedP02Revision !== 'function' ||
      typeof cryptoImplementation?.subtle?.digest !== 'function') {
    fail('p02-desktop-reverse-dependency-invalid');
  }
  const sql = Object.freeze({
    select: (query, values = []) => invoke('plugin:sql|select', {
      db: P02_DESKTOP_REVERSE_V2.DB_URL, query, values
    }),
    execute: (query, values = []) => invoke('plugin:sql|execute', {
      db: P02_DESKTOP_REVERSE_V2.DB_URL, query, values
    })
  });
  const storage = createDesktopLocalWriterStorage({ invoke, capability: null });
  const reader = createLocalReaderTransportPrimitives({
    storage, cryptoImplementation
  });
  const tipMemo = createDesktopVerifiedTipMemo({ sql, clock: () => Date.now() });
  let configInFlight = false;
  let receiveInFlight = false;
  let applyInFlight = false;
  let applySelection = null;
  let lastReceive = null;
  let lastApply = null;

  async function localPeerId() {
    /* Any failure to RESOLVE the local identity - unavailable, malformed, or a
     * rejection from the identity owner - is one typed boundary, so callers can
     * report it as such instead of guessing. Validation is unchanged: the peer
     * id must still be a strict, non-empty identifier. */
    let value;
    try {
      value = await localIdentity();
    } catch (_) {
      fail('p02-desktop-local-identity-invalid');
    }
    const id = clean(value?.syncPeerId);
    if (!strictId(id)) fail('p02-desktop-local-identity-invalid');
    return id;
  }

  /* RECEIVE_ERROR_OBSERVABILITY: the outcome code is unchanged; each refusal
   * now names the failing predicate as a redacted `detail`.
   * MODE_VOCABULARY_ALIGNMENT: an explicit `off` mode is reported as its
   * own fail-closed outcome instead of masquerading as a peer defect. */
  const PEER_INVALID = 'p02-desktop-configured-chrome-peer-invalid';
  async function configuredChromePeer() {
    const config = await configOwner.getConfig();
    if (!config) fail(PEER_INVALID, 'config-absent');
    if (config.schemaVersion !== 1) fail(PEER_INVALID, 'config-schema-version');
    if (config.mode === SYNC_MODE_OFF) fail('sync-mode-off', 'config-mode-off');
    if (!SYNC_PEER_MODES.includes(config.mode)) fail(PEER_INVALID, 'config-mode-invalid');
    if (!Array.isArray(config.configuredPeers)) fail(PEER_INVALID, 'configured-peers-shape');
    if (config.configuredPeers.length !== 1) fail(PEER_INVALID,
      config.configuredPeers.length === 0 ? 'configured-peers-empty' : 'configured-peers-count');
    const peer = config.configuredPeers[0];
    if (!peer || Object.keys(peer).sort().join(',') !== 'syncPeerId,writerKey') {
      fail(PEER_INVALID, 'peer-shape');
    }
    if (!strictId(peer.syncPeerId)) fail(PEER_INVALID, 'peer-sync-peer-id');
    if (!HEX64.test(peer.writerKey || '')) fail(PEER_INVALID, 'peer-writer-key-format');
    if (peer.syncPeerId === await localPeerId()) fail(PEER_INVALID, 'peer-is-self');
    if (peer.writerKey !== await writerKeyHex(peer.syncPeerId, cryptoImplementation)) {
      fail(PEER_INVALID, 'peer-writer-key-mismatch');
    }
    return Object.freeze({ syncPeerId: peer.syncPeerId, writerKey: peer.writerKey });
  }

  async function configureChromePeer({ syncPeerId, writerKey } = {}) {
    if (configInFlight) return configResult('busy');
    configInFlight = true;
    try {
      if (!strictId(syncPeerId)) return configResult('invalid-peer');
      if (!HEX64.test(writerKey || '')) return configResult('invalid-writer-key');
      if (syncPeerId === await localPeerId()) return configResult('self-peer');
      if (writerKey !== await writerKeyHex(syncPeerId, cryptoImplementation)) {
        return configResult('writer-key-mismatch');
      }
      const mutation = await configOwner.mutateCanonicalConfig(async (before) => {
        if (before && before.schemaVersion === 1 && before.mode === SYNC_MODE_OFF) {
          return { write: false, outcome: 'sync-mode-off' };
        }
        if (!before || before.schemaVersion !== 1 ||
            !SYNC_PEER_MODES.includes(before.mode) ||
            !Array.isArray(before.configuredPeers)) {
          return { write: false, outcome: 'authority-unavailable' };
        }
        if (before.configuredPeers.length > 0) {
          const same = before.configuredPeers.length === 1 &&
            before.configuredPeers[0]?.syncPeerId === syncPeerId &&
            before.configuredPeers[0]?.writerKey === writerKey;
          return { write: false,
            outcome: same ? 'already-configured' : 'authority-conflict' };
        }
        /* Repeat identity authority inside the shared decision boundary so a
         * queued action never relies on pre-boundary trust state. */
        if (syncPeerId === await localPeerId() ||
            writerKey !== await writerKeyHex(syncPeerId, cryptoImplementation)) {
          return { write: false, outcome: 'authority-conflict' };
        }
        return { write: true, outcome: 'configured',
          patch: { configuredPeers: [{ syncPeerId, writerKey }] } };
      });
      return configResult(mutation?.outcome || 'persistence-failed',
        mutation?.outcome === 'configured' ? { syncPeerId, writerKey } : {});
    } catch (error) {
      const code = error?.code;
      /* A local-identity resolution failure is not a persistence failure. The
       * panel already speaks this outcome; collapsing it into persistence-failed
       * is what made a pure identity defect look like a failed config write.
       * Only the typed identity boundary maps here - nothing else. */
      if (code === 'p02-desktop-local-identity-invalid') {
        return configResult('local-identity-unavailable');
      }
      /* The CAS read-back is raised by the canonical storage layer as
       * canonical-storage-cas-readback-mismatch; the other config owner raises
       * canonical-sync-config-readback-mismatch. Either is the same condition
       * for this caller, and neither taxonomy is renamed. */
      return configResult(
        code === 'canonical-storage-cas-readback-mismatch' ||
        code === 'canonical-sync-config-readback-mismatch'
          ? 'readback-mismatch' : 'persistence-failed'
      );
    } finally { configInFlight = false; }
  }

  async function libraryInfo() {
    const observed = await invoke('h2o_p02_read_library_authority', {});
    if (observed?.present !== true || observed?.readable !== true ||
        typeof observed.canonicalBytes !== 'string') {
      fail('p02-desktop-library-authority-invalid');
    }
    let value;
    try { value = JSON.parse(observed.canonicalBytes); }
    catch (_) { fail('p02-desktop-library-authority-invalid'); }
    const gate = evaluateFormatGate({ libraryInfo: value, repositoryHasContent: true });
    if (gate.mayRead !== true) fail('p02-desktop-library-authority-invalid');
    return value;
  }

  /*
   * The peer's generation record, read through its DEDICATED authority command.
   *
   * It must NOT go through the generic storage reader: the frozen J.1 path
   * whitelist admits only state.json and its pending form, so
   * writers/<writerKey>/generation.json was rejected outright - before Receive
   * could compose anything - and the untyped refusal collapsed to a bare
   * `receive-failed`. Routing the document type at its own reader fixes that
   * without touching the J.1 contract.
   *
   * The acceptance set is exactly what the generic-reader path enforced.
   * `state === 'p02'` is the reader's verdict over the same two constants this
   * function used to assert itself (schema h2o.studio.syncWriterGeneration.p02.v1
   * and generation p02), and `documentWriterKey` is what the RECORD declares
   * about itself. The response's own `writerKey` is only the echoed request
   * argument, so it is evidence about the caller and never about the document -
   * comparing it here would assert nothing.
   *
   * documentWriterKey is compared STRICTLY. The generic-reader path this
   * replaced tested the parsed document's field with ===, so a declaration of
   * " <key> " was a mismatch and refused. Normalising it here - trimming, or
   * lowercasing - would admit records the parent rejected, which is an
   * acceptance-set widening however cosmetic the difference looks. A writer key
   * is a 64-character lowercase hex identity, not free text: the record either
   * declares exactly the configured writer or it does not.
   */
  async function requirePeerGeneration(peer) {
    let authority;
    try {
      authority = await invoke(
        P02_DESKTOP_REVERSE_V2.READ_GENERATION_AUTHORITY_COMMAND,
        { writerKey: peer.writerKey });
    } catch (_) {
      fail('p02-desktop-peer-generation-invalid');
    }
    if (clean(authority?.schema) !== P02_DESKTOP_REVERSE_V2.GENERATION_AUTHORITY_SCHEMA ||
        clean(authority?.state) !== 'p02' ||
        authority?.documentWriterKey !== peer.writerKey) {
      fail('p02-desktop-peer-generation-invalid');
    }
    return authority;
  }

  const peerObjectKeyFor = (writerSyncPeerId, objectKey) =>
    sha256HexText(`${writerSyncPeerId}\u0000${objectKey}`, cryptoImplementation);
  const branchAdmission = createDesktopBranchEvidenceAdmission({
    sql, clock, peerObjectKeyFor
  });

  async function protocolState(objectId) {
    const rows = await sql.select(
      'SELECT last_published_revision_id, last_published_revision_blob_sha256, '
      + 'last_published_payload_sha256, last_applied_revision_id, '
      + 'last_applied_revision_blob_sha256, last_applied_payload_sha256, '
      + 'last_converged_direction FROM sync_object_state '
      + 'WHERE sync_peer_id = ? AND object_id = ? LIMIT 1',
      [await localPeerId(), objectId]);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return {};
    return {
      convergedDirection: clean(row.last_converged_direction) || null,
      lastPublished: clean(row.last_published_revision_id) ? {
        revisionId: clean(row.last_published_revision_id),
        revisionBlobSha256: clean(row.last_published_revision_blob_sha256),
        payloadSha256: clean(row.last_published_payload_sha256)
      } : null,
      lastApplied: clean(row.last_applied_revision_id) ? {
        revisionId: clean(row.last_applied_revision_id),
        revisionBlobSha256: clean(row.last_applied_revision_blob_sha256),
        payloadSha256: clean(row.last_applied_payload_sha256)
      } : null
    };
  }

  async function buildReceive(peer, authority) {
    return createP02ReceiveComposition({
      configuredPeers: async () => [peer],
      readWriterState: () => reader.readWriterState({ writerSyncPeerId: peer.syncPeerId }),
      readRevisionBytes: (input) => reader.readRevision(input),
      fetchAncestry: (input) => reader.fetchAncestry(input),
      readAdmittedEvidence: async ({ objectKey }) => {
        const rows = await branchAdmission.retainedFor({
          writerSyncPeerId: peer.syncPeerId, objectKey
        });
        return rows.map((row) => ({
          revisionId: row.document.revisionId,
          revisionBlobSha256: row.revisionBlobSha256,
          disposition: row.disposition
        }));
      },
      admitRevision: async (input) => branchAdmission.admitRevision({
        objectId: input.objectId,
        objectKey: input.objectKey,
        writerSyncPeerId: peer.syncPeerId,
        revision: input.revision,
        revisionBlobSha256: input.revisionBlobSha256,
        revisionBytes: input.revisionBlobBytes?.byteLength ?? 0,
        protocolState: input.protocolState,
        libraryInfo: authority,
        repositoryHasContent: true,
        legacyBaselineMatches: true
      }),
      /* Keep graph semantics in the canonical classifier. This adapter only
       * supplies Desktop evidence and its canonical v1 projection anchor. */
      classifyObject: async (input) => {
        const retained = await branchAdmission.retainedFor({
          writerSyncPeerId: peer.syncPeerId, objectKey: input.objectKey
        });
        let canonicalLocalHead = null;
        try {
          const canonical = await canonicalApply.resolveCanonicalAnchor(
            input.objectId);
          if (canonical?.revisionId && canonical?.revisionBlobSha256Hex) {
            canonicalLocalHead = {
              revisionId: canonical.revisionId,
              revisionBlobSha256: canonical.revisionBlobSha256Hex,
              ...(canonical.payloadSha256Hex
                ? { payloadSha256: canonical.payloadSha256Hex } : {}),
              deleted: false
            };
          }
        } catch (_) { /* Absent canonical content is a valid remote-first case. */ }
        return classifyObjectState({
          canonicalLocalHead,
          p02AnchorSet: input.p02AnchorSet,
          protocolState: input.protocolState,
          retainedEvidence: retained.map((record) => ({
            ...record,
            validated: record.disposition ===
              P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR ||
              record.disposition === P02_ADMISSION_DISPOSITION.ADMITTED_CLOSURE
          })),
          advertisedTips: input.advertisedTips,
          dirty: false,
          publishable: false,
          pending: false,
          integrityQuarantined: retained.some((record) =>
            record.disposition === P02_ADMISSION_DISPOSITION.QUARANTINED)
        });
      },
      anchorSetFor: async ({ objectId }) => createP02AnchorSet({
        objectDomain: P02_DESKTOP_REVERSE_V2.CHAT_OBJECT_DOMAIN,
        objectId,
        protocolState: await protocolState(objectId)
      }),
      readTipMemo: (input) => tipMemo.read(input),
      writeTipMemo: (input) => tipMemo.record(input),
      applyAuthority: null,
      protocolStateFor: ({ objectId }) => protocolState(objectId)
    });
  }

  /* DESKTOP_APPLY_CANDIDATE_REPORTING: the operator-facing candidate count is
   * the proven accepted-linear Desktop leaf authority - the same selection
   * Apply itself uses - not the core handoff's eligibility list. */
  async function provenApplyCandidates(peer) {
    try {
      const selected = await selectedAdmittedLeaf(peer);
      return Object.freeze([Object.freeze({
        objectId: selected.row.object_id,
        revisionId: selected.row.revision_id,
        revisionBlobSha256Hex: selected.row.revision_blob_sha256_hex,
        branchDisposition: 'accepted-linear',
        proven: true
      })]);
    } catch (error) {
      const code = clean(error?.code);
      if (code === 'p02-desktop-no-admitted-chrome-leaf' ||
          code === 'p02-desktop-ambiguous-admitted-chrome-leaf' ||
          code === 'p02-desktop-chrome-writer-state-invalid') return Object.freeze([]);
      throw error;
    }
  }

  async function receiveFromChrome() {
    if (receiveInFlight || applyInFlight) return Object.freeze({
      schema: P02_DESKTOP_REVERSE_V2.RECEIVE_RESULT_SCHEMA,
      ok: false, outcome: 'busy'
    });
    receiveInFlight = true;
    try {
      const peer = await configuredChromePeer();
      await requirePeerGeneration(peer);
      const authority = await libraryInfo();
      const report = await (await buildReceive(peer, authority)).receivePass({
        objectDomain: P02_DESKTOP_REVERSE_V2.CHAT_OBJECT_DOMAIN
      });
      const integrity = report.objects?.some((item) => item.result?.outcome === 'integrity');
      const blocked = report.globalFailure ||
        report.objects?.some((item) => ['blocked', 'indeterminate', 'transient']
          .includes(item.result?.outcome));
      const applyCandidates = await provenApplyCandidates(peer);
      const outcome = integrity ? 'integrity' : blocked ? 'blocked' : 'completed';
      lastReceive = Object.freeze({ outcome, detail: null });
      return Object.freeze({
        schema: P02_DESKTOP_REVERSE_V2.RECEIVE_RESULT_SCHEMA,
        ok: !integrity && !blocked,
        outcome,
        detail: null,
        peerSyncPeerId: peer.syncPeerId,
        admittedCount: (report.objects || []).filter((item) =>
          item.result?.outcome === 'progress').length,
        report: Object.freeze({ ...report, applyCandidates }),
        applyExecuted: false,
        webdavReachable: false
      });
    } catch (error) {
      const outcome = clean(error?.code) || 'receive-failed';
      const detail = clean(error?.detail) || null;
      lastReceive = Object.freeze({ outcome, detail });
      return Object.freeze({
        schema: P02_DESKTOP_REVERSE_V2.RECEIVE_RESULT_SCHEMA,
        ok: false, outcome, detail,
        applyExecuted: false, webdavReachable: false
      });
    } finally { receiveInFlight = false; }
  }

  async function selectedAdmittedLeaf(peer, objectId = null) {
    const values = [];
    let where = "WHERE branch_disposition = 'accepted-linear' AND proven = 1";
    if (objectId) { where += ' AND object_id = ?'; values.push(objectId); }
    const rows = await sql.select(
      'SELECT object_id, revision_id, revision_blob_sha256_hex, '
      + 'parent_revision_id, parent_revision_blob_sha256_hex, peer_object_key '
      + `FROM sync_branch_evidence_state ${where} ORDER BY object_id, revision_id`, values);
    const state = await reader.readWriterState({ writerSyncPeerId: peer.syncPeerId });
    if (state?.status !== 'verified') fail('p02-desktop-chrome-writer-state-invalid');
    const candidates = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const objectKey = await objectKeyHex(
        P02_DESKTOP_REVERSE_V2.CHAT_OBJECT_DOMAIN,
        row.object_id,
        cryptoImplementation);
      const expectedPeerObjectKey = await peerObjectKeyFor(
        peer.syncPeerId, objectKey);
      if (row.peer_object_key !== expectedPeerObjectKey) continue;
      const head = (state.snapshot?.heads || []).find((tip) =>
        tip.objectId === row.object_id && tip.objectKey === objectKey &&
        tip.writerSyncPeerId === peer.syncPeerId &&
        tip.revisionId === row.revision_id &&
        tip.revisionBlobSha256 === row.revision_blob_sha256_hex);
      if (head) candidates.push({ row, head });
    }
    if (candidates.length !== 1) fail(candidates.length === 0
      ? 'p02-desktop-no-admitted-chrome-leaf'
      : 'p02-desktop-ambiguous-admitted-chrome-leaf');
    return candidates[0];
  }

  async function readP02Candidate(request) {
    const peer = await configuredChromePeer();
    await requirePeerGeneration(peer);
    const selected = await selectedAdmittedLeaf(peer, request?.objectId);
    const objectKey = await objectKeyHex(
      P02_DESKTOP_REVERSE_V2.CHAT_OBJECT_DOMAIN,
      selected.row.object_id,
      cryptoImplementation);
    if (request?.objectKeyHex !== objectKey) fail('p02-desktop-object-key-mismatch');
    const revision = await reader.readRevision({
      objectDomain: P02_DESKTOP_REVERSE_V2.CHAT_OBJECT_DOMAIN,
      objectId: selected.row.object_id,
      objectKey,
      revisionBlobSha256: selected.row.revision_blob_sha256_hex
    });
    if (revision?.status !== 'verified' ||
        revision.value?.writerSyncPeerId !== peer.syncPeerId ||
        revision.value?.revisionId !== selected.row.revision_id) {
      fail('p02-desktop-admitted-revision-invalid');
    }
    return Object.freeze({
      ok: true,
      verdict: 'p02-local-admission-verified',
      headPresent: true,
      head: selected.head,
      headCanonicalText: null,
      headStrongEtag: null,
      revisionBlobText: new TextDecoder().decode(revision.bytes),
      revisionValue: revision.value,
      sourceKind: 'p02-admitted-local',
      sourceStrongVersion:
        `local-p02:revision-sha256:${selected.row.revision_blob_sha256_hex}`,
      sourceVerified: true,
      transportVerified: true
    });
  }

  async function applyAdmittedFromChrome() {
    if (applyInFlight || receiveInFlight) return Object.freeze({
      schema: P02_DESKTOP_REVERSE_V2.APPLY_RESULT_SCHEMA,
      ok: false, outcome: 'busy'
    });
    applyInFlight = true;
    try {
      const peer = await configuredChromePeer();
      await requirePeerGeneration(peer);
      const selected = await selectedAdmittedLeaf(peer);
      applySelection = selected;
      const result = await canonicalApply.applyNextAdmittedP02Revision(
        selected.row.object_id);
      const ok = result?.ok === true && result?.convergenceVerified === true;
      lastApply = Object.freeze({
        outcome: ok ? (result.unchangedNoOp ? 'already-applied' : 'applied') : (clean(result?.errorCode) || 'apply-failed'),
        detail: null
      });
      return Object.freeze({
        schema: P02_DESKTOP_REVERSE_V2.APPLY_RESULT_SCHEMA,
        ok,
        outcome: ok
          ? (result.unchangedNoOp ? 'already-applied' : 'applied')
          : clean(result?.errorCode) || 'apply-failed',
        objectId: selected.row.object_id,
        revisionId: selected.row.revision_id,
        /* APPLY_RESULT_REPORTING: attempts count importer invocations, never
         * successes; importerInvoked is the runtime's own truthful flag. */
        canonicalImportAttempts: result?.importerInvoked === true ? 1 : 0,
        importerInvoked: result?.importerInvoked === true,
        convergedDirection: ok ? 'applied' : null,
        result,
        publicationReachable: false,
        repositoryWrites: 0,
        webdavReachable: false
      });
    } catch (error) {
      const invoked = error?.importerInvoked === true;
      lastApply = Object.freeze({ outcome: clean(error?.code) || 'apply-failed', detail: clean(error?.detail) || null });
      return Object.freeze({
        schema: P02_DESKTOP_REVERSE_V2.APPLY_RESULT_SCHEMA,
        ok: false, outcome: clean(error?.code) || 'apply-failed',
        detail: clean(error?.detail) || null,
        canonicalImportAttempts: invoked ? 1 : 0,
        importerInvoked: invoked,
        publicationReachable: false, repositoryWrites: 0,
        webdavReachable: false
      });
    } finally { applySelection = null; applyInFlight = false; }
  }

  const localSource = Object.freeze({
    schema: 'h2o.studio.syncObjectP02LocalSource.v1',
    sourceKind: 'p02-admitted-local',
    readCandidate: readP02Candidate
  });

  return Object.freeze({
    schema: P02_DESKTOP_REVERSE_V2.SCHEMA,
    configureChromePeer,
    receiveFromChrome,
    applyAdmittedFromChrome,
    localSource,
    diagnose: () => Object.freeze({
      configInFlight, receiveInFlight, applyInFlight,
      lastReceive, lastApply,
      receiveAutonomous: false, applyAutonomous: false,
      p01RouteUsed: false, webdavReachable: false
    })
  });
}

export function installDesktopP02Reverse(globalScope = globalThis) {
  const scope = globalScope || {};
  /* Packaged on both Studio surfaces, activated only by the native invoke
   * authority. Chrome must not grow a Desktop Receive/Apply facade. */
  if (!invokeFrom(scope)) return null;
  const H2O = scope.H2O = scope.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.sync = H2O.Studio.sync || {};
  H2O.Desktop = H2O.Desktop || {};
  if (H2O.Studio.sync.p02Reverse) return H2O.Studio.sync.p02Reverse;
  let runtime = null;
  function current() {
    if (runtime) return runtime;
    const invoke = invokeFrom(scope);
    const sync = H2O.Studio.sync;
    const canonicalApply = H2O.Desktop.SyncObjectRuntime;
    if (!invoke || typeof sync.getConfig !== 'function' ||
        typeof sync.setConfig !== 'function' ||
        typeof sync.mutateCanonicalConfig !== 'function' ||
        typeof canonicalApply?.applyNextAdmittedP02Revision !== 'function') {
      fail('p02-desktop-reverse-runtime-unavailable');
    }
    runtime = createDesktopP02ReverseRuntime({
      invoke,
      configOwner: sync,
      localIdentity: async () => {
        const identity = H2O.Studio.identity;
        /*
         * whenSyncReady() is documented, and implemented, as the CHROME sync
         * readiness boundary: it hard-requires studio-chrome / mv3-chrome /
         * idb-archive and throws identity-classification-unsupported for
         * anything else. This runtime IS the Desktop side, so asking that
         * question rejected the Desktop's own perfectly valid
         * studio-desktop / tauri-desktop / sqlite identity - before any config
         * mutation was even attempted, which is why a failed Configure left the
         * canonical config byte-identical and reported persistence-failed.
         *
         * whenReady() is the classification-neutral canonical read: it awaits
         * the same init(), returns the validated identity, and imposes no
         * surface class. get() remains only a synchronous fallback, because it
         * is documented to return null until whenReady resolves. Chrome
         * identity semantics are untouched - nothing here changes what
         * whenSyncReady() means for the Chrome surface.
         */
        if (typeof identity?.whenReady === 'function') return identity.whenReady();
        if (typeof identity?.get === 'function') return identity.get();
        fail('p02-desktop-local-identity-invalid');
      },
      canonicalApply
    });
    H2O.Desktop.SyncObjectP02LocalSource = runtime.localSource;
    return runtime;
  }
  const api = Object.freeze({
    schema: P02_DESKTOP_REVERSE_V2.SCHEMA,
    configureChromePeer: (input) => current().configureChromePeer(input),
    receiveFromChrome: () => current().receiveFromChrome(),
    applyAdmittedFromChrome: () => current().applyAdmittedFromChrome(),
    diagnose: () => runtime
      ? runtime.diagnose()
      : Object.freeze({ installed: true, initialized: false,
        receiveAutonomous: false, applyAutonomous: false, webdavReachable: false })
  });
  H2O.Studio.sync.p02Reverse = api;
  return api;
}

installDesktopP02Reverse();
