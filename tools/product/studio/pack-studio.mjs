// @version 2.3.0  (Phase 8L-5: source folder renamed to src-surfaces-base/)
import fs from "node:fs";
import path from "node:path";

import { SURFACES_BASE_REL } from "../../paths.mjs";

// Phase 8L-5: source-side path authority. Post-rename resolves to
// "src-surfaces-base/studio". The bundle-output path `<outDir>/surfaces/studio`
// (see archiveWorkbenchOutDir below) is INTENTIONALLY decoupled — it stays
// literal "surfaces/studio" so chrome.runtime.getURL strings inside bundled
// bg.js / Studio mirrors continue to resolve.
export const ARCHIVE_WORKBENCH_SOURCE_REL = path.join(SURFACES_BASE_REL, "studio");
export const ARCHIVE_WORKBENCH_SOURCE_FILES = Object.freeze([
  "studio.html",
  "studio.css",
  "studio.js",
  "S0D3e. 🎬 Transcript Studio Host - Studio.js",

  "S0A2a. 🎬 Observer Hub - Studio.js",
  "S0A1a. 🎬 H2O Core - Studio.js",

  // Studio Platform Adapter — must load after H2O Core and before any feature
  // module. Contracts: src-surfaces-base/studio/STUDIO_PLATFORM_ADAPTER_GUIDE.md.
  // Subdir entries; pack-studio's sync step creates parent dirs on copy.
  "platform/index.js",
  "platform/platform.mv3.js",
  "platform/platform.tauri.js",
  "platform/selectors.contract.js",

  // Dock Panel shell — passive, mountless tab registry. studio.html references
  // dock/dock-keys.js and dock/dock-shell.studio.js between platform/ and
  // store/; without this entry the extension build emits ERR_FILE_NOT_FOUND
  // for those <script> tags. Contracts: src-surfaces-base/studio/dock/README.md.
  "dock/dock-keys.js",
  "dock/dock-shell.studio.js",

  // Dock Panel read-only tab modules (Phase 1b-1e + Finder). studio.html
  // references all eight after their store façades; without these entries
  // the build emits ERR_FILE_NOT_FOUND for the dock/tabs/*.tab.studio.js
  // <script> tags. Keep parallel to ARCHIVE_WORKBENCH_OUT_FILES below.
  "dock/tabs/highlights.tab.studio.js",
  "dock/tabs/bookmarks.tab.studio.js",
  "dock/tabs/notes.tab.studio.js",
  "dock/tabs/attachments.tab.studio.js",
  "dock/tabs/navigator.tab.studio.js",
  "dock/tabs/context.tab.studio.js",
  "dock/tabs/capture.tab.studio.js",
  "dock/tabs/finder.tab.studio.js",

  // Studio Ribbon shell — passive constants and registry. studio.html
  // references these before the visible S0Y1a ribbon surface module.
  "ribbon/ribbon-keys.js",
  "ribbon/ribbon-shell.studio.js",

  // Studio Edit Overlay — overlay keys/applier (Phase 2a) plus the Markdown
  // serializer (Phase 3a) and DOCX writer (Phase 3c), all extended for inline
  // formatting in Phase 5d. studio.html references all four before
  // store/editOverlay.js; keep copied with the same subdir names to avoid
  // runtime script 404s. Keep parallel to ARCHIVE_WORKBENCH_OUT_FILES below.
  "overlay/overlay-keys.js",
  "overlay/overlay-applier.studio.js",
  "overlay/overlay-serializer.studio.js",
  "overlay/overlay-docx-writer.studio.js",

  // Studio Appearance / View Options (v2.5.8) — top-right options panel.
  // Passive constants + store + panel. studio.html references all three;
  // missing any of them produces a 404 and the Appearance trigger never
  // mounts. Same subdir copy pattern as dock/ribbon/overlay.
  // Contracts: src-surfaces-base/studio/appearance/.
  "appearance/appearance-keys.js",
  "appearance/appearance-store.studio.js",
  "appearance/appearance-panel.studio.js",

  // Studio Store (Stage 1 parallel infra) — loads after platform/ and before
  // any feature module. Contracts: src-surfaces-base/studio/store/README.md,
  // STUDIO_STORAGE_CONTRACT.md.
  "store/index.js",
  "store/highlights.js",
  // Studio-local edit overlay records. Passive until future ribbon phases
  // create overlay operations.
  "store/editOverlay.js",
  // Dock Panel read-only feature store façades (Phase 1b-1e). Each is a
  // passive, sync-API/async-hydrate facade over a native engine's
  // chrome.storage keys. studio.html references all four; without these
  // entries the build emits silent 404s and H2O.Studio.store.{prefs,
  // context, bookmarks, notes} remain undefined at runtime. Order
  // matches the studio.html script ordering (prefs → context →
  // bookmarks → notes).
  "store/prefs.js",
  "store/context.js",
  "store/bookmarks.js",
  "store/notes.js",
  "store/navigator.js",
  "store/capture.js",
  "store/libraryIndex.js",
  // Desktop-only: SQLite-backed chats entity (M2a-3a). Self-detects Tauri
  // and silently no-ops on MV3 / web; safe to ship in chrome-live build.
  "store/chats.tauri.js",
  // Desktop-only: SQLite-backed snapshots entity (M2a-3b). Same gating
  // as chats.tauri.js; backs snapshots + snapshot_turns tables.
  "store/snapshots.tauri.js",
  // Desktop-only: SQLite-backed saved-chat asset registry (Phase C C2b). Same
  // gating; backs assets + snapshot_turn_assets tables (Migration v14).
  // Substrate only — no binary CAS file IO, no package materialization, no GC.
  "store/assets.tauri.js",
  // Desktop-only: SQLite-backed folders entity (M2a-3c). Same gating;
  // backs folders + folder_bindings tables. Must load after chats.tauri.js
  // because listChats() delegates to store.chats.
  "store/folders.tauri.js",
  // Desktop-only: SQLite-backed labels entity (M2a-3d). Same gating; backs
  // labels + label_bindings tables. Composite binding PK allows multiple
  // labels per chat. listChats() delegates to store.chats (same pattern).
  "store/labels.tauri.js",
  // Desktop-only: SQLite-backed tags entity (M2a-3e). Same gating + binding
  // shape as labels.tauri.js; tags has an auto_derived boolean and no
  // updated_at column.
  "store/tags.tauri.js",
  // Desktop-only: SQLite-backed categories entity (M2a-3f). No
  // category_bindings table — assignment lives in chats.category_id.
  // assignChat / clearChat write directly to chats; listChats delegates
  // to store.chats.
  "store/categories.tauri.js",
  // Desktop-only: SQLite-backed tombstones entity (F5C). Inert scaffold;
  // no existing delete path calls it and no export/import behavior changes.
  "store/tombstones.tauri.js",
  // Desktop-only: SQLite-backed tombstone review queue (F5F.1). Inert
  // scaffold; no importer integration and no remote delete apply.
  "store/tombstone-reviews.tauri.js",
  // Desktop-only: SQLite-backed general sync conflict queue (F6.1b.1).
  // Read-only diagnostics/list/get scaffold over sync_conflicts.
  "store/conflicts.tauri.js",
  // Desktop-only: debug F6 final validation harness. Dormant until manually
  // invoked through H2O.Studio.devValidation.f6FinalValidation.
  "dev/f6-final-validation.tauri.js",
  // Chrome/MV3-only: IndexedDB-backed tombstone review queue scaffold
  // (F5F.4c.1). API parity with Desktop scaffold, excluding ingestion/apply.
  "store/tombstone-reviews.mv3.js",
  // Desktop-only: full-bundle ingestion (M2b-1 dry-run + M2b-2/M2c-3
  // merge-mode write side). dryRunImportBundle is read-only;
  // importBundle is merge-only (overwrite rejected, append-only,
  // pre-checks each entity via .get(id) before writing). Routed through
  // callArchive's Desktop branch in studio.js.
  "ingestion/import-bundle.tauri.js",
  // Desktop-only: full-bundle export. Reads SQLite-backed public store
  // adapters and emits Chrome-compatible h2o.studio.fullBundle.v2.
  "ingestion/export-bundle.tauri.js",
  // Shared HTML sanitizer (Phase C C3.1). Surface-neutral; installs
  // H2O.Studio.html.sanitize. Must precede the saved-chat package projector,
  // which delegates sanitization to it.
  "platform/html-sanitizer.js",
  // Canonical base transcript Renderer. Loaded by studio.html after the shared
  // sanitizer and before studio.js Reader orchestration.
  "renderer/chat-renderer.studio.js",
  // Desktop-only: governed v3 package-member gzip codec and bounded
  // physical/logical verification. Must precede the package writer.
  "ingestion/saved-chat-package-codec.tauri.js",
  "ingestion/saved-chat-portable-zip.studio.js",
  // Desktop-only: saved-chat package v1 projector/writer. Private Phase B
  // API only; no UI, import/recovery, sync transport, or CAS implementation.
  "ingestion/saved-chat-package-v1.tauri.js",
  // Desktop-only: content-addressed asset store (Phase C C3.2). Filesystem-only
  // put/get under $APPLOCALDATA/archive/assets; no registry/DB coupling, no
  // materialization, no GC.
  "ingestion/asset-cas.tauri.js",
  // Desktop-only: saved-chat package asset materializer (Phase C C4.1). Extracts
  // inline data:image/*, orchestrates CAS + registry (injected), rewrites refs.
  // Pure transform; no file writes, no projector wiring yet, no contentHash v2.
  "ingestion/saved-chat-package-assets.tauri.js",
  // Desktop-only: M05 G1 trusted generation publication bridge. Package writes
  // publish through it, so it must load with the writer.
  "ingestion/saved-chat-generation-publisher.tauri.js",
  // Desktop-only: M09 P2.3 read-only native generation-family policy client
  // and active-family package construction/publication routing facade.
  "ingestion/saved-chat-generation-policy.tauri.js",
  // Desktop-only: M05 Phase 2.1 mutation-free current-projection probe.
  "ingestion/saved-chat-projection-probe.tauri.js",
  // Desktop-only: M05 Phase 2.2 per-chat coverage/freshness engine. Composes
  // discovery + governed validation + projection; adds no new authority.
  // Desktop-only: saved-chat archive diagnostics (Phase C C5.1/C5.2). Read-only
  // package inventory + manifest/snapshot/hash validation under archive/packages.
  // No DB/CAS reconciliation, sync, import/recovery, repair, or UI.
  "ingestion/saved-chat-coverage.tauri.js",
  "ingestion/saved-chat-archive-diagnostics.tauri.js",
  // M05 Phase 4 shared presentation adapter. Pure mapping from the coverage and
  // materializer authorities to operator-facing labels. No freshness recompute,
  // no generation ranking, no BEST-HISTORICAL promotion.
  "ingestion/saved-chat-archive-presentation.studio.js",
  // Chrome/MV3: saved-chat archive request builder (Phase D.3A). Builds
  // metadata-only h2o.savedChatArchiveRequest.v1 envelopes from intent. No
  // transport, Desktop queue call, package writer, CAS, Sync, file drop,
  // native messaging, localhost relay, or user export.
  "ingestion/saved-chat-archive-request-builder.mv3.js",
  // Chrome/MV3: saved-chat archive request delivery (Phase D.3C.1). Low-level
  // File System Access API write of a metadata-only request file into the
  // dedicated $HOME/H2O Studio Archive Requests inbox. No UI, no result
  // read-back, no automatic/background delivery, no Desktop runtime, sync,
  // CAS, package writer, or queue/materializer call.
  "ingestion/saved-chat-archive-request-delivery.mv3.js",
  // Chrome/MV3: saved-chat archive delivery companion on save (Phase E.1.1).
  // Flag-gated (archive.deliverOnSaveToFolder, default OFF) listener on
  // library-index updates that delivers one metadata-only request per newly
  // saved + snapshot-backed row via the D.3C delivery API, deduped per
  // chatId|snapshotId. No UI, no Save-to-Folder hook, no Desktop runtime.
  "ingestion/saved-chat-archive-on-save.mv3.js",
  // Saved-chat archive status model (Phase E.2.1). Pure status-model helper
  // computeSavedChatArchiveStatusV1 mapping row + local delivered meta + delivery
  // diagnostics + receipt read-back to a product-language status. No UI, no DOM,
  // no timers, no delivery/Desktop calls. Consumed by the later E.2 status surface.
  "ingestion/saved-chat-archive-status.studio.js",
  // Saved-chat archive status badge (Phase E.2.2). Renders one quiet inline
  // wbBadge--archive-status into a library row's wbBadges from the E.2.1 status
  // model + local delivered metadata. UI shell only: no buttons, no read-back,
  // no delivery/Desktop calls, no timers/watchers, no storage writes.
  "ingestion/saved-chat-archive-status-badge.studio.js",
  // Desktop-only: saved-chat archive request intake (Phase D.2A). Validates
  // Chrome-to-Desktop request envelopes and resolves Desktop store state
  // read-only. No queue, package write, sync, Chrome runtime, CAS, DB mutation,
  // import/recovery, or UI.
  "ingestion/saved-chat-archive-requests.tauri.js",
  // Desktop-only: saved-chat archive request inbox (Phase D.3B.1). Reads the
  // dedicated $HOME/H2O Studio Archive Requests inbox and enqueues through D.2B
  // only. Writes receipts; no materialization, package writer, CAS, sync,
  // Chrome delivery, import/recovery, or UI.
  "ingestion/saved-chat-archive-request-inbox.tauri.js",
  // Desktop operator action: saved-chat archive materializer trigger (Phase F.2).
  // Clearly-separated Desktop-only "Materialize package" card mounted as a sibling
  // beneath the read-only Archive Health card; invokes the D.2C materializer for an
  // explicit validated requestId. No scanner call, no automatic materialization, no
  // watcher/poller/daemon, no Chrome runtime, sync, CAS, or package writer here.
  "ingestion/saved-chat-archive-materializer-action.studio.js",
  // Desktop-only, read-only Archive Inspector (Phase H.2). Verifies + previews one
  // .h2ochat package read-only; reuses the diagnostics validator; no import/write.
  "ingestion/saved-chat-archive-inspector.studio.js",
  // Desktop-only, verification-gated import/recovery (Phase H.4). Dry-run + explicit
  // no-overwrite import-as-new (fresh ids, provenance) via the Desktop store adapters.
  "ingestion/saved-chat-archive-importer.studio.js",
  // M10 P3.6a: thin client over the trusted native portable verifier. Owns no
  // verification, no contentHash, and no legacy fallback.
  "ingestion/saved-chat-portable-package-verification.tauri.js",
  // Desktop-only, verification-gated .h2ochat export/share (Phase J.2). Dry-run +
  // explicit no-overwrite manifest-driven folder copy to $HOME/H2O Studio Exports/.
  "ingestion/saved-chat-archive-exporter.studio.js",
  // Desktop-only, verification-gated restore-original-ids (Phase K.2). Dry-run +
  // explicit confirm restore of absent original chatId/snapshotId. No relink,
  // tombstone override, Chrome authority, sync, or scanner/materializer changes.
  "ingestion/saved-chat-archive-restore.studio.js",
  // Desktop-only, verification-gated relink action (Phase K.4.2). Dry-run +
  // typed-confirm relink onto an existing target chat by inserting a fresh
  // snapshot + turns, then updating only target chat pointer metadata. API-only;
  // no UI card, tombstone override, Chrome authority, sync, or scanner changes.
  "ingestion/saved-chat-archive-relink.studio.js",
  // Desktop-only: saved-chat archive request materializer (Phase D.2C). Triggers
  // the existing package writer for a validated queued request (re-resolves
  // first); updates only the saved_chat_archive_requests row. No migration,
  // overwrite, Chrome runtime, sync, import/recovery, CAS, or UI.
  "ingestion/saved-chat-archive-materializer.tauri.js",
  // Read-only Saved Chat Archive Health UI shell (Phase C6.1). Renders C5
  // diagnostics into Settings -> Diagnostics via the injected read-only API; no
  // mutation/repair/import/sync/Chrome. Shows Desktop-only message when absent.
  "ingestion/saved-chat-reclamation-ui.studio.js",
  // M10 P3a: the trusted chain. The thin client reads the P1 Rust integrity
  // command; the composition joins it with the existing separate DB/CAS/renderer
  // observations and the P2 mapper. Loaded before the diagnostics facade can be
  // invoked; all three resolve their collaborators lazily, at call time.
  "ingestion/saved-chat-archive-integrity.tauri.js",
  // M10 P3.5b: read-only renderer DRIFT observation over trusted-valid
  // packages. Owns no gzip; decodes via the codec's bounded non-verifying
  // decoder. Resolved lazily by the composition below.
  "ingestion/saved-chat-archive-renderer-hygiene.js",
  "ingestion/saved-chat-archive-health-composition.js",
  // M10 P2: pure trusted-facts -> operator-state mapping. No verification,
  // filesystem, invoke or mutation authority.
  "ingestion/saved-chat-archive-health-mapping.js",
  // Saved Chat Recovery Center timeline surface. New-UI-only, read-only
  // per-chat version timeline; composes trusted integrity, the canonical
  // partition, coverage and the read-only inspector. No ordering, hashing,
  // validity, classification or recovery-eligibility authority; no mutation.
  "ingestion/saved-chat-recovery-center-ui.studio.js",
  "ingestion/archive-health-ui.studio.js",
  // Chrome: saved-chat archive request delivery UI (Phase D.3C.2). Minimal
  // manual Settings utility card wiring the D.3C.1 delivery APIs under an
  // explicit click. No automatic delivery, no read-back, no Desktop runtime,
  // sync, CAS, package writer, queue/materializer call, or Archive Health UI.
  "ingestion/saved-chat-archive-request-delivery-ui.studio.js",
  // F14.2.2: Desktop/Tauri L0 privacy kernel primitive. Inert shared
  // scanner/enforcer only; no domain adoption, publication, replay,
  // watermark, apply, convergence, storage, network, or mobile behavior.
  "sync/kernel/privacy-scan.tauri.js",
  // F14.2.3: Desktop/Tauri L0 identity kit primitive. Inert shared
  // canonical JSON, hash, subjectId, dedupeKey, lineageId, and identity
  // validation helpers only; no domain adoption or behavior change.
  "sync/kernel/identity-kit.tauri.js",
  // F14.2.4: Desktop/Tauri L0 blocker vocabulary primitive. Inert shared
  // blocker/warning normalization and categorization only.
  "sync/kernel/blockers.tauri.js",
  // F14.2.4: Desktop/Tauri L0 result-shape primitive. Inert shared
  // result builders and ok/actionable calculations only.
  "sync/kernel/result-shape.tauri.js",
  // F14.2.5: Desktop/Tauri L0 watermark monotonicity service. Inert
  // caller-supplied watermark comparison and forward-only validation only.
  "sync/kernel/watermark-service.tauri.js",
  // F14.2.6: Desktop/Tauri L0 consumed-operation primitive. Inert shared
  // consumed-operation shaping, origin-tag validation, lookup, and
  // replay-safety assistance only.
  "sync/kernel/consumed-op.tauri.js",
  // F14.2.7: Desktop/Tauri L0 tombstone reader / F5 handoff primitive.
  // Inert caller-supplied tombstone and F5 handoff/review shaping and
  // validation only.
  "sync/kernel/tombstone-reader.tauri.js",
  // F14.2.8: Desktop/Tauri L1 publication kit primitive. Inert shared
  // publication status, metadata, receipt, and validation helpers only.
  "sync/kernel/publication-kit.tauri.js",
  // F14.2.9: Desktop/Tauri L1 replay-defense composer. Inert shared
  // validation orchestration over identity, consumed-operation, watermark,
  // publication, tombstone, and origin-tag helpers only.
  "sync/kernel/replay-composer.tauri.js",
  // F14.2.10: Desktop/Tauri L1 owner-handoff primitive. Inert shared owner,
  // authority, handoff request, and handoff result shaping/validation only.
  "sync/kernel/owner-handoff.tauri.js",
  // F14.2.11: Desktop/Tauri L1 lifecycle state-machine framework. Inert
  // shared state, transition, history, and metadata shaping/validation only.
  "sync/kernel/lifecycle-framework.tauri.js",
  // F14.2.12: Desktop/Tauri L1 audit / proof framework. Inert shared audit,
  // proof, history, summary, and metadata shaping/validation only.
  "sync/kernel/audit-proof-framework.tauri.js",
  // F15.1.a: Desktop/Tauri read-only library catalog canonicalizer. Pure
  // label/tag/category row -> redacted library.catalog envelope using kernel
  // identity + privacy policies. No storage reads/writes or side effects.
  "sync/library/library-catalog-canonicalizer.tauri.js",
  // F15.1.b: Desktop/Tauri read-only library binding canonicalizer. Pure
  // endpoint binding row -> redacted library.binding envelope using kernel
  // identity + privacy policies. No store reads/writes or side effects.
  "sync/library/library-binding-canonicalizer.tauri.js",
  // F15.2.a: Desktop/Tauri read-only library catalog diagnostics. Diagnoses
  // canonical objects or raw rows via F15.1.a and emits relatedSubjects only
  // from supplied context. No store reads/writes or side effects.
  "sync/library/library-catalog-diagnostics.tauri.js",
  // F15.2.b: Desktop/Tauri read-only library binding diagnostics. Diagnoses
  // canonical objects or raw rows via F15.1.b and evaluates supplied context
  // only. No store reads/writes or side effects.
  "sync/library/library-binding-diagnostics.tauri.js",
  // F15.3.a: Desktop/Tauri read-only library catalog preflight. Composes
  // diagnostics with operation, lifecycle, sibling, account, replay,
  // watermark, consumed-op, and F5 eligibility preview gates. No side effects.
  "sync/library/library-catalog-preflight.tauri.js",
  // F15.3.b: Desktop/Tauri read-only library binding preflight. Composes
  // diagnostics with bind/unbind endpoint, uniqueness, account, replay,
  // watermark, consumed-op, and category-cache observation gates.
  "sync/library/library-binding-preflight.tauri.js",
  // F15.4.a: Desktop/Tauri side-effect-free library catalog proposal
  // candidate generator. Emits redacted proposal/candidate objects only; no
  // storage, publication, relay/outbox, apply, Native/F5, watermark, or
  // consumed-op writes.
  "sync/library/library-catalog-proposal-candidate-generator.tauri.js",
  // F15.4.b: Desktop/Tauri side-effect-free library binding proposal
  // candidate generator. Emits redacted proposal/candidate objects only; no
  // storage, publication, relay/outbox, apply, Native/F5, watermark, or
  // consumed-op writes.
  "sync/library/library-binding-proposal-candidate-generator.tauri.js",
  // F15.5.a: Desktop/Tauri side-effect-free library catalog handoff
  // preview. Composes F15.4 catalog proposal candidate + F15.3 preflight;
  // shapes Native or F5 owner handoff requests via kernel.shapeOwnerHandoff
  // and (tombstone only) kernel.shapeF5Handoff. No Native execution, no
  // F5 queue ingest (deferred to F15.6 receipts), no apply, no
  // publication, no relay/outbox, no watermark/consumed-op writes.
  "sync/library/library-catalog-handoff-preview.tauri.js",
  // F15.5.b: Desktop/Tauri side-effect-free library binding handoff
  // preview. Composes F15.4 binding proposal candidate + F15.3 preflight
  // and shapes a kernel-validated Native owner handoff request for
  // bind/unbind. Native-only — per F15.0.0 §6.1 the binding lane has no
  // F5 path. No Native execution, no F5 queue ingest, no chats.category_id
  // cache write, no apply, no publication, no relay/outbox, no
  // watermark/consumed-op writes.
  "sync/library/library-binding-handoff-preview.tauri.js",
  // F15.6.a: Desktop/Tauri library catalog apply-event receipt. Builds
  // applyEvent + receipt + auditMetadata + watermarkPreview +
  // consumedOperationPreview from the F15.5.a handoff preview. Six
  // Native operations stay preview-only with all sideEffectSummary flags
  // false. The seventh — tombstone — IS the F5 review queue ingress point
  // (mirrors F14.5.5.2 snapshot tombstone wire-through verbatim): calls
  // ingestF5Review with the handoff preview's F5 envelope; on success
  // sideEffectSummary.f5Touched flips true; on unavailable / duplicate /
  // throw / blocked the receipt stays ok:true and surfaces a warning.
  // No Native execution, no apply, no publication, no relay/outbox, no
  // watermark advance, no consumed-op write, no chats.category_id cache.
  "sync/library/library-catalog-apply-event-receipt.tauri.js",
  // F15.6.b: Desktop/Tauri library binding apply-event receipt. Builds
  // applyEvent + receipt + auditMetadata + watermarkPreview +
  // consumedOperationPreview from the F15.5.b binding handoff preview for
  // bind/unbind. Native-only — per F15.0.0 §6.1 the binding lane has no
  // F5 path. All eight sideEffectSummary flags stay false on every
  // success path. For chat-category bindings, the receipt emits a
  // `chats-category-id-refresh-pending` info warning to make the
  // materialized cache dependency explicit; the receipt itself never
  // writes the chats.category_id cache (that is execute-settlement-
  // writer's exclusive job per F15.0.2 §2.2). No Native execution, no F5
  // ingest, no apply, no publication, no relay/outbox, no watermark
  // advance, no consumed-op write, no chats.category_id cache.
  "sync/library/library-binding-apply-event-receipt.tauri.js",
  // F15.7.a: Desktop/Tauri library catalog bookkeeping. Append-only
  // Studio-local audit ledger for F15.6.a catalog receipts. Idempotent
  // by rowId (sha256 over subjectId + applyEventDigest + dedupeKey +
  // receiptDigest + actorPeer.syncPeerIdHash); duplicate calls return
  // recorded:false, alreadyPresent:true with no storage write. For
  // tombstone rows, mirrors f5ReviewIngested / f5ReviewId verbatim from
  // the receipt — bookkeeping does NOT re-invoke ingestF5Review. Eight
  // standard sideEffectSummary flags stay false; ninth lane-scoped flag
  // bookkeepingLedgerWritten flips true only on a new append. Stores at
  // chrome.storage.local key h2o:sync:library-catalog-bookkeeping:v1.
  // No Native execution, no apply, no publication, no relay/outbox, no
  // watermark advance, no consumed-op write, no F5 queue ingest, no
  // Labels/Categories/Tags mutation, no chats.category_id cache.
  "sync/library/library-catalog-bookkeeping.tauri.js",
  // F15.7.b: Desktop/Tauri library binding bookkeeping. Append-only
  // Studio-local audit ledger for F15.6.b binding receipts (bind /
  // unbind across the four binding kinds). Idempotent by rowId.
  // Native-only — per F15.0.0 §6.1 the binding lane has no F5 path;
  // any f5* footprint on the input receipt is rejected with
  // library-binding-bookkeeping-lane-invariant-violation. For
  // chat-category bindings, row.chatsCategoryIdRefreshPending=true
  // declaratively mirrors the receipt's chats-category-id-refresh-
  // pending warning so the materialized cache dependency is explicit
  // in the audit trail; bookkeeping itself never writes the
  // chats.category_id cache (settlement-writer's exclusive job per
  // F15.0.2 §2.2). Eight standard sideEffectSummary flags stay false;
  // ninth lane-scoped flag bookkeepingLedgerWritten flips true only on
  // a new append. Stores at chrome.storage.local key
  // h2o:sync:library-binding-bookkeeping:v1. No Native execution, no
  // apply, no publication, no relay/outbox, no watermark advance, no
  // consumed-op write, no F5 path, no Labels/Categories/Tags mutation,
  // no chats.category_id cache write.
  "sync/library/library-binding-bookkeeping.tauri.js",
  // F14.3.1: Desktop/Tauri read-only chat metadata canonicalizer. Pure
  // function over one chat record (Native mirror / Library Index /
  // Registry Core projection) -> the F14.3.0 canonical chat snapshot.
  // Uses kernel identity-kit + privacy-scan. No storage writes, no
  // mutation, no publication, no proposal, no preflight, no apply, no
  // watermark advance, no consumed-op writes. Quarantines on missing
  // chatId, missing account binding, schema mismatch, or any forbidden
  // field in input or output.
  "sync/chat/chat-canonicalizer.tauri.js",
  // F14.3.2: Desktop/Tauri read-only chat diagnostics. Six diagnostic
  // primitives consuming the chat canonicalizer + kernel identity /
  // privacy / blockers / lifecycle / consumed-op / tombstone-reader /
  // owner-handoff (validation only — no handoff execution). No
  // mutation, no publication, no apply, no watermark or consumed-op
  // writes.
  "sync/chat/chat-diagnostics.tauri.js",
  // F14.3.3: Desktop/Tauri read-only chat convergence preflight.
  // Composes the chat canonicalizer + chat diagnostics + kernel watermark
  // service + replay composer + owner-handoff validation to decide
  // whether an archive/rename operation is safe to become
  // proposal-eligible. No mutation, no publication, no apply, no
  // watermark/consumed-op writes. For rename the raw title NEVER
  // appears in the result — only a titleHash.
  "sync/chat/chat-convergence-preflight.tauri.js",
  // F14.3.4: Desktop/Tauri chat archive proposal candidate generator.
  // Single-purpose: archive only. Composes F14.3.3 preflight + F14.2.x
  // kernel envelope helpers (identity-kit, replay composer) to build a
  // redacted candidate envelope + a generated ledger row. No
  // publication, no outbox/relay, no apply, no Native interaction, no
  // mirror/watermark/consumed-op writes. Raw chatId / title /
  // accountId never appear in any output field.
  "sync/chat/chat-archive-proposal-candidate-generator.tauri.js",
  // F14.3.5: Desktop/Tauri chat rename proposal candidate generator.
  // Single-purpose: rename only. Reuses F14.3.3 preflight + F14.2.x
  // kernel helpers and appends only a generated proposal candidate row.
  // Emits titleHash only; no raw title/chatId/accountId, publication,
  // relay/outbox, apply, Native interaction, watermark, or consumed-op
  // writes.
  "sync/chat/chat-rename-proposal-candidate-generator.tauri.js",
  // F14.3.6a: Desktop/Tauri chat Native owner handoff preview.
  // Resolves generated archive/rename proposal candidates, validates
  // redaction + Native owner authority/reachability, and shapes an
  // owner-handoff request through the kernel. Read-only: no Native call,
  // handoff execution, publication, relay/outbox, apply, applyEvent,
  // watermark, or consumed-op writes.
  "sync/chat/chat-native-handoff-preview.tauri.js",
  // F14.3.6b: Desktop/Tauri chat applyEvent receipt builder. Builds a
  // redacted applyEvent receipt + audit metadata from a generated chat
  // archive/rename proposal, ready Native handoff preview, and successful
  // operation result. Receipt only: no Native execution, apply, handoff
  // execution, publication, relay/outbox, storage mutation, watermark, or
  // consumed-op writes.
  "sync/chat/chat-apply-event-receipt.tauri.js",
  // F14.3.7: Desktop/Tauri chat convergence completion layer. Adds
  // append-only local bookkeeping rows, a read-only archive/rename proof
  // harness, and a read-only chat convergence panel. No Native execution,
  // publication, relay/outbox, apply, watermark, or consumed-op writes.
  "sync/chat/chat-convergence-bookkeeping.tauri.js",
  "sync/chat/chat-convergence-proof.tauri.js",
  "sync/chat/chat-convergence-ui.tauri.js",
  // F14.4.1: Desktop/Tauri snapshot canonicalizer. Converts Native snapshot
  // records into redacted snapshot.conversation canonical objects. Read-only:
  // no restore, apply, publication, relay/outbox, Native execution, watermark,
  // or consumed-op writes.
  "sync/snapshot/snapshot-canonicalizer.tauri.js",
  // F14.4.2: Desktop/Tauri snapshot diagnostics. Read-only materialization,
  // identity, owner, mirror, tombstone, forbidden-field, retention,
  // content-integrity, and lifecycle probes. No restore/apply/publication.
  "sync/snapshot/snapshot-diagnostics.tauri.js",
  // F14.4.3: Desktop/Tauri snapshot convergence preflight. Read-only
  // archive/tombstone/restore proposal-eligibility gate. No proposal,
  // restore, apply, publication, relay, Native execution, or ledger writes.
  "sync/snapshot/snapshot-convergence-preflight.tauri.js",
  // F14.4.4: Desktop/Tauri snapshot archive proposal candidate generator.
  // Candidate ledger append only: no publication, relay, restore/apply,
  // Native execution, owner handoff, watermark, or consumed-op writes.
  "sync/snapshot/snapshot-archive-proposal-candidate-generator.tauri.js",
  // F14.4.5: Desktop/Tauri snapshot tombstone proposal candidate generator.
  // Candidate ledger append only: no publication, relay, restore/apply,
  // Native/F5 execution, owner handoff, watermark, or consumed-op writes.
  "sync/snapshot/snapshot-tombstone-proposal-candidate-generator.tauri.js",
  // F14.4.6: Desktop/Tauri snapshot restore proposal candidate generator.
  // Candidate ledger append only: no publication, relay, restore execution/apply,
  // Native/F5 execution, owner handoff, watermark, or consumed-op writes.
  "sync/snapshot/snapshot-restore-proposal-candidate-generator.tauri.js",
  // F14.4.7a: Desktop/Tauri snapshot Native archive handoff preview.
  // Read-only handoff request shaping only: no Native/F5 execution, apply,
  // publication, relay/outbox, watermark, or consumed-op writes.
  "sync/snapshot/snapshot-native-archive-handoff-preview.tauri.js",
  // F14.4.7b: Desktop/Tauri snapshot F5 tombstone handoff preview.
  // Read-only handoff request shaping only: no F5/Native execution, apply,
  // publication, relay/outbox, watermark, or consumed-op writes.
  "sync/snapshot/snapshot-f5-tombstone-handoff-preview.tauri.js",
  // F14.4.7c: Desktop/Tauri snapshot restore handoff preview.
  // Read-only Native handoff request shaping only. Tombstoned restores also
  // validate F5 tombstone evidence. No Native/F5 execution, apply,
  // publication, relay/outbox, watermark, or consumed-op writes.
  "sync/snapshot/snapshot-restore-handoff-preview.tauri.js",
  // F14.4.8a: Desktop/Tauri snapshot archive applyEvent receipt builder.
  // Receipt only: builds redacted applyEvent + audit/consumed/watermark
  // preview shapes. No Native/F5 execution, apply, publication, relay/outbox,
  // watermark, or consumed-op writes.
  "sync/snapshot/snapshot-archive-apply-event-receipt.tauri.js",
  // F14.4.8b: Desktop/Tauri snapshot tombstone applyEvent receipt builder.
  // Receipt only: builds redacted applyEvent + audit/F5/consumed/watermark
  // preview shapes. No Native/F5 execution, apply, publication, relay/outbox,
  // watermark, or consumed-op writes.
  "sync/snapshot/snapshot-tombstone-apply-event-receipt.tauri.js",
  // F14.4.8c: Desktop/Tauri snapshot restore applyEvent receipt builder.
  // Receipt only: builds redacted applyEvent + audit/consumed/watermark
  // preview shapes. Tombstone restores include F5 clear evidence previews.
  // No Native/F5 execution, apply, publication, relay/outbox, watermark, or
  // consumed-op writes.
  "sync/snapshot/snapshot-restore-apply-event-receipt.tauri.js",
  // F14.4.9: Desktop/Tauri snapshot convergence bookkeeping.
  // Append-only redacted linkage ledger for proposal -> handoff -> receipt
  // chains. No Native/F5 execution, apply, publication, relay/outbox,
  // watermark, or consumed-op writes.
  "sync/snapshot/snapshot-convergence-bookkeeping.tauri.js",
  // F14.4.10: Desktop/Tauri snapshot convergence proof.
  // Read-only archive/tombstone/restore proof harness. No Native/F5 execution,
  // apply, publication, relay/outbox, storage mutation, watermark, or
  // consumed-op writes.
  "sync/snapshot/snapshot-convergence-proof.tauri.js",
  // F14.4.11: Desktop/Tauri snapshot convergence UI.
  // Read-only evidence panel for snapshot candidates, handoff previews,
  // receipts, bookkeeping rows, and proof status. No apply, publication,
  // relay/outbox, Native/F5 execution, watermark, or consumed-op writes.
  "sync/snapshot/snapshot-convergence-ui.tauri.js",
  // F14.5.5.1: Desktop/Tauri snapshot F5 review queue. Append-only
  // event-sourced ledger implementing the F14.5.5 contract. Ingests
  // shapeF5Handoff from snapshot tombstone receipts, persists
  // shapeF5Review rows in pending state, captures operator decisions
  // under approval-token guard, observes automatic expiry transitions,
  // surfaces actionable rows for F14.6. No Native execution, no F5
  // work outside the ledger, no apply, no publication/relay/outbox,
  // no watermark writes, no consumed-op writes, no own timer.
  "sync/snapshot/snapshot-f5-review-queue.tauri.js",
  // F14.5.5.4: Desktop/Tauri snapshot F5 review queue proof harness.
  // Persistent runtime proof for the F14.5.5.1 queue + F14.5.5.2 receipt
  // wire-through. Exercises 10 contract cases. Storage-safe: snapshots and
  // restores the queue ledger around proof execution. Synthetic privacy-safe
  // data only. No Native execution, no F5 work outside the queue ledger, no
  // apply, no publication/relay/outbox, no watermark/consumed-op writes, no UI.
  "sync/snapshot/snapshot-f5-review-queue-proof.tauri.js",
  // F14.5.5.3: Desktop/Tauri snapshot F5 review operator UI panel.
  // Read+decide-only panel for snapshot tombstone reviews. Renders
  // privacy-safe redacted rows from the F14.5.5.1 queue; exposes
  // approve-seal / approve-restore decisions only on pending rows under
  // approval-token + actor-peer guard. No Native execution, no F5 work
  // outside the queue ledger, no apply, no publication/relay/outbox, no
  // watermark writes, no consumed-op writes, no own timer.
  "sync/snapshot/snapshot-f5-review-panel.tauri.js",
  // F14.6.13: Desktop/Tauri snapshot execute readiness check.
  // Read-only proof that Snapshot proposal, handoff, receipt, bookkeeping,
  // proof/UI, and F5 review queue surfaces expose future Snapshot execute
  // adapter shapes. No adapter, dispatch, Native/F5 execution, publication,
  // settlement, watermark, consumed-op, storage, or UI mutation.
  "sync/snapshot/snapshot-execute-readiness.tauri.js",
  // F14.5.8: Desktop/Tauri capture fresh runtime. Builds fresh canonical
  // CaptureArtifact/CaptureEvent objects plus owner-handoff, replay, audit,
  // consumed-operation, and watermark preview shapes. Fresh mode only: no
  // recovery, publication, relay/outbox, F5, Native mutation, execute lane,
  // apply, or storage write.
  "sync/capture/capture-fresh-runtime.tauri.js",
  // F14.5.9: Desktop/Tauri capture recovery runtime. Adds
  // H2O.Capture.executeRecovery. Canonicalizes external redacted evidence
  // (studio-full-bundle-v2, mv3-cache-export, manual-redacted-evidence) into
  // a NEW snapshot subject linked to the lost/degraded subject via
  // recoveredFromSubjectIdHash. chatgpt-export-zip is blocked with
  // recovery-provenance-zip-deferred. No execute lane, no publication, no
  // relay/outbox, no F5 state mutation, no Native call, no apply, no remote
  // apply, no cross-install transfer, no watermark/consumed-op write. Lost
  // subject lifecycle is untouched.
  "sync/capture/capture-recovery-runtime.tauri.js",
  // F14.6.1: Desktop/Tauri execute journal primitive. Append-only Execute
  // Lane journal rows only. No dispatch, publication, relay/outbox, Native
  // execution, F5 execution, apply, watermark writes, consumed-op writes,
  // timers, or polling.
  "sync/execute/execute-journal.tauri.js",
  // F14.6.2: Desktop/Tauri execute envelope and adapter contract. Shapes
  // proposal-receipt and canonical-preview execute envelopes and keeps an
  // in-memory metadata-only adapter registry. No broker, dispatch,
  // publication, relay/outbox, Native/F5 execution, apply, watermark,
  // consumed-op, storage write, timer, or polling behavior.
  "sync/execute/execute-envelope.tauri.js",
  // F14.6.3: Desktop/Tauri execute preflight gate. Read-only gate over
  // execute envelopes, journal dedupe, replay composer, watermark validation,
  // F5 review lookup when required, and privacy scan. No broker, dispatch,
  // publication, relay/outbox, Native/F5 execution, apply, watermark write,
  // consumed-op write, storage write, timer, or polling behavior.
  "sync/execute/execute-preflight-gate.tauri.js",
  // F14.6.4: Desktop/Tauri execute publication lifecycle. Append-only
  // publication lifecycle rows after execute preflight. No relay enqueue/
  // dispatch, Native execution, F5 execution, apply, watermark write,
  // consumed-op write, timer, or polling behavior.
  "sync/execute/execute-publication-lifecycle.tauri.js",
  // F14.6.5: Desktop/Tauri execute relay broker. Stages relay-required
  // execute envelopes into relay outbox after execute preflight and
  // publication lifecycle checks. No relay upload, Native execution, F5
  // execution, apply, watermark write, consumed-op write, final settlement,
  // timer, or polling behavior.
  "sync/execute/execute-relay-broker.tauri.js",
  // F14.6.6: Desktop/Tauri execute Native broker. Dispatches Native-required
  // execute envelopes only through an existing safe invoke wrapper after
  // execute preflight and publication lifecycle checks. No F5 execution,
  // relay dispatch, apply, watermark write, consumed-op write, final
  // settlement, timer, or polling behavior.
  "sync/execute/execute-native-broker.tauri.js",
  // F14.6.7: Desktop/Tauri execute F5 broker. Closes approved or
  // auto-expired Snapshot F5 review rows after the required Native
  // seal/restore request succeeds. No relay dispatch, generic Native
  // dispatch, watermark write, consumed-op write, final settlement, timer,
  // or polling behavior.
  "sync/execute/execute-f5-broker.tauri.js",
  // F14.6.8: Desktop/Tauri execute settlement writer. Records
  // post-confirmation Execute settlement side effects in order: consumed
  // operation, watermark, bookkeeping, publication terminal, and journal
  // phases. No relay dispatch, Native execution, F5 execution, apply, timer,
  // or polling behavior.
  "sync/execute/execute-settlement-writer.tauri.js",
  // F15.8.f: Desktop/Tauri SQLite writer identity sentinel facade. Thin JS
  // wrapper around the Rust-backed h2o_writer_identity() protected-write
  // path. No store mutation by itself.
  "sync/sqlite-writer-identity-sentinel.tauri.js",
  // F15.8.c: Desktop/Tauri library execute settlement writer extension.
  // Routes library.catalog/library.binding execute envelopes to consumed-op,
  // watermark, F15.7 bookkeeping mirror, optional publication terminal, and
  // optional journal marker. No Native call, F5 closure, relay/outbox, cache
  // refresh, store shim, or Labels/Categories/Tags UI work.
  "sync/execute/execute-settlement-writer-library-extension.tauri.js",
  // F15.8.d: Desktop/Tauri chats.category_id cache refresh bridge.
  // Settlement-callable bridge for successful library.binding chat-category
  // applies. Resolves hashed chat/category subjects to local row ids and
  // performs exactly one materialized cache UPDATE through the supplied SQLite
  // context. No binding/catalog mutation, publication, relay/outbox,
  // Native/F5 call, apply, watermark write, consumed-op write, trigger, store
  // shim, bulk migration, or UI.
  "sync/execute/library-category-cache-refresh.tauri.js",
  // F15.8.e: Desktop/Tauri library catalog F5 closure bridge. Settlement-
  // callable bridge for library.catalog tombstone execute envelopes after
  // F15.6.a has ingested the F5 review and the review has a post-decision
  // state. Closes existing F5 rows and shapes Native evidence for
  // sealed/auto-expired tombstones without calling Native. No decision
  // recording, catalog mutation, SQLite/cache write, publication, relay/
  // outbox, watermark write, consumed-op write, store shim, bulk migration,
  // or UI.
  "sync/execute/library-catalog-f5-closure-bridge.tauri.js",
  // F15.8.g: Desktop/Tauri library bulk migration path. Dedicated
  // bundle-import path for labels/tags/categories and their chat bindings.
  // Uses the Rust-backed f15.bulk-migration writer identity and returns
  // redacted batch summaries only. No publication, relay/outbox, Native/F5
  // call, watermark write, consumed-op write, or UI.
  "sync/library/library-bulk-migration.tauri.js",
  // F15.8.f: Desktop/Tauri legacy library store cutover shims. Wraps
  // labels/tags/categories/chats write APIs and routes protected writes
  // through the Rust-backed SQLite writer identity sentinel.
  "sync/library/library-store-cutover-shims.tauri.js",
  // F14.6.9: Desktop/Tauri execute resume-on-boot coordinator. Re-reads
  // interrupted Execute journal rows and invokes existing preflight, broker,
  // or settlement primitives according to phase. No new adapter, dispatch
  // type, UI, timer, or polling behavior.
  "sync/execute/execute-resume-on-boot.tauri.js",
  // F14.6.10: Desktop/Tauri Chat execute adapter. Registers the Chat
  // proposal-receipt adapter and shapes redacted Chat proposal/handoff/receipt
  // evidence into Execute envelopes only. No broker, dispatch, Native call,
  // settlement, publication, or UI.
  "sync/execute/adapters/chat-execute-adapter.tauri.js",
  // F14.6.11: Desktop/Tauri Capture materialization writer. Materializes
  // canonical Capture fresh/recovery bundles through existing local storage
  // only. No relay, Native dispatch, F5, publication, consumed-op, watermark,
  // settlement, or UI.
  "sync/execute/execute-capture-materialization.tauri.js",
  // F14.6.12: Desktop/Tauri Capture execute adapter. Registers the Capture
  // canonical-preview adapter and shapes Capture materialization write
  // previews into Execute envelopes only. No materialization, dispatch,
  // settlement, publication, Native, F5, or UI.
  "sync/execute/adapters/capture-execute-adapter.tauri.js",
  // F14.6.14: Desktop/Tauri Snapshot execute adapter. Registers the Snapshot
  // proposal-receipt adapter and shapes redacted archive/restore receipts into
  // Execute envelopes only. Tombstone/F5 is explicitly deferred. No
  // materialization, dispatch, settlement, publication, Native, F5, Snapshot
  // mutation, or UI.
  "sync/execute/adapters/snapshot-execute-adapter.tauri.js",
  // F14.6.15: Desktop/Tauri Snapshot tombstone execute adapter. Registers
  // the Snapshot tombstone proposal-receipt adapter and shapes redacted
  // tombstone/F5 review evidence into Execute envelopes only. No relay
  // dispatch, Native dispatch, F5 close/execution, publication, settlement,
  // Snapshot mutation, or UI.
  "sync/execute/adapters/snapshot-tombstone-execute-adapter.tauri.js",
  // F15.8.a: Desktop/Tauri Library catalog execute adapter. Metadata-only
  // adapter consuming a F15.7.a catalog bookkeeping row + its source
  // F15.6.a receipt and shaping a F14.6.2 proposal-receipt execute
  // envelope ready for the F14.6 execute lane. For tombstone, enforces an
  // F5 post-decision state gate (approved-seal | approved-restore |
  // auto-expired); the adapter NEVER closes a review (F15.8.e bridge
  // does that). F14.6.2 DOMAINS does not yet include 'library.catalog';
  // the adapter falls back to local metadata storage and warns. No
  // Native execution, no broker dispatch, no F5 queue mutation, no
  // publication ledger write, no relay/outbox, no watermark advance,
  // no consumed-op write, no Labels/Categories/Tags mutation, no
  // chats.category_id cache write.
  "sync/execute/adapters/library-catalog-execute-adapter.tauri.js",
  // F15.8.b: Desktop/Tauri Library binding execute adapter. Metadata-only
  // adapter consuming a F15.7.b binding bookkeeping row + its source
  // F15.6.b receipt and shaping a F14.6.2 proposal-receipt execute
  // envelope ready for the F14.6 execute lane. Native-only — per F15.0.0
  // §6.1 the binding lane has no F5 path; any f5* footprint on input is
  // rejected. 8 flavors (2 operations × 4 binding kinds). For
  // chat-category bindings, the envelope's settlementShapes carry a
  // declarative requiresCategoryCacheRefresh: true +
  // categoryCacheAction: 'set'|'clear' so the F15.8.d cache refresh
  // bridge can dispatch the synchronous chats.category_id materialized
  // cache refresh via the F15.8.c settlement writer extension. The
  // adapter itself NEVER writes the cache. F14.6.2 DOMAINS does not yet
  // include 'library.binding'; the adapter falls back to local metadata
  // storage and warns. No Native execution, no broker dispatch, no F5
  // path, no publication ledger write, no relay/outbox, no watermark
  // advance, no consumed-op write, no Labels/Categories/Tags mutation,
  // no chats.category_id cache write.
  "sync/execute/adapters/library-binding-execute-adapter.tauri.js",
  // F15.9.a: Desktop/Tauri library sync proof foundation. Smoke proof
  // harness for catalog create and binding chat-label bind lanes, plus
  // store-cutover and bulk-migration proof delegates. Redacted summary
  // evidence only; no business-table write, publication, relay/outbox,
  // Native/F5 execution, apply, watermark write, or consumed-op write.
  "sync/library/library-sync-proof.tauri.js",
  // F16.1.a: Desktop/Tauri library runtime conflict gate foundation.
  // Read-only evaluator for catalog/binding/cache/bulk/F5 conflict
  // decisions. Provides callable gate output for later preflight and
  // settlement integration, but this module itself does not mutate.
  "sync/library/library-conflict-runtime.tauri.js",
  // F16.2.b: Desktop/Tauri deterministic multi-peer soak proof. Pure
  // in-memory offline/online replay harness for the Library Sync conflict
  // gate. Calls the real F16.1 conflict APIs where available and reports
  // hash-only scenario evidence; no storage, SQLite, Native/F5, publication,
  // relay/outbox, apply, watermark, or consumed-op mutation.
  "sync/library/library-multipeer-soak-proof.tauri.js",
  // F16.3.c: Desktop/Tauri lightweight/heavy performance stress proof.
  // Synthetic hash-only stress harness measuring real available Library Sync
  // modules and kernels where possible. Heavy stress is opt-in only; no
  // storage, SQLite, Native/F5, publication, relay/outbox, watermark, or
  // consumed-op.
  "sync/library/library-performance-stress-proof.tauri.js",
  // F19.1.a: Chrome/Desktop Library parity diagnostic. Shared read-only
  // hash-only snapshot + comparison API for premium-sync closure. Does not
  // import, export, settle, write SQLite/storage, call Native/F5, or change
  // propagation behavior.
  "sync/library/library-chrome-desktop-parity-diagnostic.js",
  // Phase 2: Desktop/Tauri canonical labels/tags/categories/classification
  // export projection. Counts/hashes/redacted shape only; no Chrome import,
  // request export, Desktop apply, canonical mutation, or delete behavior.
  "sync/library/library-metadata-export-projection.tauri.js",
  // Phase 1: labels/tags/categories/classification metadata diagnostics.
  // Shared read-only store/API/facet/deferred-warning readiness snapshot for
  // Desktop and Chrome Studio. Counts and hashes only; no product sync writes,
  // import/export/sync/apply calls, request export, Desktop apply behavior,
  // Chrome canonical mutation, or delete behavior.
  "sync/library/library-metadata-diagnostics.js",
  // F15.10.a: Desktop/Tauri Library Sync operator status UI. Read-only
  // Settings-hosted proof/status panel. Proof APIs run only from explicit
  // operator actions. No proposal actions, execute dispatch, Native/F5
  // decisions, SQL/store writes, publication, relay/outbox, watermark, or
  // consumed-op writes.
  "sync/library/library-sync-operator-ui.tauri.js",
  // F15.11.a: Desktop/Tauri folder-binding absorption bridge diagnostic.
  // Maps existing F7 folder bindings into future F15 library.binding
  // chat-folder identity using supplied subject hashes only. Read-only:
  // no wrapper delegation, chat-folder enablement, F7 behavior change,
  // folder store write, SQLite write, execute/settlement change, or UI.
  "sync/library/library-folder-binding-bridge-diagnostic.tauri.js",
  // F15.11.d: Desktop/Tauri folder-binding migration shadow events.
  // Hash-only in-memory shadow records linking legacy F7/F13 identity to
  // F15 library.binding chat-folder identity, plus the default-off guarded
  // F7 delegation flag. No folder store write, SQLite write, execute /
  // settlement, Native/F5 action, publication, relay/outbox, or UI.
  "sync/library/library-folder-binding-migration-shadow.tauri.js",
  // F14.6.16: Desktop/Tauri Execute Lane UI. Read-only Settings-hosted
  // operator visibility panel. No dispatch, Native, F5, relay, settlement,
  // publication, watermark, consumed-operation, or domain mutation controls.
  "sync/execute/execute-lane-ui.tauri.js",
  // Desktop-only: manual folder sync (M2d-1a). Wraps the M2b ingestion
  // importer with file-system scan + fingerprint dedupe + sync ledger.
  // No watcher yet — that lands in M2d-1b.
  "sync/folder-sync.tauri.js",
  // Desktop-only: opt-in latest-bundle auto-export (R2A-2). Extends
  // H2O.Studio.sync with debounced manual-export scheduling.
  "sync/auto-export.tauri.js",
  // Desktop-only: opt-in focus/visibility-triggered import (R3 Phase 2).
  // When the Studio window gains focus or becomes visible, runs
  // scanFolderOnce() through the existing folder-sync + importBundle
  // merge-only path. Behind feature flag sync.desktopImportOnFocus (OFF
  // by default). 30s minimum interval, 800ms debounce. No polling, no
  // watcher, no bidirectional sync, no schema change.
  "sync/focus-import.tauri.js",
  // Chrome/MV3-only: manual sync-folder import (R2B). Reads latest.json from
  // a user-picked directory handle and calls the existing merge importer.
  "sync/folder-import.mv3.js",
  // Chrome/MV3-only: opt-in sync-folder export (R3 Phase 1). Writes
  // chrome-latest.json (staged via chrome-latest.json.tmp) from a
  // user-gesture extension page, behind feature flag sync.chromeAutoImport
  // (OFF in prod by default). Service worker produces the bundle via
  // exportFullBundle; extension page does the file write. No latest.json
  // write, no bidirectional sync, no polling, no background daemon.
  "sync/auto-import.mv3.js",
  // F10.3: Chrome/MV3-only bundle-envelope preview bridge. Operator-triggered
  // diagnostic only; reads the existing sync-folder latest.json (read-only)
  // and presents it as a redacted cross-platform `bundle` envelope per
  // F10.2.0. No merge, no apply, no proposal, no write-back.
  "sync/bundle-envelope-preview.mv3.js",
  // F10.5: Chrome/MV3-only native-extension capture evidence preview
  // bridge. Operator-triggered diagnostic only; observes existing
  // native ChatGPT extension capture-store data via the read-only
  // H2O.Studio.store.capture facade and presents counts + structural
  // metadata as a redacted cross-platform `evidence` envelope per
  // F10.2.0. Never copies capture text / title / tags into payload.
  // No native-extension code change. No new chrome.runtime MSG_* type.
  // No chrome.storage write.
  "sync/capture-evidence-preview.mv3.js",
  // F10.6.1: Chrome Studio read-only folder sync canonicalizer. Operator-
  // triggered diagnostic only; canonicalizes existing folder diagnostics into
  // folder.metadata and diff/preview-only folderBinding objects. No diff
  // engine, proposal, conflictCandidate, applyEvent, storage write,
  // runtime broadcast, polling, WebDAV, or write-back.
  "sync/folder-sync-canonical.js",
  // F10.6.2: read-only folder sync diff engine. Consumes F10.6.1 canonical
  // snapshots only and returns a report-only diff. No proposal envelope,
  // conflictCandidate envelope emission, applyEvent, merge, write-back,
  // storage write, transport, polling, or WebDAV.
  "sync/folder-sync-diff.js",
  // F10.6.3: Chrome Studio proposal-preview envelope generation. Converts
  // proposalEligible F10.6.2 folder diff entries into F10.2 kind="preview" /
  // dryRun=true envelopes only. No proposal, conflictCandidate, applyEvent,
  // merge, write-back, storage write, runtime broadcast, polling, or WebDAV.
  "sync/folder-sync-proposal-preview.mv3.js",
  // F10.6.4: read-only folder conflict report layer. Consumes F10.6.2 diff
  // output only and returns enum-only hard/soft report rows. No proposal,
  // conflictCandidate envelope, applyEvent, merge, write-back, storage write,
  // runtime broadcast, polling, or WebDAV.
  "sync/folder-sync-conflict-report.js",
  // F2: peer-identity scaffold. Mints + persists per-install peer identity
  // (installId / physicalDeviceId / syncPeerId, surfaceKind / appKind /
  // storeKind). Single persistent key 'h2o:sync:peer-identity:v1' via
  // chrome.storage.local (Tauri kv shim on Desktop). Loads BEFORE the
  // multi-peer diagnostics so consumers find H2O.Studio.identity available.
  "sync/peer-identity.js",
  // F3: outbound export log. Mints exportId / sequenceNumber on every
  // disk-writing export and tracks previousExportId. Single persistent
  // key 'h2o:sync:export-log:v1'. Only mutated by exportLatestSyncBundle.
  // exportFullBundle (in-memory) never touches this log.
  "sync/export-log.js",
  // F4: producer-side per-peer local transport mirror. Writes only
  // devices/<encodeURIComponent(syncPeerId)> after the canonical root
  // latest.json commit succeeds.
  "sync/peer-transport.js",
  // Phase 30: disabled-by-default WebDAV transport dry-run gates. Builds
  // redacted manifests and guard decisions only; no remote IO or sync writes.
  "sync/webdav-transport-gates.js",
  // Phase 31: relay idempotency/restart proof harness. Models duplicate replay,
  // restart, and fail-closed cases only; no relay enqueue or transport writes.
  "sync/relay-idempotency-restart-proof-harness.js",
  // W1: real transport evaluator chain. Evaluate-only dry-run/console
  // substrates; no remote IO, enqueue, outbox/ledger/store mutation, or
  // readiness flip.
  "sync/real-transport-target-config.js",
  "sync/real-transport-kill-switch.js",
  "sync/real-transport-idempotency.js",
  "sync/real-transport-enqueue-boundary.js",
  "sync/real-transport-conflict-recovery.js",
  "sync/real-transport-sequence-export.js",
  "sync/real-transport-approval.js",
  "sync/real-transport-readiness.js",
  "sync/real-transport-dry-run.js",
  "sync/real-transport-console.js",
  // W2a: real transport first-write preflight. Evaluate-only, zero-write,
  // non-activating candidate receipt core builder; no token mint or writes.
  "sync/real-transport-first-write-preflight.js",
  // W3.1.5L: Desktop WebDAV setup UI for Rust-only resolver registry
  // preparation. Operator-triggered setup/storage only; no live probe, remote
  // IO, WebDAV/cloud/relay/CAS/file write, token/export mint, sequence burn,
  // fullBundle.v3 start, or readiness flip.
  "sync/webdav-transport-setup-ui.tauri.js",
  // F4.x: Desktop-only read-only peer discovery diagnostics for devices/*
  // state/checksum integrity. No imports, writes, polling, manifests, or history.
  "sync/peer-discovery.js",
  // F5H.5-b: read-only peer watermark diagnostics. Aggregates existing peer,
  // export, import, tombstone, and review evidence; no schema or lifecycle writes.
  "sync/peer-watermarks.js",
  // F1A: pure, synchronous multi-peer diff analyzer. Surface-agnostic.
  // Registers H2O.Studio.diagnostics.multiPeerDiff and collectLocalState.
  // No IO; safe to ship dormant on every surface.
  "sync/multi-peer-diff.js",
  // F7.1b: pure folder.metadata bidirectional preview comparator. Counts-only,
  // redacted, no storage reads/writes, no apply, no F6 ingest.
  "sync/bidirectional-folder-preview.js",
  // F7.4.1b: pure dry-run folder.metadata color apply planner. Simulated
  // checks only; no reads, writes, apply, F5 calls, or F6 calls.
  "sync/folder-metadata-apply-plan.js",
  // F7.4.1c: Tauri-only read layer for the dry-run apply planner. Reads
  // folder/tombstone state only; no writes, apply, F5 mutation, or F6 mutation.
  "sync/folder-metadata-apply-checks.tauri.js",
  // F10.7.1: Desktop/Tauri-only folder color apply gate. Consumes approved
  // preview envelopes, enforces color-only local apply, and delegates to the
  // existing transactional F7 Tauri command. No applyEvent, remote apply,
  // WebDAV, mobile write-back, retry, or automatic merge.
  "sync/folder-color-apply.tauri.js",
  // F10.7.2: Desktop/Tauri-only applyEvent receipt builder. Emits redacted
  // past-tense local apply receipts after successful local color commits.
  // No remote apply, WebDAV, convergence, storage write, or mutation.
  "sync/folder-apply-event.tauri.js",
  // F10.8.1: Desktop/Tauri-only local relay outbox. Appends validated
  // envelopes to durable local staging only. No upload, download, inbox,
  // WebDAV, convergence, remote apply, or automatic sync.
  "sync/relay-outbox.tauri.js",
  // F10.8.2: Desktop/Tauri-only local relay inbox. Validates, dedupes,
  // quarantines, and stores remote envelopes only. No apply, convergence,
  // WebDAV, networking, automatic review, or automatic sync.
  "sync/relay-inbox.tauri.js",
  // F10.8.3: Desktop/Tauri-only manual WebDAV relay adapter. Uploads outbox
  // envelopes and downloads remote blobs into inbox validation only. No
  // convergence, apply, automatic merge, review, polling, or sync loop.
  "sync/webdav-relay.tauri.js",
  // F10.8.4: Desktop/Tauri-only relay index and dedupe ledger. Derived from
  // durable outbox/inbox stores only. No writes, transport, convergence,
  // apply, or automatic sync.
  "sync/relay-index.tauri.js",
  // F10.8.5: Desktop/Tauri-only manual sync UI. Counts-first operator
  // surface over existing relay APIs. No automatic sync, convergence, merge,
  // or apply.
  "sync/manual-sync-ui.tauri.js",
  // F10.8.6a: Desktop/Tauri-only convergence readiness diagnostic. Reads
  // installed sync primitive availability and local relay/readiness state only.
  // No convergence, proposal generation, apply, WebDAV, storage mutation,
  // polling, network, automatic repair, or mobile write-back.
  "sync/convergence-readiness.tauri.js",
  // F10.8.6b: Desktop/Tauri-only remote envelope projector. Reads accepted
  // relay inbox envelopes into a redacted remote-observed state only. No
  // convergence, apply, proposal generation, conflictCandidate generation,
  // WebDAV changes, storage mutation, or mobile write-back.
  "sync/remote-envelope-projector.tauri.js",
  // F10.8.6c: Desktop/Tauri-only convergence planner. Classifies remote
  // observed state against a local canonical snapshot and readiness signals
  // only. No convergence, apply, proposal generation, conflictCandidate
  // generation, WebDAV changes, storage mutation, or mobile write-back.
  "sync/convergence-planner.tauri.js",
  // F10.8.6d: Desktop/Tauri-only manual convergence review UI. Renders
  // buildConvergencePlan() buckets only. No convergence actions, apply
  // buttons, proposal creation, WebDAV calls, auto-refresh, or merge.
  "sync/convergence-review-ui.tauri.js",
  // F10.8.6e: Desktop/Tauri-only proposal candidate generator. Converts
  // currently revalidated proposalEligible planner entries into local
  // generated proposal candidates only. No publish, outbox enqueue, apply,
  // applyEvent, conflictCandidate, convergence, or WebDAV.
  "sync/convergence-proposal-generator.tauri.js",
  // F10.8.6f: Desktop/Tauri-only conflictCandidate generator. Converts
  // currently revalidated conflicted planner entries into local generated
  // conflictCandidate candidates only. No publish, outbox enqueue, apply,
  // proposal, applyEvent, convergence, or WebDAV.
  "sync/convergence-conflict-candidate-generator.tauri.js",
  // F10.8.6g1: Desktop/Tauri-only shared publication ledger. Appends and
  // lists local publication lifecycle rows only. No publish, outbox enqueue,
  // upload, apply, convergence, or remote mutation.
  "sync/publication-ledger.tauri.js",
  // F10.8.6g2: Desktop/Tauri-only proposal publication. Publishes generated
  // proposal candidates into the local relay outbox only. No upload, WebDAV,
  // apply, applyEvent, convergence, or remote mutation.
  "sync/proposal-publication.tauri.js",
  // F10.8.6g3: Desktop/Tauri-only conflictCandidate publication. Publishes
  // generated conflictCandidate artifacts into the local relay outbox only.
  // No upload, WebDAV, apply, applyEvent, convergence, or remote mutation.
  "sync/conflict-publication.tauri.js",
  // F10.8.7: Desktop/Tauri-only convergence watermark persistence. Explicit
  // append-only per-peer/per-subject watermark records only. No automatic
  // advancement, convergence, apply, publication, WebDAV, or remote mutation.
  "sync/convergence-watermarks.tauri.js",
  // F10.8.8: Desktop/Tauri-only consumed operation ledger. Records processed,
  // ignored, blocked, duplicate, replay, expired, or superseded operations only.
  // No convergence, apply, watermark advancement, publication, transport,
  // WebDAV, or remote mutation.
  "sync/consumed-operation-ledger.tauri.js",
  // F10.8.9a: Desktop/Tauri-only convergence preflight. Validates selected
  // color-only proposalEligible planner entries only. No convergence, apply,
  // watermark advancement, applyEvent, publication, transport, or mutation.
  "sync/convergence-preflight.tauri.js",
  // F10.8.9b: Desktop/Tauri-only local color convergence action. Executes one
  // approved color-only local apply and returns an applyEvent receipt only.
  // No watermark, consumed ledger, publication, transport, or batch action.
  "sync/color-convergence-action.tauri.js",
  // F10.8.9c: Desktop/Tauri-only convergence bookkeeping. Finalizes one
  // successful local color convergence by recording consumed-operation and
  // watermark rows only. No apply, publication, transport, or remote mutation.
  "sync/convergence-bookkeeping.tauri.js",
  // F10.8.9d: Desktop/Tauri-only convergence action review UI. Calls existing
  // preflight, local color convergence, and bookkeeping APIs only from explicit
  // operator controls. No new convergence logic or transport.
  "sync/convergence-action-ui.tauri.js",
  // F10.9.1: Desktop/Tauri-only rename materialization diagnostic. Verifies
  // local proposedName against remote targetNameHash and safety ledgers only.
  // No rename, apply, convergence, publication, transport, or mutation.
  "sync/rename-materialization-diagnostic.tauri.js",
  // F10.9.2: Desktop/Tauri-only rename convergence preflight. Wraps the
  // materialization diagnostic and blocks rename-vs-move/delete cases only.
  // No rename, apply, convergence, publication, transport, or mutation.
  "sync/rename-convergence-preflight.tauri.js",
  // F10.9.3: Desktop/Tauri-only rename proposal candidate generator. Emits
  // local generated proposal candidates with targetNameHash only. No rename,
  // apply, publication, outbox enqueue, convergence, or transport.
  "sync/rename-proposal-candidate-generator.tauri.js",
  // F10.9.4: Desktop/Tauri-only local rename convergence action. Executes one
  // approved local folder rename only. No applyEvent, publication, bookkeeping,
  // transport, move, create, delete, binding, or mobile write-back.
  "sync/rename-convergence-action.tauri.js",
  // F10.9.5: Desktop/Tauri-only rename applyEvent receipt builder. Emits
  // redacted applyEvent evidence only after successful local rename results.
  // No rename, apply, watermark, consumed ledger, publication, or transport.
  "sync/rename-apply-event.tauri.js",
  // F10.9.6: Desktop/Tauri-only rename convergence bookkeeping. Builds the
  // rename applyEvent receipt, records consumed-operation and watermark rows
  // only. No rename, second apply, publication, enqueue, upload, or WebDAV.
  "sync/rename-convergence-bookkeeping.tauri.js",
  // F10.9.7: Desktop/Tauri-only rename convergence review/action UI. Calls
  // existing materialization, preflight, local rename, and bookkeeping APIs
  // from explicit operator controls only. No new rename logic or transport.
  "sync/rename-convergence-ui.tauri.js",
  // F10.9.8: Desktop/Tauri-only rename convergence runtime proof harness.
  // Orchestrates existing rename validation/action APIs only. No new
  // convergence behavior, publication, transport, WebDAV, or mobile write-back.
  "sync/rename-convergence-proof.tauri.js",
  // F11.0.1: Desktop/Tauri-only move materialization diagnostic. Validates
  // local tree parent/orphan/cycle/depth/duplicate-sibling safety only. No
  // move, apply, convergence, publication, transport, or mutation.
  "sync/move-materialization-diagnostic.tauri.js",
  // F11.0.2: Desktop/Tauri-only move convergence preflight. Wraps move
  // materialization and validates replay/consumed/watermark safety only. No
  // move, apply, convergence, publication, transport, or mutation.
  "sync/move-convergence-preflight.tauri.js",
  // F11.0.3: Desktop/Tauri-only move proposal candidate generator. Emits
  // local generated proposal candidates with redacted parent subject hashes
  // only. No move, apply, publication, convergence, or transport.
  "sync/move-proposal-candidate-generator.tauri.js",
  // F11.0.4a: Desktop/Tauri-only local move convergence action. Executes
  // one approved local parent update only. No applyEvent, publication,
  // bookkeeping, transport, create, delete, binding, or mobile write-back.
  "sync/move-convergence-action.tauri.js",
  // F11.0.4b: Desktop/Tauri-only move applyEvent receipt builder. Emits
  // redacted applyEvent evidence only after successful local move results.
  // No move, apply, watermark, consumed ledger, publication, or transport.
  "sync/move-apply-event.tauri.js",
  // F11.0.5: Desktop/Tauri-only move convergence bookkeeping. Builds the
  // move applyEvent receipt, records consumed-operation and watermark rows
  // only. No move, second apply, publication, enqueue, upload, or WebDAV.
  "sync/move-convergence-bookkeeping.tauri.js",
  // F11.0.5: Desktop/Tauri-only move convergence runtime proof harness.
  // Orchestrates existing move validation/action APIs only. No new
  // convergence behavior, publication, transport, WebDAV, or mobile write-back.
  "sync/move-convergence-proof.tauri.js",
  // F11.0.6: Desktop/Tauri-only move convergence review/action UI. Calls
  // existing materialization, preflight, local move, and bookkeeping APIs from
  // explicit operator controls only. No new move logic or transport.
  "sync/move-convergence-ui.tauri.js",
  // F12.0.1: Desktop/Tauri-only delete materialization diagnostic. Checks
  // empty-folder, base-fresh, delete-vs-edit, recovery, and F5 tombstone
  // capability only. No delete, apply, convergence, publication, or transport.
  "sync/delete-materialization-diagnostic.tauri.js",
  // F12.0.2: Desktop/Tauri-only delete convergence preflight. Wraps delete
  // materialization and validates replay/consumed/watermark safety only. No
  // delete, apply, convergence, publication, transport, or mutation.
  "sync/delete-convergence-preflight.tauri.js",
  // F12.0.3: Desktop/Tauri-only delete proposal candidate generator. Emits
  // generated proposal candidates with F5 predicate data only. No delete,
  // tombstone minting, F5 handoff, publication, convergence, or transport.
  "sync/delete-proposal-candidate-generator.tauri.js",
  // F12.0.4a: Desktop/Tauri-only delete proposal to F5 handoff preview.
  // Validates generated delete proposals for F5 review eligibility only. No
  // F5 row, tombstone, delete, applyEvent, publication, or transport.
  "sync/delete-f5-handoff-preview.tauri.js",
  // F12.0.4b: Desktop/Tauri-only delete F5 review row ledger. Appends
  // pending-review metadata rows only after handoff preview readiness. No
  // tombstone, delete, apply, applyEvent, publication, or transport.
  "sync/delete-f5-review-row.tauri.js",
  // F12.0.4c: Desktop/Tauri-only F5 reviewed empty-folder delete apply.
  // Requires approved review metadata, reruns delete safety checks, then
  // performs one tombstone-first local transaction only. No receipt envelope,
  // bookkeeping, publication, transport, convergence fan-out, or mobile write-back.
  "sync/delete-reviewed-apply.tauri.js",
  // F12.0.4d: Desktop/Tauri-only delete applyEvent receipt builder. Emits
  // redacted past-tense evidence only after successful reviewed delete results
  // and local tombstone/audit verification. No delete, apply, bookkeeping,
  // publication, transport, or mobile write-back.
  "sync/delete-apply-event.tauri.js",
  // F12.0.5: Desktop/Tauri-only delete convergence bookkeeping. Builds the
  // delete applyEvent receipt, records consumed-operation and watermark rows
  // only. No delete, second apply, publication, enqueue, upload, or WebDAV.
  "sync/delete-convergence-bookkeeping.tauri.js",
  // F12.0.5: Desktop/Tauri-only delete convergence runtime proof harness.
  // Orchestrates existing reviewed-delete validation/action APIs only. No new
  // delete behavior, publication, transport, WebDAV, or mobile write-back.
  "sync/delete-convergence-proof.tauri.js",
  // F12.0.6: Desktop/Tauri-only delete convergence review/action UI. Calls
  // existing materialization, preflight, F5 review, reviewed delete, and
  // bookkeeping APIs from explicit operator controls only. No new delete
  // logic, publication, transport, WebDAV, or mobile write-back.
  "sync/delete-convergence-ui.tauri.js",
  // F13.0.1: Desktop/Tauri-only binding identity/cardinality diagnostic.
  // Verifies canonical bindingSubjectId order and reports active membership
  // policy only. No binding, apply, convergence, publication, or transport.
  "sync/binding-identity-cardinality-diagnostic.tauri.js",
  // F13.0.2: Desktop/Tauri-only binding materialization diagnostic. Wraps
  // identity/cardinality and verifies live/tombstone/orphan safety only. No
  // binding, apply, convergence, publication, or transport.
  "sync/binding-materialization-diagnostic.tauri.js",
  // F13.0.3: Desktop/Tauri-only binding convergence preflight. Wraps
  // materialization and validates watermark/replay/consumed safety only. No
  // binding, apply, convergence, publication, or transport.
  "sync/binding-convergence-preflight.tauri.js",
  // F13.0.4: Desktop/Tauri-only binding proposal candidate generator. Emits
  // generated binding-add proposal candidates only. No binding, apply,
  // publication, convergence, transport, or mobile write-back.
  "sync/binding-proposal-candidate-generator.tauri.js",
  // F13.0.5a: Desktop/Tauri-only reviewed binding-add apply. Consumes one
  // generated binding proposal candidate and inserts one local binding plus
  // audit row only. No applyEvent, bookkeeping, publication, or transport.
  "sync/binding-reviewed-apply.tauri.js",
  // F13.0.5b: Desktop/Tauri-only binding applyEvent receipt builder. Emits
  // redacted applyEvent receipts only after successful reviewed binding add.
  // No binding, bookkeeping, publication, transport, or mobile write-back.
  "sync/binding-apply-event.tauri.js",
  // F13.0.6: Desktop/Tauri-only binding convergence bookkeeping. Builds the
  // binding applyEvent receipt, records consumed operation + watermark only.
  // No binding, publication, transport, or mobile write-back.
  "sync/binding-convergence-bookkeeping.tauri.js",
  // F13.0.6: Desktop/Tauri-only binding convergence proof harness.
  // Orchestrates existing binding diagnostics/action/bookkeeping APIs only.
  // No new binding behavior, publication, transport, or mobile write-back.
  "sync/binding-convergence-proof.tauri.js",
  // F13.0.7: Desktop/Tauri-only binding convergence review/action UI. Calls
  // existing identity, materialization, preflight, reviewed bind-add, and
  // bookkeeping APIs from explicit operator controls only. No new binding
  // logic, publication, transport, WebDAV, or mobile write-back.
  "sync/binding-convergence-ui.tauri.js",
  // Desktop-only: debug F7.4.3 folder color apply validation harness. Dormant
  // until manually invoked through H2O.Studio.devValidation.
  "dev/f7-folder-color-apply-validation.tauri.js",
  // Dev-only: gated local folder sync RC smoke registry. Disabled unless
  // explicit URL + localStorage opt-in gates pass; no runner or file queue.
  "dev/folder-sync-rc-smoke-bridge.studio.js",
  // Desktop-only: gated local folder sync RC smoke file-command queue. Reads
  // only .h2o-smoke/desktop-command.json and dispatches through the registry.
  "dev/folder-sync-rc-smoke-desktop-queue.tauri.js",
  // F1B: hidden/gated readiness runner. Mounts only when BOTH
  //   H2O.flags.experimentalMultiPeer === true AND
  //   location.hash === '#/dev/multi-peer-readiness'
  // are true. Counts-only DOM render; no writes; no sample content.
  "sync/multi-peer-runner.js",

  "S1A1a. 🎬 MiniMap Kernel - Studio.js",
  "S1A1f. 🎬 MiniMap Views - Studio.js",
  "S1A1e. 🎬 MiniMap Skin - Studio.js",
  "S1A1d. 🎬 MiniMap Shell - Studio.js",
  "S1A1b. 🎬 MiniMap Core - Studio.js",
  "S1A1c. 🎬 MiniMap Engine - Studio.js",

  "S3H1a. 🎬 Highlights Engine - Studio.js",
  "S1A3a. 🎬 Highlight Dots - Studio.js",
  "S1A2a. 🎬 Answer Wash Engine - Studio.js",
  "S1C1a. 🎬 Turn Title Bar - Studio.js",

  "S2A1a. 🎬 Question Wrapper - Studio.js",
  "S2B1a. 🎬 Quote Tracker - Studio.js",
  "S2C1a. 🎬 Question Wash Engine - Studio.js",

  "S1Z1a. 🎬 Answer Timestamp - Studio.js",
  "S2Z1a. 🎬 Question Timestamp - Studio.js",
  "S1X1a. 🎬 Answer Numbers - Studio.js",

  // Library subsystem (Studio) — must match the <script> tag order in studio.html.
  // studio.html references these by filename; if any are missing from the bundle
  // the browser silently 404s the <script> tag and H2O.LibraryCore/etc. remain
  // undefined. Keep this list in lockstep with studio.html.
  "S0F0a. 🎬 Library Surface Host - Studio.js",
  // Phase 2A — shared registry core. Must load before any Library feature
  // owner so H2O.Library.RegistryCore is available when S0F1g sanitizes its
  // first record. Same index position in the OUT list.
  "S0F0c. 🎬 Library Registry Core - Studio.js",
  // Phase 2B — shared library-index core. Must load before S0F1c so the
  // shared module is available when Library Index hydrates/normalizes its
  // first row. Same index position in the OUT list.
  "S0F0d. 🎬 Library Index Core - Studio.js",
  // Phase 3B — shared folder-provider core. Must load before later folder
  // delegation phases. Same index position in the OUT list.
  "S0F0e. 🎬 Folder Provider Core - Studio.js",
  // Phase 4B — shared category-provider core. Must load before later category
  // delegation phases. Same index position in the OUT list.
  "S0F0f. 🎬 Category Provider Core - Studio.js",
  // Phase 5B — shared tag-provider core. Must load before later tag
  // delegation phases. Same index position in the OUT list.
  "S0F0g. 🎬 Tag Provider Core - Studio.js",
  // Phase 5C — shared label-provider core. Must load before later label
  // delegation phases. Same index position in the OUT list.
  "S0F0h. 🎬 Label Provider Core - Studio.js",
  // Phase 6B — shared project-provider core. Must load before later project
  // delegation phases. Same index position in the OUT list.
  "S0F0i. 🎬 Project Provider Core - Studio.js",
  // Phase 7B — shared LibraryActionsCore. Must load before later LibraryActions
  // facade delegation phases. Same index position in the OUT list.
  "S0F0j. 🎬 Library Actions Core - Studio.js",
  "S0F1a. 🎬 Library Core - Studio.js",
  "S0F1e. 🎬 Library Store - Studio.js",
  "S0F1g. 🎬 Chat Registry - Studio.js",
  "S0F1c. 🎬 Library Index - Studio.js",
  // Phase 7D — Studio LibraryActions facade. Must load after core/registry/index
  // and before command/feature consumers. Same index position in the OUT list.
  "S0F1j. 🎬 Library Actions - Studio.js",
  "S0F2a. 🎬 Projects - Studio.js",
  "S0F3a. 🎬 Folders - Studio.js",
  "S0F3b. 🎬 Folders Actions - Studio.js",
  "S0F4a. 🎬 Categories - Studio.js",
  "S0F4b. 🎬 Categories Actions - Studio.js",
  "S0F5a. 🎬 Tags - Studio.js",
  "S0F5b. 🎬 Tags Actions - Studio.js",
  "S0F6a. 🎬 Labels - Studio.js",
  "S0F6b. 🎬 Labels Actions - Studio.js",
  "S0F1b. 🎬 Library Workspace - Studio.js",
  "S0F1d. 🎬 Library Insights - Studio.js",
  "S0F1f. 🎬 Library Maintenance - Studio.js",
  "S0F1h. 🎬 Library Sync - Studio.js",
  // F10.4: read-only Settings card for the F10.3 bundle-envelope preview
  // diagnostic. Mounts a sibling card after #wbSettingsSyncBox in
  // Settings → Local Sync. Operator-triggered; no Apply / Merge / Sync
  // Now / Proposal buttons; no chrome.storage write, no chrome.runtime
  // broadcast, no folder-import call.
  "S0F1i. 🎬 Cross-Platform Envelope Preview - Studio.js",
  // Phase 1 — canonical services + H2O.flags. Loads after every feature owner
  // so canonical aliases resolve to real impls on the first registration pass.
  "S0F1k. 🎬 Library Canonical Services - Studio.js",
  // R4.5.1.a — Desktop-first folder organization modals (folders only in this
  // slice; categories / labels / tags follow in R4.5.2 / R4.5.3). Tauri-gated;
  // silent no-op on MV3. Calls H2O.Studio.actions.folders.* — no SQLite / no
  // Native folder APIs.
  "S0F1m. 🎬 Library Organization Modals - Studio.js",
  // R4.5.4 — Desktop-first multi-select batch toolbar. Tauri-gated;
  // silent no-op on MV3. Composes H2O.LibraryActions.* (setFolder /
  // setCategory / addLabel / addTag) into batch operations over N
  // selected chats via Promise.all. Refresh strategy: rely on S0F1c
  // in-flight guard to collapse per-action dispatches + emit one final
  // refresh with reason 'batch-toolbar:<op>:<count>'. No SQLite, no
  // Native APIs, no ChatGPT DOM observation.
  "S0F1n. 🎬 Library Batch Toolbar - Studio.js",
  "S0X1a. 🎬 Command Bar - Studio.js",
  "S0X1b. 🎬 Library Commands (Command Bar 🔌 Plugin) - Studio.js",
  "S0Z1f. 🎬 Library Sidebar Tab - Studio.js",
  "S0Z1g. 🎬 Library Sidebar Sections - Studio.js",

  // Studio Ribbon visible surface module. Loads after core reader/router
  // surfaces so it can observe reader context without owning it.
  "S0Y1a. 🎬 Studio Ribbon - Studio.js",

  // Standalone Studio decorations referenced by studio.html.
  "S9D1a. 🎬 Auto Emoji Title - Studio.js",

  // Reader & Notes — MVP-A1.1 read-only library-item view (flag-gated, default
  // off). Keep parallel to ARCHIVE_WORKBENCH_OUT_FILES below.
  "reader-notes/library-item-view.studio.js",

  // Reader & Notes — MVP-A1.2 read-only annotation façade (notes + bookmarks,
  // flag-gated, default off). Keep parallel to ARCHIVE_WORKBENCH_OUT_FILES below.
  "reader-notes/annotation-facade.studio.js",

  // Reader & Notes — MVP-A2a.3 inert runtime exposure for the read-only anchor
  // resolver core and DOM wrapper. Flag-gated, default off; no consumers here.
  "reader-notes/anchor-resolver.studio.js",
  "reader-notes/anchor-resolver-dom.studio.js",

  // Reader & Notes — MVP-A2a.4.2 read-only highlight resolution consumer
  // (explicit invocation only, flag-gated, default off). Keep parallel to
  // ARCHIVE_WORKBENCH_OUT_FILES below.
  "reader-notes/highlight-resolution-consumer.studio.js",

  // Reader & Notes — MVP-A2a.5 operator-only read-only reader-root resolution
  // probe (no rendering, flag-gated + opt-in, default off). Keep parallel to
  // ARCHIVE_WORKBENCH_OUT_FILES below.
  "reader-notes/highlight-resolution-ui.studio.js",

  // Reader & Notes — NV1 read-only annotation report consumer (non-visual,
  // flag-gated + opt-in, default off). Keep parallel to
  // ARCHIVE_WORKBENCH_OUT_FILES below.
  "reader-notes/annotation-report.studio.js",
]);
export const ARCHIVE_WORKBENCH_OUT_FILES = Object.freeze([
  "studio.html",
  "studio.css",
  "studio.js",
  "S0D3e. 🎬 Transcript Studio Host - Studio.js",

  "S0A2a. 🎬 Observer Hub - Studio.js",
  "S0A1a. 🎬 H2O Core - Studio.js",

  // Studio Platform Adapter — see SOURCE_FILES list above for context.
  "platform/index.js",
  "platform/platform.mv3.js",
  "platform/platform.tauri.js",
  "platform/selectors.contract.js",

  // Dock Panel shell — see SOURCE_FILES list above for context.
  "dock/dock-keys.js",
  "dock/dock-shell.studio.js",

  // Dock Panel read-only tab modules — see SOURCE_FILES list above.
  "dock/tabs/highlights.tab.studio.js",
  "dock/tabs/bookmarks.tab.studio.js",
  "dock/tabs/notes.tab.studio.js",
  "dock/tabs/attachments.tab.studio.js",
  "dock/tabs/navigator.tab.studio.js",
  "dock/tabs/context.tab.studio.js",
  "dock/tabs/capture.tab.studio.js",
  "dock/tabs/finder.tab.studio.js",

  // Studio Ribbon shell — see SOURCE_FILES list above for context.
  "ribbon/ribbon-keys.js",
  "ribbon/ribbon-shell.studio.js",

  // Studio Edit Overlay — see SOURCE_FILES list above for context.
  "overlay/overlay-keys.js",
  "overlay/overlay-applier.studio.js",
  "overlay/overlay-serializer.studio.js",
  "overlay/overlay-docx-writer.studio.js",

  // Studio Appearance / View Options — see SOURCE_FILES list above.
  "appearance/appearance-keys.js",
  "appearance/appearance-store.studio.js",
  "appearance/appearance-panel.studio.js",

  // Studio Store — see SOURCE_FILES list above for context.
  "store/index.js",
  "store/highlights.js",
  "store/editOverlay.js",
  // Dock Panel read-only feature store façades (Phase 1b-1e). See SOURCE_FILES.
  "store/prefs.js",
  "store/context.js",
  "store/bookmarks.js",
  "store/notes.js",
  "store/navigator.js",
  "store/capture.js",
  "store/libraryIndex.js",
  "store/chats.tauri.js",
  "store/snapshots.tauri.js",
  "store/assets.tauri.js",
  "store/folders.tauri.js",
  "store/labels.tauri.js",
  "store/tags.tauri.js",
  "store/categories.tauri.js",
  "store/tombstones.tauri.js",
  "store/tombstone-reviews.tauri.js",
  "store/conflicts.tauri.js",
  "dev/f6-final-validation.tauri.js",
  "store/tombstone-reviews.mv3.js",
  "ingestion/import-bundle.tauri.js",
  "ingestion/export-bundle.tauri.js",
  "platform/html-sanitizer.js",
  "renderer/chat-renderer.studio.js",
  "ingestion/saved-chat-package-codec.tauri.js",
  "ingestion/saved-chat-portable-zip.studio.js",
  "ingestion/saved-chat-package-v1.tauri.js",
  "ingestion/asset-cas.tauri.js",
  "ingestion/saved-chat-package-assets.tauri.js",
  "ingestion/saved-chat-generation-publisher.tauri.js",
  "ingestion/saved-chat-generation-policy.tauri.js",
  "ingestion/saved-chat-projection-probe.tauri.js",
  "ingestion/saved-chat-coverage.tauri.js",
  "ingestion/saved-chat-archive-diagnostics.tauri.js",
  "ingestion/saved-chat-archive-presentation.studio.js",
  "ingestion/saved-chat-archive-request-builder.mv3.js",
  "ingestion/saved-chat-archive-request-delivery.mv3.js",
  "ingestion/saved-chat-archive-on-save.mv3.js",
  "ingestion/saved-chat-archive-status.studio.js",
  "ingestion/saved-chat-archive-status-badge.studio.js",
  "ingestion/saved-chat-archive-requests.tauri.js",
  "ingestion/saved-chat-archive-request-inbox.tauri.js",
  "ingestion/saved-chat-archive-materializer-action.studio.js",
  "ingestion/saved-chat-archive-inspector.studio.js",
  "ingestion/saved-chat-archive-importer.studio.js",
  "ingestion/saved-chat-portable-package-verification.tauri.js",
  "ingestion/saved-chat-archive-exporter.studio.js",
  "ingestion/saved-chat-archive-restore.studio.js",
  "ingestion/saved-chat-archive-relink.studio.js",
  "ingestion/saved-chat-archive-materializer.tauri.js",
  "ingestion/saved-chat-reclamation-ui.studio.js",
  "ingestion/saved-chat-archive-integrity.tauri.js",
  "ingestion/saved-chat-archive-renderer-hygiene.js",
  "ingestion/saved-chat-archive-health-composition.js",
  "ingestion/saved-chat-archive-health-mapping.js",
  // Saved Chat Recovery Center timeline surface. New-UI-only, read-only
  // per-chat version timeline; composes trusted integrity, the canonical
  // partition, coverage and the read-only inspector. No ordering, hashing,
  // validity, classification or recovery-eligibility authority; no mutation.
  "ingestion/saved-chat-recovery-center-ui.studio.js",
  "ingestion/archive-health-ui.studio.js",
  // Chrome: saved-chat archive request delivery UI (Phase D.3C.2). Minimal
  // manual Settings utility card wiring the D.3C.1 delivery APIs under an
  // explicit click. No automatic delivery, no read-back, no Desktop runtime,
  // sync, CAS, package writer, queue/materializer call, or Archive Health UI.
  "ingestion/saved-chat-archive-request-delivery-ui.studio.js",
  "sync/kernel/privacy-scan.tauri.js",
  "sync/kernel/identity-kit.tauri.js",
  "sync/kernel/blockers.tauri.js",
  "sync/kernel/result-shape.tauri.js",
  "sync/kernel/watermark-service.tauri.js",
  "sync/kernel/consumed-op.tauri.js",
  "sync/kernel/tombstone-reader.tauri.js",
  "sync/kernel/publication-kit.tauri.js",
  "sync/kernel/replay-composer.tauri.js",
  "sync/kernel/owner-handoff.tauri.js",
  "sync/kernel/lifecycle-framework.tauri.js",
  "sync/kernel/audit-proof-framework.tauri.js",
  "sync/library/library-catalog-canonicalizer.tauri.js",
  "sync/library/library-binding-canonicalizer.tauri.js",
  "sync/library/library-catalog-diagnostics.tauri.js",
  "sync/library/library-binding-diagnostics.tauri.js",
  "sync/library/library-catalog-preflight.tauri.js",
  "sync/library/library-binding-preflight.tauri.js",
  "sync/library/library-catalog-proposal-candidate-generator.tauri.js",
  "sync/library/library-binding-proposal-candidate-generator.tauri.js",
  "sync/library/library-catalog-handoff-preview.tauri.js",
  "sync/library/library-binding-handoff-preview.tauri.js",
  "sync/library/library-catalog-apply-event-receipt.tauri.js",
  "sync/library/library-binding-apply-event-receipt.tauri.js",
  "sync/library/library-catalog-bookkeeping.tauri.js",
  "sync/library/library-binding-bookkeeping.tauri.js",
  "sync/chat/chat-canonicalizer.tauri.js",
  "sync/chat/chat-diagnostics.tauri.js",
  "sync/chat/chat-convergence-preflight.tauri.js",
  "sync/chat/chat-archive-proposal-candidate-generator.tauri.js",
  "sync/chat/chat-rename-proposal-candidate-generator.tauri.js",
  "sync/chat/chat-native-handoff-preview.tauri.js",
  "sync/chat/chat-apply-event-receipt.tauri.js",
  "sync/chat/chat-convergence-bookkeeping.tauri.js",
  "sync/chat/chat-convergence-proof.tauri.js",
  "sync/chat/chat-convergence-ui.tauri.js",
  "sync/snapshot/snapshot-canonicalizer.tauri.js",
  "sync/snapshot/snapshot-diagnostics.tauri.js",
  "sync/snapshot/snapshot-convergence-preflight.tauri.js",
  "sync/snapshot/snapshot-archive-proposal-candidate-generator.tauri.js",
  "sync/snapshot/snapshot-tombstone-proposal-candidate-generator.tauri.js",
  "sync/snapshot/snapshot-restore-proposal-candidate-generator.tauri.js",
  "sync/snapshot/snapshot-native-archive-handoff-preview.tauri.js",
  "sync/snapshot/snapshot-f5-tombstone-handoff-preview.tauri.js",
  "sync/snapshot/snapshot-restore-handoff-preview.tauri.js",
  "sync/snapshot/snapshot-archive-apply-event-receipt.tauri.js",
  "sync/snapshot/snapshot-tombstone-apply-event-receipt.tauri.js",
  "sync/snapshot/snapshot-restore-apply-event-receipt.tauri.js",
  "sync/snapshot/snapshot-convergence-bookkeeping.tauri.js",
  "sync/snapshot/snapshot-convergence-proof.tauri.js",
  "sync/snapshot/snapshot-convergence-ui.tauri.js",
  "sync/snapshot/snapshot-f5-review-queue.tauri.js",
  "sync/snapshot/snapshot-f5-review-queue-proof.tauri.js",
  "sync/snapshot/snapshot-f5-review-panel.tauri.js",
  "sync/snapshot/snapshot-execute-readiness.tauri.js",
  "sync/capture/capture-fresh-runtime.tauri.js",
  "sync/capture/capture-recovery-runtime.tauri.js",
  "sync/execute/execute-journal.tauri.js",
  "sync/execute/execute-envelope.tauri.js",
  "sync/execute/execute-preflight-gate.tauri.js",
  "sync/execute/execute-publication-lifecycle.tauri.js",
  "sync/execute/execute-relay-broker.tauri.js",
  "sync/execute/execute-native-broker.tauri.js",
  "sync/execute/execute-f5-broker.tauri.js",
  "sync/execute/execute-settlement-writer.tauri.js",
  "sync/sqlite-writer-identity-sentinel.tauri.js",
  "sync/execute/execute-settlement-writer-library-extension.tauri.js",
  "sync/execute/library-category-cache-refresh.tauri.js",
  "sync/execute/library-catalog-f5-closure-bridge.tauri.js",
  "sync/library/library-bulk-migration.tauri.js",
  "sync/library/library-store-cutover-shims.tauri.js",
  "sync/execute/execute-resume-on-boot.tauri.js",
  "sync/execute/adapters/chat-execute-adapter.tauri.js",
  "sync/execute/execute-capture-materialization.tauri.js",
  "sync/execute/adapters/capture-execute-adapter.tauri.js",
  "sync/execute/adapters/snapshot-execute-adapter.tauri.js",
  "sync/execute/adapters/snapshot-tombstone-execute-adapter.tauri.js",
  "sync/execute/adapters/library-catalog-execute-adapter.tauri.js",
  "sync/execute/adapters/library-binding-execute-adapter.tauri.js",
  "sync/library/library-sync-proof.tauri.js",
  "sync/library/library-conflict-runtime.tauri.js",
  "sync/library/library-multipeer-soak-proof.tauri.js",
  "sync/library/library-performance-stress-proof.tauri.js",
  "sync/library/library-chrome-desktop-parity-diagnostic.js",
  "sync/library/library-metadata-export-projection.tauri.js",
  "sync/library/library-metadata-diagnostics.js",
  "sync/library/library-sync-operator-ui.tauri.js",
  "sync/library/library-folder-binding-bridge-diagnostic.tauri.js",
  "sync/library/library-folder-binding-migration-shadow.tauri.js",
  "sync/execute/execute-lane-ui.tauri.js",
  "sync/folder-sync.tauri.js",
  "sync/auto-export.tauri.js",
  "sync/focus-import.tauri.js",
  "sync/folder-import.mv3.js",
  "sync/auto-import.mv3.js",
  "sync/bundle-envelope-preview.mv3.js",
  "sync/capture-evidence-preview.mv3.js",
  "sync/folder-sync-canonical.js",
  "sync/folder-sync-diff.js",
  "sync/folder-sync-proposal-preview.mv3.js",
  "sync/folder-sync-conflict-report.js",
  "sync/peer-identity.js",
  "sync/export-log.js",
  "sync/peer-transport.js",
  "sync/webdav-transport-gates.js",
  "sync/relay-idempotency-restart-proof-harness.js",
  "sync/real-transport-target-config.js",
  "sync/real-transport-kill-switch.js",
  "sync/real-transport-idempotency.js",
  "sync/real-transport-enqueue-boundary.js",
  "sync/real-transport-conflict-recovery.js",
  "sync/real-transport-sequence-export.js",
  "sync/real-transport-approval.js",
  "sync/real-transport-readiness.js",
  "sync/real-transport-dry-run.js",
  "sync/real-transport-console.js",
  "sync/real-transport-first-write-preflight.js",
  "sync/webdav-transport-setup-ui.tauri.js",
  "sync/peer-discovery.js",
  "sync/peer-watermarks.js",
  "sync/multi-peer-diff.js",
  "sync/bidirectional-folder-preview.js",
  "sync/folder-metadata-apply-plan.js",
  "sync/folder-metadata-apply-checks.tauri.js",
  "sync/folder-color-apply.tauri.js",
  "sync/folder-apply-event.tauri.js",
  "sync/relay-outbox.tauri.js",
  "sync/relay-inbox.tauri.js",
  "sync/webdav-relay.tauri.js",
  "sync/relay-index.tauri.js",
  "sync/manual-sync-ui.tauri.js",
  "sync/convergence-readiness.tauri.js",
  "sync/remote-envelope-projector.tauri.js",
  "sync/convergence-planner.tauri.js",
  "sync/convergence-review-ui.tauri.js",
  "sync/convergence-proposal-generator.tauri.js",
  "sync/convergence-conflict-candidate-generator.tauri.js",
  "sync/publication-ledger.tauri.js",
  "sync/proposal-publication.tauri.js",
  "sync/conflict-publication.tauri.js",
  "sync/convergence-watermarks.tauri.js",
  "sync/consumed-operation-ledger.tauri.js",
  "sync/convergence-preflight.tauri.js",
  "sync/color-convergence-action.tauri.js",
  "sync/convergence-bookkeeping.tauri.js",
  "sync/convergence-action-ui.tauri.js",
  "sync/rename-materialization-diagnostic.tauri.js",
  "sync/rename-convergence-preflight.tauri.js",
  "sync/rename-proposal-candidate-generator.tauri.js",
  "sync/rename-convergence-action.tauri.js",
  "sync/rename-apply-event.tauri.js",
  "sync/rename-convergence-bookkeeping.tauri.js",
  "sync/rename-convergence-ui.tauri.js",
  "sync/rename-convergence-proof.tauri.js",
  "sync/move-materialization-diagnostic.tauri.js",
  "sync/move-convergence-preflight.tauri.js",
  "sync/move-proposal-candidate-generator.tauri.js",
  "sync/move-convergence-action.tauri.js",
  "sync/move-apply-event.tauri.js",
  "sync/move-convergence-bookkeeping.tauri.js",
  "sync/move-convergence-proof.tauri.js",
  "sync/move-convergence-ui.tauri.js",
  "sync/delete-materialization-diagnostic.tauri.js",
  "sync/delete-convergence-preflight.tauri.js",
  "sync/delete-proposal-candidate-generator.tauri.js",
  "sync/delete-f5-handoff-preview.tauri.js",
  "sync/delete-f5-review-row.tauri.js",
  "sync/delete-reviewed-apply.tauri.js",
  "sync/delete-apply-event.tauri.js",
  "sync/delete-convergence-bookkeeping.tauri.js",
  "sync/delete-convergence-proof.tauri.js",
  "sync/delete-convergence-ui.tauri.js",
  "sync/binding-identity-cardinality-diagnostic.tauri.js",
  "sync/binding-materialization-diagnostic.tauri.js",
  "sync/binding-convergence-preflight.tauri.js",
  "sync/binding-proposal-candidate-generator.tauri.js",
  "sync/binding-reviewed-apply.tauri.js",
  "sync/binding-apply-event.tauri.js",
  "sync/binding-convergence-bookkeeping.tauri.js",
  "sync/binding-convergence-proof.tauri.js",
  "sync/binding-convergence-ui.tauri.js",
  "dev/f7-folder-color-apply-validation.tauri.js",
  "dev/folder-sync-rc-smoke-bridge.studio.js",
  "dev/folder-sync-rc-smoke-desktop-queue.tauri.js",
  "sync/multi-peer-runner.js",

  "S1A1a. 🎬 MiniMap Kernel - Studio.js",
  "S1A1f. 🎬 MiniMap Views - Studio.js",
  "S1A1e. 🎬 MiniMap Skin - Studio.js",
  "S1A1d. 🎬 MiniMap Shell - Studio.js",
  "S1A1b. 🎬 MiniMap Core - Studio.js",
  "S1A1c. 🎬 MiniMap Engine - Studio.js",

  "S3H1a. 🎬 Highlights Engine - Studio.js",
  "S1A3a. 🎬 Highlight Dots - Studio.js",
  "S1A2a. 🎬 Answer Wash Engine - Studio.js",
  "S1C1a. 🎬 Turn Title Bar - Studio.js",

  "S2A1a. 🎬 Question Wrapper - Studio.js",
  "S2B1a. 🎬 Quote Tracker - Studio.js",
  "S2C1a. 🎬 Question Wash Engine - Studio.js",

  "S1Z1a. 🎬 Answer Timestamp - Studio.js",
  "S2Z1a. 🎬 Question Timestamp - Studio.js",
  "S1X1a. 🎬 Answer Numbers - Studio.js",

  // Library subsystem (Studio). Out filenames are identical to source filenames —
  // studio.html references them by the same name and copyFileSync preserves them.
  // Keep this list in lockstep with ARCHIVE_WORKBENCH_SOURCE_FILES above
  // (the syncArchiveWorkbenchToOut copy is index-paired).
  "S0F0a. 🎬 Library Surface Host - Studio.js",
  "S0F0c. 🎬 Library Registry Core - Studio.js",
  "S0F0d. 🎬 Library Index Core - Studio.js",
  "S0F0e. 🎬 Folder Provider Core - Studio.js",
  "S0F0f. 🎬 Category Provider Core - Studio.js",
  "S0F0g. 🎬 Tag Provider Core - Studio.js",
  "S0F0h. 🎬 Label Provider Core - Studio.js",
  "S0F0i. 🎬 Project Provider Core - Studio.js",
  "S0F0j. 🎬 Library Actions Core - Studio.js",
  "S0F1a. 🎬 Library Core - Studio.js",
  "S0F1e. 🎬 Library Store - Studio.js",
  "S0F1g. 🎬 Chat Registry - Studio.js",
  "S0F1c. 🎬 Library Index - Studio.js",
  "S0F1j. 🎬 Library Actions - Studio.js",
  "S0F2a. 🎬 Projects - Studio.js",
  "S0F3a. 🎬 Folders - Studio.js",
  "S0F3b. 🎬 Folders Actions - Studio.js",
  "S0F4a. 🎬 Categories - Studio.js",
  "S0F4b. 🎬 Categories Actions - Studio.js",
  "S0F5a. 🎬 Tags - Studio.js",
  "S0F5b. 🎬 Tags Actions - Studio.js",
  "S0F6a. 🎬 Labels - Studio.js",
  "S0F6b. 🎬 Labels Actions - Studio.js",
  "S0F1b. 🎬 Library Workspace - Studio.js",
  "S0F1d. 🎬 Library Insights - Studio.js",
  "S0F1f. 🎬 Library Maintenance - Studio.js",
  "S0F1h. 🎬 Library Sync - Studio.js",
  "S0F1i. 🎬 Cross-Platform Envelope Preview - Studio.js",
  "S0F1k. 🎬 Library Canonical Services - Studio.js",
  "S0F1m. 🎬 Library Organization Modals - Studio.js",
  "S0F1n. 🎬 Library Batch Toolbar - Studio.js",
  "S0X1a. 🎬 Command Bar - Studio.js",
  "S0X1b. 🎬 Library Commands (Command Bar 🔌 Plugin) - Studio.js",
  "S0Z1f. 🎬 Library Sidebar Tab - Studio.js",
  "S0Z1g. 🎬 Library Sidebar Sections - Studio.js",

  // Studio Ribbon visible surface module — see SOURCE_FILES list above.
  "S0Y1a. 🎬 Studio Ribbon - Studio.js",

  // Standalone Studio decorations referenced by studio.html.
  "S9D1a. 🎬 Auto Emoji Title - Studio.js",

  // Reader & Notes — MVP-A1.1 read-only library-item view — see SOURCE_FILES.
  "reader-notes/library-item-view.studio.js",

  // Reader & Notes — MVP-A1.2 read-only annotation façade — see SOURCE_FILES.
  "reader-notes/annotation-facade.studio.js",

  // Reader & Notes — MVP-A2a.3 inert anchor resolver exposure — see SOURCE_FILES.
  "reader-notes/anchor-resolver.studio.js",
  "reader-notes/anchor-resolver-dom.studio.js",

  // Reader & Notes — MVP-A2a.4.2 highlight resolution consumer — see SOURCE_FILES.
  "reader-notes/highlight-resolution-consumer.studio.js",

  // Reader & Notes — MVP-A2a.5 reader-root resolution probe — see SOURCE_FILES.
  "reader-notes/highlight-resolution-ui.studio.js",

  // Reader & Notes — NV1 annotation report consumer — see SOURCE_FILES.
  "reader-notes/annotation-report.studio.js",
]);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function assertArchiveWorkbenchPacklistParity() {
  if (ARCHIVE_WORKBENCH_SOURCE_FILES.length !== ARCHIVE_WORKBENCH_OUT_FILES.length) {
    throw new Error(
      `archive workbench packlist mismatch: source=${ARCHIVE_WORKBENCH_SOURCE_FILES.length} out=${ARCHIVE_WORKBENCH_OUT_FILES.length}`,
    );
  }
  for (let index = 0; index < ARCHIVE_WORKBENCH_SOURCE_FILES.length; index += 1) {
    const sourceName = ARCHIVE_WORKBENCH_SOURCE_FILES[index];
    const outName = ARCHIVE_WORKBENCH_OUT_FILES[index];
    if (!sourceName || typeof sourceName !== "string" || !outName || typeof outName !== "string") {
      throw new Error(`archive workbench packlist invalid at index ${index}: source=${sourceName} out=${outName}`);
    }
  }
}

