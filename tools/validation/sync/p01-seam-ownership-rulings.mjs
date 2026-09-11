/*
 * O1-B2.2 — the recorded T19 ownership rulings.
 *
 * Four confirmed durable-write paths were excluded from the standdown's scope
 * by supervisor ruling. An exclusion is the most consequential verdict in the
 * inventory - it removes a mutation path from the gate's reach entirely - so
 * each one is recorded here with the four things that make it auditable rather
 * than merely asserted: the exact path and function, the write it actually
 * performs, the authority that DOES govern it, and why writer-generation does
 * not.
 *
 * THE RULING IS NARROW, and the narrowness is the point. Being out of T19 means
 * only "the writer-generation record is not this path's mutation authority". It
 * does NOT mean the folder domain moved to P02, that these are part of the P02
 * chat-sync surface, or that any of them may bypass its own existing gates -
 * every authority named below stays exactly as load-bearing as it was.
 *
 * The scope test each of these turns on lives in P02_STANDDOWN_SCOPE
 * (packages/core/sync-writer-generation-v2.mjs): the gate governs paths that
 * produce or mutate a P01 SYNC ARTIFACT. "Writes something durable" was never
 * the criterion - if it were, every local edit in the product would be refused
 * the moment P01 stood down, and a standdown would be indistinguishable from a
 * freeze.
 */

