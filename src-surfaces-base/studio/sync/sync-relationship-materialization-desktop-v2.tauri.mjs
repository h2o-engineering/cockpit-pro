/*
 * P02 folder-relationship synchronization (T03) - Desktop relationship
 * dependency reader and materializer.
 *
 * WHAT THIS MODULE IS. The Sync-side adapter that turns an ADMITTED, VERIFIED
 * relationship revision (studio.folder.v1 / studio.chat-folder-binding.v1)
 * into one invocation of the ratified fixed-statement Tauri command
 * `h2o_p02_relationship_apply`, records the relationship-domain protocol
 * bookkeeping that L-PLATFORM-SYNC owns, and asks the Library to refresh its
 * read model through the Library's own canonical refresh port.
 *
 * WHAT THIS MODULE IS NOT. It is not a Folder authority (STAB-02): it decides
 * nothing about what a folder command means. It never writes `folders` or
 * `folder_bindings` - every relationship write goes through the one command,
 * which owns the writer identity `p02.relationship-apply`. It sends no SQL
 * text for those tables, invokes no generic authorized SQL, and never reaches
 * the chat importer, the chat metadata self-heal, any provider core, or the
 * legacy folder-sync paths. Its own SQL is limited to fixed read statements
 * (dependency and identity reads) and the domain-qualified Sync bookkeeping
 * row that the writer-authority contract §6 assigns to Sync.
 *
 * DEPENDENCY BLOCKING. A binding whose chat or folder does not exist locally
 * is `blocked(dependency)` with a typed detail (`chat-missing` /
 * `folder-missing`). Nothing is materialized, no placeholder is created and
 * nothing is unfiled: the missing-folder case can never be routed into a
 * provider path that "succeeds" by clearing folder membership. The reader is
 * consulted at classification time (through the classifier's blockReason
 * seam) and AGAIN immediately before the command is invoked, so a dependency
 * that vanished between classify and Apply fails closed with the same typed
 * outcome.
 *
 * REPLAY. An exactly applied revision (id, blob and payload identity all
 * recorded as applied for this domain-qualified row) is `already-applied`:
 * the command is not invoked, no relationship row is written, no bookkeeping
 * row is written and the repository is never touched.
 *
 * DELETE BOUNDARY. There is no folder deletion materializer here: the fixed
 * command has no such statement and this module composes none. A folder
 * revision for a folder that exists locally under a non-user source is
 * refused as not eligible, never adopted or replaced.
 */
import {
  P02_RELATIONSHIP_DOMAINS_V2,
  isRelationshipObjectDomain,
  relationshipDomainDescriptor,
  validateRelationshipPayload
} from '../core/sync-relationship-domains-v2.mjs';

const FOLDER_DOMAIN = P02_RELATIONSHIP_DOMAINS_V2.FOLDER.OBJECT_DOMAIN;
const BINDING_DOMAIN = P02_RELATIONSHIP_DOMAINS_V2.BINDING.OBJECT_DOMAIN;