function removeFileIfPresent(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    throw error;
  }
}

function tryRemoveEmptyDir(dirPath) {
  try {
    if (!fs.statSync(dirPath).isDirectory()) return false;
  } catch {
    return false;
  }
  try {
    if ((fs.readdirSync(dirPath) || []).length > 0) return false;
    fs.rmdirSync(dirPath);
    return true;
  } catch {
    return false;
  }
}

export function archiveWorkbenchSourceDir(srcRoot) {
  return path.join(String(srcRoot || ""), ARCHIVE_WORKBENCH_SOURCE_REL);
}

export function getArchiveWorkbenchSourcePresence(srcRoot) {
  const dir = archiveWorkbenchSourceDir(srcRoot);
  return ARCHIVE_WORKBENCH_SOURCE_FILES.filter((name) => fileExists(path.join(dir, name)));
}

/* ── studio.html <script src> drift guard ──────────────────────────────────
 * studio.html loads feature modules via <script src="./…"> tags. Every LOCAL
 * ref must also appear in ARCHIVE_WORKBENCH_SOURCE_FILES so the pack step
 * copies it into the Chrome/Tauri build; a ref absent from the allowlist is
 * silently dropped and 404s only at runtime (this historically bit the overlay
 * export modules and the dock/tabs modules). These helpers let dev:check fail
 * such drift automatically. Directional by design: studio.html refs MUST be
 * packed, but allowlist entries not referenced by studio.html (studio.css,
 * desktop-only *.tauri.js adapters loaded by other means, etc.) are NOT
 * flagged. */

