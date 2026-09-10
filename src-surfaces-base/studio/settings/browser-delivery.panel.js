// Sync Settings M3 — Desktop -> Chrome Browser Delivery presentation.
(() => {
  "use strict";
  const W = typeof globalThis !== "undefined" ? globalThis : window;
  const panels = W.H2O?.Studio?.settings?.domainPanels;
  if (!panels) return;
  const V = panels.view;

  /* Chrome -> Desktop intake, reported exactly as the native authority stated
   * it. A staged fork and a fast-forward admission must never look alike: the
   * operator has to be able to tell, at a glance, that nothing was adopted. */
  const RECEIVE_VERDICT_TEXT = Object.freeze({
    "revision-admitted": "Admitted — accepted-linear",
    "revision-staged-divergent": "Staged as divergent — not adopted",
    "identical-replay": "Identical replay — nothing changed",
    "local-publication-absent": "No publication in the authorized folder",
  });

  function projectLocalReceive(result) {
    if (!result) return [["Chrome intake", "No intake yet"]];
    if (result.ok !== true) {
      return [
        ["Chrome intake", "Blocked"],
        ["Intake blocker", V.valueText(result.errorCode, "unavailable")],
      ];
    }
    return [
      ["Chrome intake", V.valueText(RECEIVE_VERDICT_TEXT[result.verdict] || result.verdict, "unknown")],
      ["Admission disposition", V.valueText(result.admissionDisposition, "Not admitted")],
      ["Intake object", V.valueText(result.objectId, "None")],
      ["Intake revision", V.valueText(result.revisionId, "None")],
      ["Admission reason", V.valueText(result.reason, "None")],
      ["Observation count", String(result.observationCount ?? 0)],
      ["Canonical apply", result.noApply === true ? "Not applied" : "UNEXPECTED"],
      ["Network used", result.noNetwork === true ? "None" : "UNEXPECTED"],
    ];
  }

  function renderLocalReceiveCard(result) {
    const divergent = result?.ok === true && result.divergent === true;
    const tone = divergent
      ? "border:1px solid rgba(245,158,11,.55);background:rgba(245,158,11,.10)"
      : "border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.02)";
    const headline = !result
      ? "No revision received yet"
      : result.ok !== true
        ? `Blocked · ${V.valueText(result.errorCode, "unavailable")}`
        : (RECEIVE_VERDICT_TEXT[result.verdict] || result.verdict);
    const detail = result?.ok === true && result.revisionId
      ? `${V.escapeHtml(result.revisionId)} · ${V.escapeHtml(V.valueText(result.reason, "no reason"))}`
      : "Receive admits the revision Chrome published into the authorized folder. It never applies it to this Studio's own chats.";
    return `<div data-browser-delivery-receive-card="1" style="display:grid;gap:4px;padding:10px 12px;border-radius:10px;${tone}">`
      + `<span style="font-size:12px;opacity:.7">Chrome → Desktop intake</span>`
      + `<span data-browser-delivery-receive-headline="1" style="font-weight:650">${V.escapeHtml(headline)}</span>`
      + `<span style="font-size:12px;opacity:.72">${detail}</span></div>`;
  }

  function projectLineage(result) {
    const value = result || {};
    if (value.ok !== true) return Object.freeze({
      state: "blocked",
      current: "Not available",
      previous: "Not available",
      pending: "Not available",
      chain: "Not available",
      reason: V.valueText(value.errorCode, "Enter an object ID, then read lineage"),
    });
    return Object.freeze({
      state: value.state,
      current: V.valueText(value.currentRevisionId, "None"),
      previous: V.valueText(value.previousRevisionId, "None"),
      pending: V.valueText(value.pendingRevisionId, "None"),
      chain: Array.isArray(value.chain) && value.chain.length ? value.chain.join(" → ") : "No revision produced yet",
      reason: "None",
    });
  }

  function projectAdmission(result) {
    const value = result || {};
    return Object.freeze([
      ["Admission", value.ok === true ? V.valueText(value.verdict, "accepted") : "No receive result"],
      ["Identical replay", value.ok === true ? (value.unchangedNoOp === true ? "Unchanged / no-op" : "No") : "Not checked"],
      ["Observed", V.valueText(value.observedState, "Not checked")],
      ["Apply", V.valueText(value.applyState, "Not checked")],
    ]);
  }

  function permissionText(value) {
    return ({
      "not-checked": "Not checked yet",
      granted: "Granted",
      prompt: "Permission required",
      denied: "Denied",
      unavailable: "Unavailable",
    })[V.clean(value).toLowerCase()] || "Unavailable";
  }

  function blockerText(value) {
    return ({
      "folder-not-connected": "Connect a local folder first.",
      "permission-not-checked": "Check the local folder permission first.",
      "permission-required": "Allow access to the local folder first.",
      "permission-prompt": "Allow access to the local folder first.",
      "permission-denied": "Local folder permission is denied.",
      "permission-unavailable": "Local folder permission is unavailable.",
      "delivery-unavailable": "Browser Delivery is unavailable right now.",
    })[V.clean(value).toLowerCase()] || "Browser Delivery is not ready yet.";
  }

  function projectReceiveAction(capability) {
    const state = capability || {};
    const enabled = state.ready === true;
    return Object.freeze({
      enabled,
      guidance: enabled ? "Receive a revision prepared by Desktop." : blockerText(state.reason),
    });
  }

  function publicationTargetErrorText(value) {
    return ({
      "target-object-missing": "This saved chat is no longer in the archive. Open a saved chat again.",
      "target-revision-missing": "This saved revision is no longer in the archive. Open the saved chat again.",
      "target-revision-moved": "This saved chat has a newer revision. Open it again to publish the current one.",
      "target-invalid": "Open a saved chat first.",
      "target-unverifiable": "The saved-chat archive could not confirm this chat.",
      "local-publication-runtime-unavailable": "Local publication is not available yet.",
    })[V.clean(value).toLowerCase()] || "This publish target could not be confirmed.";
  }

  function publicationErrorText(value) {
    return ({
      "local-publication-runtime-unavailable": "Local publication is not available yet.",
      "local-publication-object-unavailable": "Open a saved chat first.",
      "local-publication-object-id-invalid": "Open a saved chat first.",
      "local-publication-busy": "A publication is already in progress.",
      "local-publication-directory-handle-missing": "Connect a local folder first.",
      "local-publication-readwrite-permission-unavailable": "Folder write permission is unavailable.",
      "local-publication-readwrite-permission-denied": "Folder write permission was not granted.",
      "local-publication-readwrite-permission-lost": "Folder write permission was lost. Try Publish again.",
      "local-publication-writer-identity-unavailable": "Sync identity is not ready.",
      "local-publication-store-unavailable": "The saved-chat archive is not available.",
      "local-publication-target-revision-moved": "This saved chat has a newer revision. Open it again to publish the current one.",
      "local-publication-unsupported-object-shape": "This saved chat cannot be published in the local content-only format.",
      "local-publication-relationship-proof-unavailable": "This saved chat's relationships could not be verified safely.",
      "local-publication-historical-timestamp-unavailable": "The saved revision is missing its original timestamp.",
      "local-publication-provenance-unprovable": "This revision cannot be safely linked to the previous publication.",
      "local-publication-pending-unresolved": "A previous publication must be resolved first.",
      "local-publication-slot-unsafe": "The Desktop publication slot contains an unexpected revision.",
      "local-publication-lane-retired": "This publication lane is retired under P02. Use Publish local revision in Local folder sync.",
      "local-publication-temp-slot-unexplained": "The staged publication slot contains unexpected data.",
      "local-publication-move-unavailable": "This browser cannot safely publish to the connected folder.",
      "local-publication-move-failed": "The publication could not be made visible safely.",
      "local-publication-temp-verification-failed": "The staged publication could not be verified.",
      "local-publication-final-verification-failed": "The published revision could not be verified.",
      "local-publication-write-failed": "The revision could not be published safely.",
    })[V.clean(value).toLowerCase()] || "Local publication is blocked.";
  }

  const TARGET_LABEL_LIMIT = 72;

  // A publication target is only ever shown redacted: a short head/tail of the
  // authoritative object id, never the whole id, never anything derived from
  // storage records, canonical bytes, peer identity, or the folder.
  function redactObjectRef(value) {
    const objectId = V.clean(value);
    if (!objectId) return "";
    return objectId.length <= 14 ? objectId : `${objectId.slice(0, 6)}…${objectId.slice(-4)}`;
  }

  /* ── Publish target selection ───────────────────────────────────────────
   * Browser Delivery owns which saved chat it publishes. Before this, the
   * target was whatever chat happened to be open in Studio, so publishing
   * meant navigating to Library, opening the chat, and coming back — and the
   * target evaporated on reload.
   *
   * The preference is two values: a mode, and the chat the operator named.
   * Auto mode follows the most recently SAVED chat, which is deliberately not
   * the most recently touched one: a row's updatedAt moves when a folder or
   * category is assigned, and the workbench list sorts pinned chats first, so
   * neither answers the question. lastCapturedAt / lastSnapshotId come from
   * the chat index, which only a capture writes. */
  const TARGET_STATE_KEY = "h2o:studio:sync:browser-delivery:target:v1";
  const TARGET_STATE_SCHEMA = "h2o.studio.browser-delivery.target.v1";
  const TARGET_MENU_LIMIT = 10;
  const AUTO_TARGET_STATE = Object.freeze({
    schema: TARGET_STATE_SCHEMA, mode: "auto-latest", explicitObjectId: null,
  });

  /* Anything unreadable, half-written, foreign or from a future version
   * resolves to auto rather than to a chat nobody chose. The key is versioned
   * and the record declares its schema, so a record that does not declare THIS
   * schema is not this contract — its fields only look familiar. */
  function normalizeTargetState(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    if (V.clean(src.schema) !== TARGET_STATE_SCHEMA) return AUTO_TARGET_STATE;
    if (V.clean(src.mode) !== "explicit") return AUTO_TARGET_STATE;
    const explicitObjectId = V.clean(src.explicitObjectId);
    if (!explicitObjectId) return AUTO_TARGET_STATE;
    return Object.freeze({
      schema: TARGET_STATE_SCHEMA, mode: "explicit", explicitObjectId,
    });
  }

  /* Pure. Saved-chat catalog rows → publishable candidates, most recently
   * saved first. A row without both index fields proves no save time and is
   * left out entirely: ordering it by a metadata timestamp would be the exact
   * confusion this selector exists to avoid, and one real save puts it back. */
  function projectTargetCandidates(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const out = [];
    for (const row of list) {
      const objectId = V.clean(row && row.chatId);
      const snapshotId = V.clean(row && row.lastSnapshotId);
      const savedAt = V.clean(row && row.lastCapturedAt);
      if (!objectId || !snapshotId || !savedAt) continue;
      out.push(Object.freeze({
        objectId, snapshotId, savedAt, title: V.clean(row && row.title),
      }));
    }
    /* Newest save wins; identical instants order by snapshot id so repeated
     * reads never disagree. */
    out.sort((a, b) => (
      b.savedAt.localeCompare(a.savedAt) || a.snapshotId.localeCompare(b.snapshotId)
    ));
    return Object.freeze(out);
  }

  function targetLabel(title, objectId) {
    const clean = V.clean(title);
    const label = clean.length > TARGET_LABEL_LIMIT
      ? `${clean.slice(0, TARGET_LABEL_LIMIT - 1).trim()}…`
      : clean;
    return label || `Saved chat ${redactObjectRef(objectId)}`;
  }

  function savedAtText(value) {
    const iso = V.clean(value);
    if (!iso) return "";
    /* The stored instant, minute-resolution, left in UTC: a local rendering
     * would disagree with the timestamps every other Item 10 surface shows. */
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
  }

  /* Pure projection of a resolved candidate (or its absence) into what the
   * card renders and what a click is allowed to publish. */
  function projectSelectedTarget(candidate, mode, reason) {
    if (!candidate) return Object.freeze({
      selected: false,
      objectId: "",
      snapshotId: "",
      label: mode === "explicit" ? "Selected chat unavailable" : "No saved chats available",
      reference: "",
      titled: false,
      mode: mode === "explicit" ? "explicit" : "auto-latest",
      savedAt: "",
      reason: V.clean(reason),
    });
    return Object.freeze({
      selected: true,
      objectId: candidate.objectId,
      snapshotId: candidate.snapshotId,
      label: targetLabel(candidate.title, candidate.objectId),
      reference: redactObjectRef(candidate.objectId),
      titled: !!V.clean(candidate.title),
      mode: mode === "explicit" ? "explicit" : "auto-latest",
      savedAt: candidate.savedAt,
      reason: "",
    });
  }

  // Projects the existing read-only Reader context into what the operator sees.
  // The object authority stays exactly the reader chatId; the title is the same
  // display projection the reader header uses and is informational only. A
  // context without a chat produces a truthful not-selected state rather than a
  // guess. Retained for the Desktop branch and for compatibility; the Chrome
  // publish target is the selector above.
  function projectPublishTarget(readerContext) {
    const context = readerContext || {};
    const objectId = V.clean(context.chatId);
    if (!objectId) return Object.freeze({
      selected: false,
      objectId: "",
      label: "No saved chat is open",
      reference: "",
      titled: false,
    });
    const title = V.clean(context.title);
    const label = title.length > TARGET_LABEL_LIMIT
      ? `${title.slice(0, TARGET_LABEL_LIMIT - 1).trim()}…`
      : title;
    return Object.freeze({
      selected: true,
      objectId,
      label: label || `Saved chat ${redactObjectRef(objectId)}`,
      reference: redactObjectRef(objectId),
      titled: !!label,
    });
  }

  function projectPublishAction(diagnostic, currentObjectId, targetProof, generation) {
    const state = diagnostic || {};
    const objectReady = !!V.clean(currentObjectId);
    // A target the archive cannot still confirm never reaches the writer.
    const targetProven = !targetProof || targetProof.ok === true;
    /* Under repository generation p02 this control drives the RETIRED slot lane.
     * Its artifact is expected absent by the current V7 baseline, so a click
     * here would break that baseline rather than publish anything. The genuine
     * P02 handoff is repository-native and lives on the Local-folder-sync
     * panel's "Publish local revision", which is unaffected. Read from the live
     * generation gate, not from a preference. */
    const laneRetired = V.clean(generation) === "p02";
    const enabled = !laneRetired && state.available === true &&
      state.folderConnected === true && objectReady && state.busy !== true &&
      targetProven;
    let guidance = "Publish the selected saved chat for Desktop Studio.";
    if (laneRetired) {
      guidance = "This lane is retired under P02 (local-publication-lane-retired). "
        + "Use Publish local revision in Local folder sync.";
    }
    else if (!objectReady) guidance = "Choose a saved chat to publish.";
    else if (!targetProven) guidance = publicationTargetErrorText(targetProof.reason);
    else if (state.available !== true) guidance = "Local publication is not available yet.";
    else if (state.folderConnected !== true) guidance = "Connect a local folder first.";
    else if (state.busy === true) guidance = "A publication is already in progress.";
    return Object.freeze({ enabled, guidance });
  }

  function projectSummary(chrome, capability, diagnostic, operationResult, lineage) {
    const state = capability || {};
    const detail = diagnostic || {};
    const operation = operationResult || {};
    const chain = lineage || projectLineage(null);
    const connected = state.connected === true || state.handlePresent === true;
    const destinationAuthorized = detail.destinationAuthorization?.valid === true || detail.destinationAuthorization?.status === "authorized";
    const configured = chrome ? connected : (connected || destinationAuthorized);
    const rows = [
      ["Direction", "Desktop → Chrome"],
      ["Status", state.ready === true ? "Ready" : (configured ? "Blocked" : "Not configured")],
    ];
    const current = V.clean(operation.revisionId) || (chain.current !== "None" && chain.current !== "Not available" ? V.clean(chain.current) : "");
    const pending = chain.pending !== "None" && chain.pending !== "Not available" ? V.clean(chain.pending) : "";
    const lastActivity = V.clean(state.operation?.lastActivity || operation.observedAt || operation.preparedAt || detail.lastActivity);
    if (current) rows.push(["Current revision", current]);
    if (pending) rows.push(["Pending", pending]);
    if (lastActivity) rows.push(["Last activity", lastActivity]);
    if (chrome) {
      rows.push(["Folder connected", connected ? "Yes" : "No"]);
      rows.push(["Read access", permissionText(state.permission)]);
      rows.push(["Chrome publishing", state.publishingAuthorized === true
        ? "Authorized"
        : permissionText(state.publishingPermission)]);
    } else {
      rows.push(["Destination folder", configured ? "Authorized" : "Not configured"]);
    }
    if (state.ready !== true && V.clean(state.reason)) rows.push(["Why it's blocked", chrome ? blockerText(state.reason) : state.reason]);
    return Object.freeze({ rows: Object.freeze(rows), configured, connected });
  }

  panels.register({
    routeId: "settings.sync-new.browser-delivery",
    panelId: "h2o-settings-browser-delivery-panel",
    authority: {
      displaySources: [
        "H2O.Studio.sync.getReadinessSnapshot",
        "H2O.Studio.sync.folder.getReadinessSnapshot",
        "H2O.Desktop.SyncObjectDelivery.diagnose",
        "H2O.Desktop.SyncObjectDelivery.readLineage",
        "H2O.Studio.sync.item9Delivery.diagnose",
        "H2O.Studio.sync.localPublication.diagnose",
        "H2O.Studio.sync.localPublication.validateTarget",
        "H2O.Studio.archiveAuthority.listWorkbenchRows",
        "H2O.Studio.platform.storage",
      ],
      actionApis: [
        "H2O.Desktop.SyncObjectDelivery.prepareLocalBrowserDelivery",
        "H2O.Desktop.SyncObjectDelivery.receiveLocalPublication",
        "H2O.Studio.sync.item9Delivery.deliverFromSyncFolder",
        "H2O.Studio.sync.localPublication.publish",
      ],
      persistenceOwners: [
        /* The exact key this panel owns, so the declaration is checkable
         * rather than descriptive. Local Studio storage only. */
        "Browser Delivery publish target preference: h2o:studio:sync:browser-delivery:target:v1 (local Studio platform storage)",
        "Item 11 native destination authorization",
        "Item 11 native lineage ledger",
        "Chrome Item 9 peer-scoped observation store",
        "Chrome local-publication ledger in the existing sync-object database",
      ],
    },
    test: Object.freeze({ projectLineage, projectAdmission, projectSummary, projectReceiveAction, projectPublishAction, projectPublishTarget, redactObjectRef, permissionText, blockerText, publicationErrorText, publicationTargetErrorText, normalizeTargetState, projectTargetCandidates, projectSelectedTarget, targetLabel, savedAtText, TARGET_STATE_KEY, TARGET_STATE_SCHEMA, TARGET_MENU_LIMIT, AUTO_TARGET_STATE }),
    async mount(host) {
      const root = V.frame(host, {
        routeId: "settings.sync-new.browser-delivery",
        panelId: "h2o-settings-browser-delivery-panel",
        intro: "Desktop prepares a revision for Chrome. Chrome receives it from the shared local folder. Opening this panel performs neither operation.",
        body: V.card("Browser Delivery", "<p style=\"margin:0;opacity:.7\">Reading the existing local authorities…</p>"),
      });
      let disposed = false;
      let objectId = "";
      let operationResult = null;
      /* Result of the most recent explicit Chrome -> Desktop intake. It starts
       * null and is only ever set by a click: nothing on this panel receives on
       * mount, refresh, navigation or re-render. */
      let receiveResult = null;
      let lineageResult = null;
      let message = "";
      let publicationMessage = "";
      let publishTarget = projectPublishTarget(null);
      // The archive verdict for exactly the target above, kept so a click can
      // refuse a target already known to be gone without a fresh await.
      let publishTargetProof = null;
      // The revision identity behind the displayed target. The panel shows a
      // chat, but a publication is a chat AT a revision, and the archive can
      // advance the same chat between this render and the click.
      let displayedRevisionId = "";

      const isChrome = () => typeof W.H2O?.Studio?.sync?.item9Delivery?.deliverFromSyncFolder === "function";
      // Reader context is read for one purpose only: offering the open chat as
      // an explicit choice. It is never the durable target authority — opening
      // a chat is reading it, not deciding what to transfer.
      const readReaderContext = () => W.H2O?.Studio?.getReaderContext?.() || null;

      // Selector state, mirrored in memory so a render never blocks on storage
      // and so a storage read that fails cannot silently retarget.
      let targetState = AUTO_TARGET_STATE;
      let targetStateLoaded = false;
      let targetCandidates = Object.freeze([]);
      /* The resolved, archive-proved target behind the card now on screen. */
      let renderedTarget = projectSelectedTarget(null, "auto-latest");
      let selfWrite = false;

      const platformStorage = () => W.H2O?.Studio?.platform?.storage || null;
      async function loadTargetState() {
        const storage = platformStorage();
        if (!storage || typeof storage.get !== "function") { targetStateLoaded = true; return; }
        try { targetState = normalizeTargetState(await storage.get(TARGET_STATE_KEY)); }
        catch (_) { targetState = AUTO_TARGET_STATE; }
        targetStateLoaded = true;
      }
      async function writeTargetState(next) {
        targetState = normalizeTargetState(next);
        const storage = platformStorage();
        if (!storage || typeof storage.set !== "function") return;
        selfWrite = true;
        try { await storage.set(TARGET_STATE_KEY, targetState); }
        catch (_) { /* the in-memory choice still stands for this session */ }
        finally { selfWrite = false; }
      }

      const readCatalog = async () => {
        const archive = W.H2O?.Studio?.archiveAuthority;
        if (!archive || typeof archive.listWorkbenchRows !== "function") return [];
        try { return await archive.listWorkbenchRows(); }
        catch (_) { return []; }
      };
      // Read-only archive proof of the target this panel is about to show.
      // Absent runtime => no claim (the action is already blocked by
      // diagnose()), never a fabricated pass or a fabricated failure.
      const proveTarget = async (context) => {
        const validate = W.H2O?.Studio?.sync?.localPublication?.validateTarget;
        if (typeof validate !== "function") return null;
        try {
          return await validate(context);
        } catch (_) {
          return { ok: false, reason: "target-unverifiable" };
        }
      };
      /* Resolve the selector against the live catalog. Explicit mode names a
       * CHAT, not a frozen revision, so it follows that chat's newest save;
       * when the named chat is gone the panel says so and publishes nothing
       * rather than quietly moving to a different one. Auto mode walks the
       * candidates newest-first and takes the first the archive still
       * confirms. */
      /* The click reads back exactly the target the last render resolved and
       * proved — never a fresh pick from the raw candidate list. Auto mode
       * skips candidates the archive refuses, so the newest candidate and the
       * displayed one are not always the same chat, and recomputing here would
       * hand the writer something the operator never saw.
       *
       * It must also stay synchronous: the writer requires live user
       * activation, so the archive proof belongs to render(), and whatever the
       * archive changes afterwards is re-proved inside the writer itself. */
      function readRenderedTarget() {
        return renderedTarget;
      }

      async function resolveTarget() {
        targetCandidates = projectTargetCandidates(await readCatalog());
        if (disposed) return { target: projectSelectedTarget(null, targetState.mode), proof: null };
        if (targetState.mode === "explicit") {
          const match = targetCandidates.find((c) => c.objectId === targetState.explicitObjectId) || null;
          if (!match) return {
            target: projectSelectedTarget(null, "explicit", "target-object-missing"),
            proof: { ok: false, reason: "target-object-missing" },
          };
          const proof = await proveTarget({ chatId: match.objectId, snapshotId: match.snapshotId });
          if (proof && proof.ok !== true) return {
            target: projectSelectedTarget(null, "explicit", proof.reason),
            proof,
          };
          return { target: projectSelectedTarget(match, "explicit"), proof };
        }
        for (const candidate of targetCandidates) {
          const proof = await proveTarget({ chatId: candidate.objectId, snapshotId: candidate.snapshotId });
          if (disposed) break;
          if (!proof || proof.ok === true) return {
            target: projectSelectedTarget(candidate, "auto-latest"),
            proof,
          };
        }
        return { target: projectSelectedTarget(null, "auto-latest"), proof: null };
      }

      async function ensureDesktopApi() {
        if (W.H2O?.Desktop?.Sync?.round2aReady) await W.H2O.Desktop.Sync.round2aReady;
        await panels.loadScriptOnce("./sync/browser-delivery-producer.tauri.js", () =>
          /* Deliberately NOT gated on receiveLocalPublication. The producer
           * freezes its export object and re-entry returns early, so a producer
           * registered before this panel loaded can never gain a new member. If
           * intake were part of readiness, that older object would fail the
           * predicate forever and strand every Desktop capability on this panel
           * — including the ones that predate intake. Readiness stays the
           * pre-existing contract; intake availability is checked at click time
           * and reported, not treated as a mount failure. */
          typeof W.H2O?.Desktop?.SyncObjectDelivery?.prepareLocalBrowserDelivery === "function" &&
          typeof W.H2O?.Desktop?.SyncObjectDelivery?.readLineage === "function");
        return W.H2O.Desktop.SyncObjectDelivery;
      }

      /* The target card: the resolved chat, how it was chosen, and a menu that
       * changes it without leaving Browser Delivery. */
      function renderTargetCard(target) {
        const readerChatId = V.clean(readReaderContext()?.chatId);
        const menu = targetCandidates.slice(0, TARGET_MENU_LIMIT);
        const explicitId = targetState.mode === "explicit" ? targetState.explicitObjectId : "";
        if (explicitId && !menu.some((c) => c.objectId === explicitId)) {
          const held = targetCandidates.find((c) => c.objectId === explicitId);
          if (held) menu.push(held);
        }
        if (readerChatId && !menu.some((c) => c.objectId === readerChatId)) {
          const open = targetCandidates.find((c) => c.objectId === readerChatId);
          if (open) menu.push(open);
        }
        const selectedValue = targetState.mode === "explicit" ? `chat:${targetState.explicitObjectId}` : "auto";
        /* An explicit chat the catalog no longer offers has no option to
         * select, and a select with nothing selected shows its first entry —
         * which would read as "Auto" and quietly misdescribe the state. Give
         * the missing chat a visible, unselectable placeholder instead. */
        const missingExplicit = targetState.mode === "explicit"
          && !menu.some((c) => c.objectId === targetState.explicitObjectId);
        const options = (missingExplicit
          ? [`<option value="${V.escapeHtml(selectedValue)}" selected disabled>${V.escapeHtml(`${target.label} · ${redactObjectRef(targetState.explicitObjectId)}`)}</option>`]
          : [])
          .concat([`<option value="auto"${selectedValue === "auto" ? " selected" : ""}>Auto — Latest saved</option>`])
          .concat(menu.map((candidate) => {
            const value = `chat:${candidate.objectId}`;
            const openMark = candidate.objectId === readerChatId ? " (currently open)" : "";
            return `<option value="${V.escapeHtml(value)}"${value === selectedValue ? " selected" : ""}>${V.escapeHtml(`${targetLabel(candidate.title, candidate.objectId)} · ${savedAtText(candidate.savedAt)}${openMark}`)}</option>`;
          }))
          .join("");
        const modeLine = target.mode === "explicit" ? "Selected manually" : "Automatic: latest saved";
        const detail = target.selected
          ? `${modeLine}${target.savedAt ? ` · Last saved ${savedAtText(target.savedAt)}` : ""}${target.titled ? ` · Reference ${target.reference}` : ""}`
          : (target.mode === "explicit"
              ? `${modeLine} · ${publicationTargetErrorText(target.reason)}`
              : "No saved chats available");
        const autoAction = target.mode === "explicit"
          ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:2px">${V.action("target-auto", "Use latest saved")}</div>`
          : "";
        return `<div data-local-publication-target="1" style="display:grid;gap:6px;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03)"><span style="font-size:11px;opacity:.62">Publish target</span><select data-browser-delivery-target-select="1" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.18);color:inherit;font:inherit">${options}</select><span style="font-size:11px;opacity:.55;overflow-wrap:anywhere">${V.escapeHtml(detail)}</span>${autoAction}</div>`;
      }

      async function render() {
        const chrome = isChrome();
        let readiness = null;
        let diagnostic = null;
        let publicationDiagnostic = null;
        try {
          if (chrome) {
            readiness = await W.H2O?.Studio?.sync?.folder?.getReadinessSnapshot?.({ uiMounted: true });
            diagnostic = W.H2O.Studio.sync.item9Delivery.diagnose();
            /* The local-publication runtime composes at load, and Studio may
             * install its archive authority after that. Awaiting readiness HERE
             * — in the panel's async render, never in the click handler — makes
             * the runtime deterministically ready before the Publish button can
             * be enabled, so the startup ordering race resolves without a page
             * reload. It must not move into the click path: the writer captures
             * transient user activation synchronously, and any await between the
             * gesture and publish() would consume it. */
            await W.H2O?.Studio?.sync?.localPublication?.ensureReady?.();
            if (disposed) return;
            publicationDiagnostic = W.H2O?.Studio?.sync?.localPublication?.diagnose?.() || null;
          } else {
            readiness = await W.H2O?.Studio?.sync?.getReadinessSnapshot?.({ uiMounted: true });
            try { diagnostic = (await ensureDesktopApi()).diagnose(); }
            catch (error) { diagnostic = { destinationAuthorization: { status: V.clean(error?.message || error) } }; }
          }
        } catch (error) {
          message = `Read blocked: ${V.clean(error?.message || error) || "authority unavailable"}`;
        }
        if (disposed) return;
        const capability = readiness?.browserDelivery || {};
        const platformRows = chrome ? [
          ["Platform role", "Chrome receiver"],
          ["Connected folder", capability.connected === true ? "Yes" : "No"],
          ["Live read permission", V.valueText(capability.permission, "not checked")],
          ["Live read-write permission", V.valueText(capability.publishingPermission, "not checked")],
          ["Permission source", V.valueText(capability.permissionSource, "not checked")],
          ["Delivery capability", capability.ready === true ? "Available" : "Blocked"],
          ["Blocked reason", V.valueText(capability.reason, "None")],
          ["Runtime", diagnostic?.runtimeReady === true ? "Loaded" : V.valueText(diagnostic?.runtimeLoadState, "idle")],
        ] : [
          ["Platform role", "Desktop producer"],
          ["Destination", capability.connected === true || capability.handlePresent === true ? "Authorized" : "Not authorized"],
          ["Authorization", V.valueText(diagnostic?.destinationAuthorization?.status, "not checked")],
          ["Delivery capability", capability.ready === true ? "Available" : "Blocked"],
          ["Blocked reason", V.valueText(capability.reason, "None")],
          ["Transport", "Shared local folder"],
        ];
        const receiveAction = projectReceiveAction(capability);
        // One resolution per projection, so what the operator is shown and
        // what a click would publish cannot come from two different reads.
        let targetProof = null;
        if (chrome) {
          if (!targetStateLoaded) await loadTargetState();
          const resolved = await resolveTarget();
          if (disposed) return;
          publishTarget = resolved.target;
          renderedTarget = resolved.target;
          targetProof = resolved.proof;
        } else {
          publishTarget = projectPublishTarget(null);
          renderedTarget = publishTarget;
        }
        publishTargetProof = targetProof;
        displayedRevisionId = publishTarget.selected ? publishTarget.snapshotId : "";
        /* Live generation, read the same way every other P02 consumer reads it. */
        let repositoryGeneration = null;
        if (chrome) {
          try {
            const observed = await W.H2O?.Studio?.sync?.writerGeneration?.observe?.();
            if (observed && observed.state === "recorded") {
              repositoryGeneration = observed.generation;
            }
          } catch (_) { repositoryGeneration = null; }
          if (disposed) return;
        }
        const publishAction = projectPublishAction(
          publicationDiagnostic, publishTarget.objectId, targetProof, repositoryGeneration);
        const targetIndicator = chrome ? renderTargetCard(publishTarget) : "";
        const receiveIndicator = chrome ? "" : renderLocalReceiveCard(receiveResult);
        const actions = chrome
          ? `${targetIndicator}<div style="display:flex;gap:8px;flex-wrap:wrap">${V.action("receive", "Receive", { disabled: !receiveAction.enabled })}${V.action("publish-local", "Publish to Desktop", { disabled: !publishAction.enabled })}${V.action("refresh", "Refresh")}</div>`
          : `${receiveIndicator}<label style="display:grid;gap:5px;font-size:12px"><span style="opacity:.7">Object ID</span><input data-browser-delivery-object-id="1" value="${V.escapeHtml(objectId)}" spellcheck="false" autocomplete="off" placeholder="stable object ID" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.18);color:inherit;font:inherit" /></label><div style="display:flex;gap:8px;flex-wrap:wrap">${V.action("receive-local", "Receive from Chrome")}${V.action("prepare", "Prepare")}${V.link("#/settings/sync-new/local-folder", "Destination settings")}${V.action("refresh", "Refresh")}</div>`;
        const resultRows = chrome ? projectAdmission(operationResult) : [
          ["Preparation", operationResult?.ok === true ? V.valueText(operationResult.verdict, "prepared") : "No preparation result"],
          ["Revision", V.valueText(operationResult?.revisionId, "Not prepared")],
          ["Previous revision", V.valueText(operationResult?.previousRevisionId, "Not prepared")],
          ["Lineage disposition", V.valueText(operationResult?.lineageDisposition, "Not prepared")],
          ["Destination slot", V.valueText(operationResult?.slotPosture, "Not checked")],
          ...projectLocalReceive(receiveResult),
        ];
        const lineage = projectLineage(lineageResult);
        const summary = projectSummary(chrome, capability, diagnostic, operationResult, lineage);
        const technicalRows = [
          ...platformRows,
          ...resultRows,
          ...(chrome ? [] : [
            ["Lineage state", lineage.state],
            ["Current revision", lineage.current],
            ["Previous revision", lineage.previous],
            ["Chain", lineage.chain],
            ["Pending", lineage.pending],
            ["Lineage blocker", lineage.reason],
          ]),
        ];
        const technicalActions = chrome ? "" : `<div style="display:flex;gap:8px;flex-wrap:wrap">${V.action("lineage", "Read lineage")}${V.link("#/settings/sync-new/advanced", "Open Advanced Diagnostics")}</div>`;
        V.setBody(root,
          V.card("Browser Delivery", V.statusRows(summary.rows), { data: 'data-browser-delivery-primary="1"' }) +
          V.card(chrome ? "Transfer with Desktop" : "Prepare for Chrome", `${actions}<p style="margin:0;opacity:.72;font-size:12px">${V.escapeHtml(message || (chrome ? receiveAction.guidance : "Prepare a revision for Chrome."))}</p>${chrome ? `<p data-local-publication-guidance="1" style="margin:0;opacity:.72;font-size:12px">${V.escapeHtml(publicationMessage || publishAction.guidance)}</p>` : ""}`) +
          `<details class="wbSettingsCard" data-browser-delivery-technical-details="1" style="padding:16px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.02);overflow:visible"><summary style="cursor:pointer;font-weight:650">Technical details</summary><div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">${V.statusRows(technicalRows)}${technicalActions}</div></details>`
        );
      }

      const removeInput = V.listen(root, "input", (event) => {
        if (event.target?.matches?.('[data-browser-delivery-object-id="1"]')) objectId = V.clean(event.target.value);
      });
      const removeChange = V.listen(root, "change", async (event) => {
        if (!event.target?.matches?.('[data-browser-delivery-target-select="1"]')) return;
        const value = V.clean(event.target.value);
        await writeTargetState(value === "auto"
          ? AUTO_TARGET_STATE
          : {
            schema: TARGET_STATE_SCHEMA,
            mode: "explicit",
            explicitObjectId: value.replace(/^chat:/, ""),
          });
        publicationMessage = "";
        await requestRender();
      });
      const removeClick = V.listen(root, "click", async (event) => {
        const button = event.target?.closest?.("[data-domain-action]");
        if (!button || !root.contains(button)) return;
        event.preventDefault();
        const action = button.dataset.domainAction;
        if (action === "refresh") { message = "Refreshed from existing authorities."; await requestRender(); return; }
        if (action === "target-auto") {
          await writeTargetState(AUTO_TARGET_STATE);
          publicationMessage = "";
          await requestRender();
          return;
        }
        button.disabled = true;
        try {
          if (action === "receive") {
            operationResult = await W.H2O.Studio.sync.item9Delivery.deliverFromSyncFolder();
            message = operationResult?.ok === true ? V.valueText(operationResult.verdict) : `Blocked: ${V.valueText(operationResult?.errorCode)}`;
          } else if (action === "publish-local") {
            // Re-resolve the selector at click time and refuse to publish
            // anything other than the object AND revision this panel is
            // currently showing. A changed target fails closed and re-projects
            // instead of publishing a different chat; there is no fallback to
            // whatever happens to be open in Studio.
            const clickTarget = readRenderedTarget();
            const clickRevisionId = clickTarget.snapshotId;
            if (!clickTarget.selected || clickTarget.objectId !== publishTarget.objectId) {
              publishTarget = clickTarget;
              publicationMessage = clickTarget.selected
                ? "The publish target changed. Check the target above, then press Publish again."
                : (clickTarget.mode === "explicit"
                    ? publicationTargetErrorText(clickTarget.reason)
                    : "No saved chats available.");
            } else if (!displayedRevisionId || clickRevisionId !== displayedRevisionId) {
              // Same chat, different revision: publishing now would publish
              // something other than what was shown and proved.
              publicationMessage = publicationTargetErrorText("target-revision-moved");
            } else if (publishTargetProof && publishTargetProof.ok !== true) {
              // Already proven gone at render time: refuse synchronously rather
              // than send a known-dead target into the writer.
              publicationMessage = publicationTargetErrorText(publishTargetProof.reason);
            } else {
              // Nothing asynchronous may precede this call: the writer demands
              // live browser user activation, and the archive-backed freshness
              // proof already ran in render(). Anything the archive can still
              // invalidate between render and click is re-proved inside the
              // writer's projection, which precedes every folder and
              // permission access.
              const publishResult = await W.H2O.Studio.sync.localPublication.publish(clickTarget.objectId, displayedRevisionId);
              publicationMessage = publishResult?.ok === true
                ? (publishResult.disposition === "committed-replay"
                    ? "The current revision is already published."
                    : "Revision published for Desktop Studio.")
                : publicationErrorText(publishResult?.errorCode);
            }
          } else {
            const api = await ensureDesktopApi();
            if (action === "receive-local") {
              /* No object ID is read, passed or required: the native command
               * owns the authorized folder and decides admission by itself, so
               * this surface cannot aim intake at a different object. One
               * activation performs exactly one invocation and never retries. */
              if (typeof api?.receiveLocalPublication !== "function") {
                /* Report it, never hang on it. */
                receiveResult = Object.freeze({
                  ok: false,
                  errorCode: "round2-item11-local-publication-receive-unavailable",
                });
                message = "Blocked: this Desktop runtime has no Chrome intake bridge.";
                await requestRender();
                return;
              }
              receiveResult = await api.receiveLocalPublication();
              message = receiveResult?.ok === true
                ? V.valueText(receiveResult.verdict)
                : `Blocked: ${V.valueText(receiveResult?.errorCode)}`;
              await requestRender();
              return;
            }
            if (!objectId) throw new Error("object-id-required");
            if (action === "prepare") {
              operationResult = await api.prepareLocalBrowserDelivery(objectId);
              message = operationResult?.ok === true ? V.valueText(operationResult.verdict) : `Blocked: ${V.valueText(operationResult?.errorCode)}`;
              if (operationResult?.ok === true) lineageResult = await api.readLineage(objectId);
            } else if (action === "lineage") {
              lineageResult = await api.readLineage(objectId);
              message = lineageResult?.ok === true ? "Lineage read without mutation." : `Blocked: ${V.valueText(lineageResult?.errorCode)}`;
            }
          }
        } catch (error) {
          message = `Blocked: ${V.clean(error?.message || error) || "operation unavailable"}`;
        }
        await requestRender();
      });
      /* A save made elsewhere changes what "latest saved" means, and the
       * archive already announces its own changes on the existing broadcast
       * channel — so listen instead of polling.
       *
       * Renders coalesce rather than drop. A change that arrives while a
       * render is in flight would otherwise be discarded by a busy flag and
       * the panel would settle on stale state: the trailing pass is what
       * guarantees the last render observes the newest archive. Requests
       * collapse into one trailing pass however many arrive, the loop is
       * bounded by that single flag, and every caller awaits the same
       * promise. */
      let renderRequested = false;
      let renderLoop = null;
      function requestRender() {
        renderRequested = true;
        if (renderLoop) return renderLoop;
        renderLoop = (async () => {
          try {
            while (renderRequested && !disposed) {
              renderRequested = false;
              await render();
            }
          } finally {
            renderLoop = null;
          }
        })();
        return renderLoop;
      }

      let removeBroadcast = () => {};
      const broadcast = W.H2O?.Studio?.platform?.broadcast;
      if (isChrome() && broadcast && typeof broadcast.onAnyChange === "function") {
        /* The panel's own preference write travels this same channel; without
         * the guard it would answer its own write forever. */
        const onBroadcast = () => { if (!disposed && !selfWrite) requestRender(); };
        try { removeBroadcast = broadcast.onAnyChange(onBroadcast) || (() => {}); }
        catch (_) { removeBroadcast = () => {}; }
      }

      await requestRender();
      return () => { disposed = true; removeInput(); removeChange(); removeClick(); removeBroadcast(); };
    },
  });
})();