export const P02_DESKTOP_RELATIONSHIP_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncDesktopRelationshipMaterialization.p02.v1',
  RESULT_SCHEMA: 'h2o.studio.syncDesktopRelationshipApplyResult.p02.v1',
  DEPENDENCY_SCHEMA: 'h2o.studio.syncDesktopRelationshipDependency.p02.v1',
  FOLDER_OBJECT_DOMAIN: FOLDER_DOMAIN,
  BINDING_OBJECT_DOMAIN: BINDING_DOMAIN,
  /* The ONE ratified Host Integration adapter. Nothing else materializes. */
  COMMAND: 'h2o_p02_relationship_apply',
  COMMAND_REQUEST_SCHEMA: 'h2o.studio.p02RelationshipApplyRequest.v1',
  COMMAND_RESULT_SCHEMA: 'h2o.studio.p02RelationshipApplyResult.v1',
  KIND: Object.freeze({
    CREATE_FOLDER: 'create-folder',
    RENAME_FOLDER: 'rename-folder',
    BIND_CHAT: 'bind-chat',
    UNBIND_CHAT: 'unbind-chat'
  }),
  /* The scheduler-visible class is exactly blocked(dependency). */
  BLOCK_REASON: 'dependency',
  DEPENDENCY_DETAIL: Object.freeze({
    FOLDER_MISSING: 'folder-missing',
    CHAT_MISSING: 'chat-missing'
  }),
  FOLDER_SOURCE_USER: 'user',
  CONVERGED_DIRECTION_APPLIED: 'applied',
  /*
   * The Library-owned canonical refresh port for a Desktop SQLite folder or
   * binding write (R4.4 Folders Actions contract): the Library Index listens
   * for explicit refresh requests from other modules on this event and
   * re-reads the entity stores itself; the Workspace and the sidebar follow
   * its own `updated` fan-out. Sync dispatches exactly this event and touches
   * no Library state, no UI and no other event.
   */
  LIBRARY_REFRESH_EVENT: 'evt:h2o:library-index:refresh-request',
  LIBRARY_REFRESH_REASON_PREFIX: 'p02-relationship-apply'
});

export const P02_DESKTOP_RELATIONSHIP_OUTCOME = Object.freeze({
  APPLIED: 'applied',
  ALREADY_APPLIED: 'already-applied',
  BLOCKED: 'blocked(dependency)',
  REFUSED: 'refused',
  INTEGRITY: 'integrity'
});

export const P02_DESKTOP_RELATIONSHIP_MATERIALIZATION = Object.freeze({
  CREATED: 'created',
  RENAMED: 'renamed',
  BOUND: 'bound',
  UNFILED: 'unfiled',
  ALREADY_UNFILED: 'already-unfiled',
  IDENTICAL: 'identical',
  NONE: 'none'
});

export const P02_DESKTOP_RELATIONSHIP_ERROR = Object.freeze({
  DEPENDENCY_INVALID: 'p02-desktop-relationship-dependency-invalid',
  DOMAIN_UNSUPPORTED: 'p02-desktop-relationship-domain-unsupported',
  LEAF_INVALID: 'p02-desktop-relationship-leaf-invalid',
  REVISION_INVALID: 'p02-desktop-relationship-revision-invalid',
  COMMAND_RESULT_INVALID: 'p02-desktop-relationship-command-result-invalid',
  COMMAND_UNAVAILABLE: 'p02-desktop-relationship-command-unavailable'
});

/*
 * Fixed read statements. They resolve identity only (no mutation) and every
 * sync_object_state access is domain-qualified (v23).
 */
export const P02_DESKTOP_RELATIONSHIP_READ_QUERIES = Object.freeze({
  CHAT: 'SELECT is_deleted FROM chats WHERE id = ? LIMIT 1',
  FOLDER: 'SELECT id, name, source FROM folders WHERE id = ? LIMIT 1',
  BINDING: 'SELECT folder_id FROM folder_bindings WHERE chat_id = ? LIMIT 1',
  PROTOCOL: 'SELECT last_applied_revision_id, last_applied_revision_blob_sha256, '
    + 'last_applied_payload_sha256, last_converged_direction '
    + 'FROM sync_object_state '
    + 'WHERE sync_peer_id = ? AND object_domain = ? AND object_id = ? LIMIT 1'
});

/*
 * The Sync-owned bookkeeping row (writer-authority contract §6: relationship
 * domains only). It is written AFTER the command committed its own bounded
 * transaction; a crash between the two leaves the row un-anchored and the
 * next Apply re-plans against local state (identical -> no relationship
 * write, bookkeeping only), so the pair is idempotent by construction.
 */