/* Pure: extract normalized LOCAL <script src> refs from an HTML string.
 * Strips a leading "./" and any "?query"; skips non-local schemes
 * (http(s):, protocol-relative //, chrome-extension:, data:) and inline
 * <script> blocks (no src). */
export function parseStudioHtmlScriptRefs(html) {
  const out = [];
  const re = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(String(html || ""))) !== null) {
    let ref = String(m[1] || "").trim();
    if (!ref) continue;
    if (/^(https?:|\/\/|chrome-extension:|data:)/i.test(ref)) continue; /* non-local */
    ref = ref.replace(/^\.\//, "").replace(/\?.*$/, ""); /* strip ./ and ?query */
    if (ref) out.push(ref);
  }
  return out;
}

/* Pure: sorted, de-duplicated refs present in `html`'s <script src> tags but
 * absent from `allowlist`. */
export function studioHtmlRefsMissingFrom(html, allowlist) {
  const allow = new Set(allowlist || []);
  const missing = new Set();
  for (const ref of parseStudioHtmlScriptRefs(html)) {
    if (!allow.has(ref)) missing.add(ref);
  }
  return Array.from(missing).sort();
}

/* Disk: read <srcRoot>/<ARCHIVE_WORKBENCH_SOURCE_REL>/studio.html and return
 * the sorted local <script src> refs missing from the pack allowlist. Throws
 * if studio.html cannot be read (a missing studio.html is itself a failure). */