export const P01_OWNERSHIP_RULINGS = Object.freeze([
  Object.freeze({
    file: 'src-surfaces-base/studio/sync/convergence-action-ui.tauri.js',
    symbol: 'executeSelectedConvergence',
    classification: 'OUT_OF_T19 — RECEIVE/CANONICAL_CONVERGENCE',
    family: 'F7/F10.8 folder-metadata inbound convergence Apply',
    actualMutation:
      'One transaction in sqlite:studio-v1.db: INSERT INTO sync_maintenance_log, '
      + 'UPDATE folders SET color = ?, updated_at = ? WHERE id = ?, then UPDATE of '
      + 'the audit row. sync_maintenance_log is the local maintenance/audit table, '
      + 'not a publication or export ledger.',
    owningAuthority:
      'A three-stage operator approval token chain — I_APPROVE_LOCAL_COLOR_CONVERGENCE, '
      + 'I_APPROVE_DESKTOP_LOCAL_FOLDER_COLOR_APPLY, and the native dev gate '
      + 'I_UNDERSTAND_THIS_APPLIES_ONE_LOCAL_FOLDER_COLOR_CHANGE — plus an actionable '
      + 'preflight, a single-field colour allowlist, baseline-hash CAS against the live '
      + 'row, a dry-run apply-plan proof requiring writesPerformed === 0, and F5/F6 '
      + 'blocker checks.',
    reasonWriterGenerationNotApplicable:
      'It is the inbound direction. The colour is a value OBSERVED from a peer relay '
      + 'envelope and written into local canonical state; the result is stamped '
      + 'localOnly with syncPropagated false and no apply event emitted. A standdown '
      + 'transfers who PUBLISHES, and an installation that can no longer accept '
      + 'convergence is not stood down, it is deaf.',
    evidence:
      'convergence-action-ui.tauri.js:478-527 delegates and never writes; '
      + 'color-convergence-action.tauri.js:332-361 sources the colour from the relay '
      + 'INBOX; folder-color-apply.tauri.js:484-486 stamps localOnly/syncPropagated=false; '
      + 'folder_metadata_color_apply.rs:650-800 is the only durable write; the module '
      + 'chain contains no reference to any P01 sync artifact.'
  }),

  Object.freeze({
    file: 'src-surfaces-base/studio/sync/convergence-watermarks.tauri.js',
    symbol: 'recordConvergenceWatermark',
    classification: 'OUT_OF_T19 — RECEIVE/CONVERGENCE_BOOKKEEPING',
    family: 'F7/F10.8 convergence bookkeeping',
    actualMutation:
      'One durable append at convergence-watermarks.tauri.js:346, storageSet into '
      + "'h2o:sync:convergence-watermarks:v1' (chrome.storage.local; on Desktop the "
      + 'SQLite kv_store shim) recording peerId/subjectId/lineageId/revisionHash/'
      + 'watermarkAtIso for an apply that has already happened.',
    owningAuthority:
      'The convergence action that calls it — the same operator approval chain and '
      + 'preflight as the Apply above, reached only through '
      + 'convergence-bookkeeping.tauri.js finalizeConvergenceAction after applied === true.',
    reasonWriterGenerationNotApplicable:
      'It records that an inbound apply occurred. It creates no P01 publication '
      + 'artifact: nothing here produces latest.json, chrome-latest.json, the local '
      + 'publication slot, a delivery envelope, or a WebDAV revision or head. A '
      + 'watermark is a note about the past, not an outbound write.',
    evidence:
      'convergence-watermarks.tauri.js:30 (key), :144-178 (storageSet), :346 (the append); '
      + 'convergence-bookkeeping.tauri.js:227-315 reaches it only post-apply.'
  }),

  Object.freeze({
    file: 'src-surfaces-base/studio/sync/sqlite-writer-identity-sentinel.tauri.js',
    symbol: 'executeAuthorizedSqlite',
    classification: 'OUT_OF_T19 — GENERIC_CANONICAL_EDIT_SUBSTRATE',
    family: 'F15/F16 authorized-SQL substrate',
    actualMutation:
      'Forwards caller-supplied statements to the Tauri command '
      + 'f15_authorized_sqlite_execute, which runs them inside BEGIN IMMEDIATE / COMMIT '
      + 'against sqlite:studio-v1.db — including INSERT OR REPLACE and DELETE on the '
      + 'canonical folder_bindings table.',
    owningAuthority:
      'SQLite writer-identity triggers, enforced natively: validate_identity accepts only '
      + 'f15.execute-settlement-writer, f15.bulk-migration, f16.folder-legacy-fallback, '
      + 'f15.debug-bypass and f15.emergency-repair, and the last two additionally require '
      + 'literal operator tokens. Each caller must also assert its own enabling flag.',
    reasonWriterGenerationNotApplicable:
      'It is a SUBSTRATE shared across feature families, not a P01 path. Gating it would '
      + 'refuse every feature that shares it — ordinary folder-binding edits the user '
      + 'makes, and inbound import materialization — which is the freeze the ruling '
      + 'excludes. The boundary for a shared substrate is the P01 FEATURE ENTRY POINT '
      + 'that reaches it, and none does: all 19 enumerated callers are local edits, '
      + 'inbound applies, or sandboxed proofs.',
    evidence:
      'Exhaustively enumerated at HEAD 5954e4e6: f15_authorized_sqlite_execute appears in '
      + 'exactly 8 places repo-wide (1 definition, 4 handler registrations, 1 JS invoke, '
      + '2 static assertions); the facade fans out to 8 product modules; the '
      + 'identity-string sweep adds no caller; the two indirect reach paths '
      + '(library-store-cutover-shims, folders.tauri.js legacy fallback) were enumerated '
      + 'call site by call site; and every P01 artifact producer was checked from the '
      + 'artifact side and references the facade nowhere. anyP01PublicationRoute = false.'
  }),

  Object.freeze({
    file: 'apps/studio/desktop/src-tauri/src/real_transport_capability_probe.rs',
    symbol: 'h2o_rt_first_write',
    classification: 'OUT_OF_T19 — SEPARATE_R6_OPERATOR_CEREMONY',
    family: 'R6 real-transport capability probe',
    actualMutation:
      'On the one authorized run: a 0600 JSON consumed marker under '
      + 'first-write-consumed/<receiptCoreHash>.json, and a single WebDAV PUT of the '
      + 'fixed sentinel payload to <remoteRoot>/.h2o-w3-sacrificial-probe/<16-hex>.sentinel '
      + '— a dedicated sacrificial namespace, not the object repository.',
    owningAuthority:
      'The sealed R6 v2 offline approval package: R6ApprovalGateConfig::production() with '
      + 'compile-time pinned approval commit and artifact hash that the receipt must '
      + 'RECOMPUTE, not merely quote; plus receipt/approval expiry windows, a binding to '
      + 'the sha256 of the running executable, an owner-only private token pair whose '
      + 'hashes must match the receipt commitments, a one-shot consumed-marker check, a '
      + 'kill switch re-read before and after the marker write, and — on the CLI ceremony '
      + 'path — a byte-exact operator-typed approval phrase.',
    reasonWriterGenerationNotApplicable:
      'It is a capability probe, not a production P01 writer. It has zero product '
      + 'callers, writes a sacrificial sentinel rather than any P01 sync artifact, and '
      + 'hard-blocks when productSyncReady or transportReady resolve true. Answering to '
      + 'two authorities would make neither of them the authority.',
    evidence:
      'real_transport_capability_probe.rs:5986-5991 (command), :84-87 (sealed pins), '
      + ':3599-3617 + r6-offline-package-core/src/lib.rs:948-967 (gate), :4327-4348 '
      + '(sacrificial target path), :3746-3758 (readiness must be false). Repo-wide grep '
      + 'finds no .js/.mjs product caller. Remains separately prohibited during O1 by the '
      + 'existing real-WebDAV/R3 STOP gate, and was NOT executed.'
  })
]);

/* Every exclusion must carry all four. The disposition layer enforces this, and
 * this list exists so the requirement is stated in one place rather than
 * rediscovered. */
export const OWNERSHIP_REQUIRED_FIELDS = Object.freeze([
  'file', 'symbol', 'actualMutation', 'owningAuthority',
  'reasonWriterGenerationNotApplicable'
]);