export const P02_DESKTOP_RELATIONSHIP_BOOKKEEPING_UPSERT =
  'INSERT INTO sync_object_state (sync_peer_id, object_domain, object_id, '
  + 'last_applied_revision_id, last_applied_revision_blob_sha256, '
  + 'last_applied_payload_sha256, last_converged_direction, '
  + 'consumed_revision_blob_sha256, convergence_watermark_sha256, '
  + 'last_conflict_class, last_error_code, created_at, updated_at) '
  + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?) '
  + 'ON CONFLICT(sync_peer_id, object_domain, object_id) DO UPDATE SET '
  + 'last_applied_revision_id = excluded.last_applied_revision_id, '
  + 'last_applied_revision_blob_sha256 = excluded.last_applied_revision_blob_sha256, '
  + 'last_applied_payload_sha256 = excluded.last_applied_payload_sha256, '
  + 'last_converged_direction = excluded.last_converged_direction, '
  + 'consumed_revision_blob_sha256 = excluded.consumed_revision_blob_sha256, '
  + 'convergence_watermark_sha256 = excluded.convergence_watermark_sha256, '
  + 'last_conflict_class = NULL, last_error_code = NULL, '
  + 'updated_at = excluded.updated_at';

const HEX64 = /^[0-9a-f]{64}$/;
const clean = (value) => String(value == null ? '' : value).trim();
const hex64 = (value) => typeof value === 'string' && HEX64.test(value);
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const rows = (value) => (Array.isArray(value) ? value : []);

function fail(code, detail = null) {
  const error = new Error(code);
  error.code = code;
  if (detail !== null && detail !== undefined) error.detail = String(detail);
  throw error;
}

function requireRelationshipDomain(objectDomain) {
  if (!isRelationshipObjectDomain(objectDomain)) {
    fail(P02_DESKTOP_RELATIONSHIP_ERROR.DOMAIN_UNSUPPORTED, objectDomain);
  }
  return objectDomain;
}

/*
 * Dependency reader. Pure reads over the canonical tables; it is the
 * `blockStateReader`-shaped seam the Desktop reverse composition consults at
 * classification time and the materializer consults again at Apply time.
 *
 *   folder revision   -> no dependency (a folder materializes on its own).
 *   binding revision  -> the chat must exist and be live; when folderId is
 *                        not null the folder must exist as a live USER folder
 *                        (a row under another source is not a materialized
 *                        target for this binding and is reported as
 *                        folder-missing with the observed source beside it).
 */
export function createDesktopRelationshipDependencyReader({ sql } = {}) {
  if (!isPlainObject(sql) || typeof sql.select !== 'function') {
    fail(P02_DESKTOP_RELATIONSHIP_ERROR.DEPENDENCY_INVALID);
  }
  const { DEPENDENCY_DETAIL, BLOCK_REASON, FOLDER_SOURCE_USER } = P02_DESKTOP_RELATIONSHIP_V2;
  const ready = (extra = {}) => Object.freeze({
    schema: P02_DESKTOP_RELATIONSHIP_V2.DEPENDENCY_SCHEMA,
    ready: true, blockReason: null, detail: null, ...extra
  });
  const blocked = (detail, extra = {}) => Object.freeze({
    schema: P02_DESKTOP_RELATIONSHIP_V2.DEPENDENCY_SCHEMA,
    ready: false, blockReason: BLOCK_REASON, detail, ...extra
  });

  async function readLiveChat(chatId) {
    const row = rows(await sql.select(P02_DESKTOP_RELATIONSHIP_READ_QUERIES.CHAT, [chatId]))[0];
    if (!row) return null;
    return Number(row.is_deleted) === 0 ? row : null;
  }

  async function readFolder(folderId) {
    return rows(await sql.select(P02_DESKTOP_RELATIONSHIP_READ_QUERIES.FOLDER, [folderId]))[0] || null;
  }

  async function readDependencyState({ objectDomain, objectId, canonical } = {}) {
    requireRelationshipDomain(objectDomain);
    if (!isPlainObject(canonical) || canonical.objectId !== objectId) {
      fail(P02_DESKTOP_RELATIONSHIP_ERROR.REVISION_INVALID, 'canonical-object-mismatch');
    }
    if (objectDomain === FOLDER_DOMAIN) {
      return ready({ requires: Object.freeze([]) });
    }
    const chat = await readLiveChat(canonical.chatId);
    if (!chat) return blocked(DEPENDENCY_DETAIL.CHAT_MISSING, { chatId: canonical.chatId });
    if (canonical.folderId === null) {
      return ready({ requires: Object.freeze(['chat']), chatId: canonical.chatId });
    }
    const folder = await readFolder(canonical.folderId);
    if (!folder) {
      return blocked(DEPENDENCY_DETAIL.FOLDER_MISSING, {
        chatId: canonical.chatId, folderId: canonical.folderId, folderSource: null
      });
    }
    if (clean(folder.source) !== FOLDER_SOURCE_USER) {
      return blocked(DEPENDENCY_DETAIL.FOLDER_MISSING, {
        chatId: canonical.chatId, folderId: canonical.folderId,
        folderSource: clean(folder.source) || null
      });
    }
    return ready({
      requires: Object.freeze(['chat', 'folder']),
      chatId: canonical.chatId, folderId: canonical.folderId
    });
  }

  return Object.freeze({
    schema: P02_DESKTOP_RELATIONSHIP_V2.DEPENDENCY_SCHEMA,
    readDependencyState,
    /* Read-only helpers shared with the materializer's planning step. */
    readFolder,
    readLiveChat
  });
}