export function studioHtmlMissingFromAllowlist(srcRoot) {
  const htmlPath = path.join(archiveWorkbenchSourceDir(srcRoot), "studio.html");
  return studioHtmlRefsMissingFrom(readText(htmlPath), ARCHIVE_WORKBENCH_SOURCE_FILES);
}

export function archiveWorkbenchOutDir(outDir) {
  return path.join(String(outDir || ""), "surfaces", "studio");
}

export function getArchiveWorkbenchPresence(outDir) {
  assertArchiveWorkbenchPacklistParity();
  const dir = archiveWorkbenchOutDir(outDir);
  return ARCHIVE_WORKBENCH_OUT_FILES.filter((name) => fileExists(path.join(dir, name)));
}

export function compareArchiveWorkbenchToSource(srcRoot, outDir) {
  assertArchiveWorkbenchPacklistParity();
  const sourceDir = archiveWorkbenchSourceDir(srcRoot);
  const outWorkbenchDir = archiveWorkbenchOutDir(outDir);
  const files = ARCHIVE_WORKBENCH_SOURCE_FILES.map((sourceName, index) => {
    const outName = ARCHIVE_WORKBENCH_OUT_FILES[index];
    const sourcePath = path.join(sourceDir, sourceName);
    const outPath = path.join(outWorkbenchDir, outName);
    const sourceExists = fileExists(sourcePath);
    const outExists = fileExists(outPath);
    const equal = sourceExists && outExists ? readText(sourcePath) === readText(outPath) : false;
    return {
      name: outName,
      sourceName,
      outName,
      sourcePath,
      outPath,
      sourceExists,
      outExists,
      equal,
    };
  });

  return {
    sourceDir,
    outWorkbenchDir,
    files,
    matches: files.every((item) => item.sourceExists && item.outExists && item.equal),
  };
}

export function syncArchiveWorkbenchToOut(srcRoot, outDir) {
  assertArchiveWorkbenchPacklistParity();
  const sourceDir = archiveWorkbenchSourceDir(srcRoot);
  const outWorkbenchDir = archiveWorkbenchOutDir(outDir);
  const missingSource = ARCHIVE_WORKBENCH_SOURCE_FILES.filter((name) => !fileExists(path.join(sourceDir, name)));
  if (missingSource.length) {
    throw new Error(`archive workbench source missing: ${missingSource.join(", ")}`);
  }

  ensureDir(outWorkbenchDir);
  for (let index = 0; index < ARCHIVE_WORKBENCH_SOURCE_FILES.length; index += 1) {
    const sourceName = ARCHIVE_WORKBENCH_SOURCE_FILES[index];
    const outName = ARCHIVE_WORKBENCH_OUT_FILES[index];
    const outPath = path.join(outWorkbenchDir, outName);
    // Out filenames may now contain subdir segments (e.g. "platform/index.js"
    // for the Studio platform adapter). Ensure each parent dir exists before
    // copy so nested files don't fail with ENOENT.
    ensureDir(path.dirname(outPath));
    fs.copyFileSync(path.join(sourceDir, sourceName), outPath);
  }

  return {
    sourceDir,
    outWorkbenchDir,
    files: ARCHIVE_WORKBENCH_OUT_FILES.slice(),
  };
}

export function removeArchiveWorkbenchFromOut(outDir) {
  assertArchiveWorkbenchPacklistParity();
  const outWorkbenchDir = archiveWorkbenchOutDir(outDir);
  const removed = [];
  for (const name of ARCHIVE_WORKBENCH_OUT_FILES) {
    if (removeFileIfPresent(path.join(outWorkbenchDir, name))) removed.push(name);
  }
  tryRemoveEmptyDir(outWorkbenchDir);
  tryRemoveEmptyDir(path.dirname(outWorkbenchDir));
  return {
    outWorkbenchDir,
    removed,
  };
}