/* The verified revision must be the exact admitted leaf, or it is nothing. */
function requireAdmittedRevision({ objectDomain, objectId, leaf, revision }) {
  if (!isPlainObject(leaf) || !clean(leaf.revisionId) || !hex64(leaf.revisionBlobSha256) ||
      !hex64(leaf.payloadSha256)) {
    fail(P02_DESKTOP_RELATIONSHIP_ERROR.LEAF_INVALID);
  }
  if (!isPlainObject(revision) || !isPlainObject(revision.payload) ||
      revision.objectDomain !== objectDomain || revision.objectId !== objectId ||
      revision.revisionId !== leaf.revisionId ||
      revision.payloadSha256 !== leaf.payloadSha256) {
    fail(P02_DESKTOP_RELATIONSHIP_ERROR.REVISION_INVALID);
  }
}

/*
 * The materializer. `invoke` is the injected Tauri invoke authority; the only
 * command this module ever names is the ratified relationship adapter.
 */
export function createDesktopRelationshipMaterializer({
  invoke,
  sql,
  localPeerId,
  dependencyReader = null,
  libraryRefresh = null,
  clock = () => new Date().toISOString()
} = {}) {
  if (typeof invoke !== 'function' || !isPlainObject(sql) ||
      typeof sql.select !== 'function' || typeof sql.execute !== 'function' ||
      typeof localPeerId !== 'function') {
    fail(P02_DESKTOP_RELATIONSHIP_ERROR.DEPENDENCY_INVALID);
  }
  if (libraryRefresh !== null && typeof libraryRefresh !== 'function') {
    fail(P02_DESKTOP_RELATIONSHIP_ERROR.DEPENDENCY_INVALID, 'library-refresh-port');
  }
  const dependencies = dependencyReader || createDesktopRelationshipDependencyReader({ sql });
  if (typeof dependencies?.readDependencyState !== 'function') {
    fail(P02_DESKTOP_RELATIONSHIP_ERROR.DEPENDENCY_INVALID, 'dependency-reader');
  }
  const { KIND, COMMAND, COMMAND_REQUEST_SCHEMA, COMMAND_RESULT_SCHEMA,
    FOLDER_SOURCE_USER, CONVERGED_DIRECTION_APPLIED, LIBRARY_REFRESH_EVENT,
    LIBRARY_REFRESH_REASON_PREFIX } = P02_DESKTOP_RELATIONSHIP_V2;
  const M = P02_DESKTOP_RELATIONSHIP_MATERIALIZATION;
  const O = P02_DESKTOP_RELATIONSHIP_OUTCOME;

  async function readProtocolRow(objectDomain, objectId) {
    const peer = clean(await localPeerId());
    if (!peer) fail(P02_DESKTOP_RELATIONSHIP_ERROR.DEPENDENCY_INVALID, 'local-peer');
    const row = rows(await sql.select(P02_DESKTOP_RELATIONSHIP_READ_QUERIES.PROTOCOL,
      [peer, objectDomain, objectId]))[0] || null;
    return { peer, row };
  }

  function alreadyApplied(row, leaf) {
    return !!row &&
      clean(row.last_applied_revision_id) === leaf.revisionId &&
      clean(row.last_applied_revision_blob_sha256) === leaf.revisionBlobSha256 &&
      clean(row.last_applied_payload_sha256) === leaf.payloadSha256;
  }

  /* State-based plan: the payload IS the desired local state. */
  async function plan(objectDomain, canonical) {
    if (objectDomain === FOLDER_DOMAIN) {
      const local = await dependencies.readFolder(canonical.folderId);
      if (!local) {
        return { kind: KIND.CREATE_FOLDER, request: { folderId: canonical.folderId, name: canonical.name } };
      }
      if (clean(local.source) !== FOLDER_SOURCE_USER) {
        return { kind: null, refusal: 'p02-relationship-apply-folder-not-eligible',
          folderSource: clean(local.source) || null };
      }
      if (local.name === canonical.name) return { kind: null, materialization: M.IDENTICAL };
      return { kind: KIND.RENAME_FOLDER, request: { folderId: canonical.folderId, name: canonical.name } };
    }
    const binding = rows(await sql.select(P02_DESKTOP_RELATIONSHIP_READ_QUERIES.BINDING, [canonical.chatId]))[0] || null;
    const current = binding ? clean(binding.folder_id) : null;
    if (canonical.folderId === null) {
      if (current === null) return { kind: null, materialization: M.IDENTICAL };
      return { kind: KIND.UNBIND_CHAT, request: { chatId: canonical.chatId } };
    }
    if (current === canonical.folderId) return { kind: null, materialization: M.IDENTICAL };
    return { kind: KIND.BIND_CHAT, request: { chatId: canonical.chatId, folderId: canonical.folderId } };
  }

  async function invokeCommand(kind, request) {
    const payload = { schema: COMMAND_REQUEST_SCHEMA, kind, ...request };
    let result;
    try {
      result = await invoke(COMMAND, { request: payload });
    } catch (error) {
      fail(P02_DESKTOP_RELATIONSHIP_ERROR.COMMAND_UNAVAILABLE,
        clean(error?.code || error?.message) || 'invoke-failed');
    }
    if (!isPlainObject(result) || result.schema !== COMMAND_RESULT_SCHEMA ||
        typeof result.ok !== 'boolean' || result.kind !== kind) {
      fail(P02_DESKTOP_RELATIONSHIP_ERROR.COMMAND_RESULT_INVALID);
    }
    return result;
  }

  async function recordApplied({ peer, objectDomain, objectId, leaf }) {
    requireRelationshipDomain(objectDomain);
    const now = clock();
    await sql.execute(P02_DESKTOP_RELATIONSHIP_BOOKKEEPING_UPSERT, [
      peer, objectDomain, objectId,
      leaf.revisionId, leaf.revisionBlobSha256, leaf.payloadSha256,
      CONVERGED_DIRECTION_APPLIED,
      leaf.revisionBlobSha256, leaf.revisionBlobSha256,
      now, now
    ]);
    return 1;
  }

  async function requestLibraryRefresh({ objectDomain, kind, materialization }) {
    const reason = `${LIBRARY_REFRESH_REASON_PREFIX}:${relationshipDomainDescriptor(objectDomain).family}:${kind}`;
    if (libraryRefresh === null) {
      return Object.freeze({ requested: false, port: LIBRARY_REFRESH_EVENT, reason,
        materialization, unavailable: true });
    }
    try {
      const outcome = await libraryRefresh({ reason, objectDomain, kind, materialization,
        port: LIBRARY_REFRESH_EVENT });
      return Object.freeze({ requested: outcome?.requested !== false, port: LIBRARY_REFRESH_EVENT,
        reason, materialization, ...(isPlainObject(outcome) ? outcome : {}) });
    } catch (error) {
      /* A refresh request that fails never undoes a committed materialization. */
      return Object.freeze({ requested: false, port: LIBRARY_REFRESH_EVENT, reason,
        materialization, error: clean(error?.code || error?.message) || 'refresh-failed' });
    }
  }

  const base = ({ objectDomain, objectId, leaf, family }) => ({
    schema: P02_DESKTOP_RELATIONSHIP_V2.RESULT_SCHEMA,
    objectDomain, objectId, family,
    revisionId: leaf.revisionId,
    revisionBlobSha256: leaf.revisionBlobSha256,
    payloadSha256: leaf.payloadSha256,
    command: COMMAND,
    commandInvoked: false,
    commandResult: null,
    kind: null,
    materialization: M.NONE,
    relationshipSqliteWrites: 0,
    bookkeepingWrites: 0,
    repositoryWrites: 0,
    libraryRefresh: null,
    blockReason: null,
    dependencyDetail: null,
    dependency: null,
    conflictClass: null,
    errorCode: null,
    convergedDirection: null
  });

  /* Scheduler vocabulary beside the human-readable outcome. */
  const attempt = (outcome, reason = null, blockReason = null) =>
    Object.freeze({ outcome, reason, blockReason });

  async function applyRelationshipRevision({
    objectDomain, objectId, objectKey = null, leaf, revision
  } = {}) {
    requireRelationshipDomain(objectDomain);
    requireAdmittedRevision({ objectDomain, objectId, leaf, revision });
    const family = relationshipDomainDescriptor(objectDomain).family;
    const result = base({ objectDomain, objectId, leaf, family });
    result.objectKey = objectKey;

    let canonical;
    try {
      canonical = validateRelationshipPayload(objectDomain, revision.payload, objectId);
    } catch (error) {
      return Object.freeze({
        ...result, ok: false, outcome: O.INTEGRITY,
        errorCode: clean(error?.code) || 'relationship-payload-invalid',
        attempt: attempt('integrity', clean(error?.code) || 'relationship-payload-invalid')
      });
    }
    result.canonical = canonical;

    /* Replay: exact identity already applied -> nothing is touched. */
    const { peer, row } = await readProtocolRow(objectDomain, objectId);
    if (alreadyApplied(row, leaf)) {
      return Object.freeze({
        ...result, ok: true, outcome: O.ALREADY_APPLIED,
        convergedDirection: CONVERGED_DIRECTION_APPLIED,
        attempt: attempt('no-effect', 'already-applied')
      });
    }

    /* Apply-time dependency recheck, immediately before any materialization. */
    const dependency = await dependencies.readDependencyState({ objectDomain, objectId, canonical });
    result.dependency = dependency;
    if (dependency.ready !== true) {
      return Object.freeze({
        ...result, ok: false, outcome: O.BLOCKED,
        blockReason: dependency.blockReason, dependencyDetail: dependency.detail,
        attempt: attempt('blocked', dependency.blockReason, dependency.blockReason)
      });
    }

    const planned = await plan(objectDomain, canonical);
    if (planned.refusal) {
      return Object.freeze({
        ...result, ok: false, outcome: O.REFUSED,
        conflictClass: planned.refusal, errorCode: planned.refusal,
        folderSource: planned.folderSource ?? null,
        attempt: attempt('indeterminate', planned.refusal)
      });
    }

    if (planned.kind === null) {
      /* Already materialized and identical: no relationship write; the Sync
       * anchor is recorded so the object classifies as converged. */
      result.bookkeepingWrites = await recordApplied({ peer, objectDomain, objectId, leaf });
      return Object.freeze({
        ...result, ok: true, outcome: O.APPLIED, materialization: planned.materialization,
        convergedDirection: CONVERGED_DIRECTION_APPLIED,
        attempt: attempt('progress', 'identical-no-relationship-write')
      });
    }

    result.kind = planned.kind;
    result.commandInvoked = true;
    const commandResult = await invokeCommand(planned.kind, planned.request);
    result.commandResult = commandResult;
    if (commandResult.ok !== true || commandResult.applied !== true) {
      const code = clean(commandResult.errorCode) || 'p02-relationship-apply-refused';
      const dependencyRace = code === 'p02-relationship-apply-folder-missing' ||
        code === 'p02-relationship-apply-chat-missing';
      if (dependencyRace) {
        const detail = code.endsWith('folder-missing')
          ? P02_DESKTOP_RELATIONSHIP_V2.DEPENDENCY_DETAIL.FOLDER_MISSING
          : P02_DESKTOP_RELATIONSHIP_V2.DEPENDENCY_DETAIL.CHAT_MISSING;
        return Object.freeze({
          ...result, ok: false, outcome: O.BLOCKED, errorCode: code,
          blockReason: P02_DESKTOP_RELATIONSHIP_V2.BLOCK_REASON, dependencyDetail: detail,
          attempt: attempt('blocked', P02_DESKTOP_RELATIONSHIP_V2.BLOCK_REASON,
            P02_DESKTOP_RELATIONSHIP_V2.BLOCK_REASON)
        });
      }
      return Object.freeze({
        ...result, ok: false, outcome: O.REFUSED, conflictClass: code, errorCode: code,
        attempt: attempt('indeterminate', code)
      });
    }
    result.materialization = clean(commandResult.outcome) || M.NONE;
    result.relationshipSqliteWrites = Number(commandResult.rowsAffected) || 0;
    result.bookkeepingWrites = await recordApplied({ peer, objectDomain, objectId, leaf });
    result.libraryRefresh = await requestLibraryRefresh({
      objectDomain, kind: planned.kind, materialization: result.materialization
    });
    return Object.freeze({
      ...result, ok: true, outcome: O.APPLIED,
      convergedDirection: CONVERGED_DIRECTION_APPLIED,
      attempt: attempt('progress', result.materialization)
    });
  }

  return Object.freeze({
    schema: P02_DESKTOP_RELATIONSHIP_V2.SCHEMA,
    command: COMMAND,
    dependencyReader: dependencies,
    applyRelationshipRevision
  });
}

/*
 * The default Library refresh port for a Studio window: exactly the canonical
 * Library Index refresh-request event, with a bounded reason. It mutates
 * nothing itself; the Library decides what to re-read and whom to notify.
 */
export function createLibraryRefreshRequestPort(scope) {
  const { LIBRARY_REFRESH_EVENT } = P02_DESKTOP_RELATIONSHIP_V2;
  return async ({ reason } = {}) => {
    const dispatch = scope?.dispatchEvent;
    const Event = scope?.CustomEvent;
    if (typeof dispatch !== 'function' || typeof Event !== 'function') {
      return Object.freeze({ requested: false, port: LIBRARY_REFRESH_EVENT, reason: clean(reason),
        unavailable: true });
    }
    dispatch.call(scope, new Event(LIBRARY_REFRESH_EVENT, {
      detail: { reason: clean(reason), source: P02_DESKTOP_RELATIONSHIP_V2.LIBRARY_REFRESH_REASON_PREFIX,
        surface: 'studio', t: Date.now() }
    }));
    return Object.freeze({ requested: true, port: LIBRARY_REFRESH_EVENT, reason: clean(reason) });
  };
}
