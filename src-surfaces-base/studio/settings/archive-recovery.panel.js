// Sync Settings M3 — Local Archive & Recovery adapter over established archive APIs.
(() => {
  "use strict";
  const W = typeof globalThis !== "undefined" ? globalThis : window;
  const panels = W.H2O?.Studio?.settings?.domainPanels;
  if (!panels) return;
  const V = panels.view;

  function project(studio, platform = "desktop") {
    if (platform === "chrome") {
      return Object.freeze([
        ["Archive", "Desktop Studio"],
        ["Archive health", "Desktop Studio"],
        ["Restore & recovery", "Desktop Studio"],
      ]);
    }
    return Object.freeze([
      ["Archive health", typeof studio?.archiveHealthUi?.renderArchiveHealthCard === "function" ? "Available" : "Unavailable on this platform"],
      ["Package inspection", typeof studio?.archiveInspector?.inspectPackage === "function" ? "Available" : "Unavailable"],
      ["Import recovery", "Delegated to the existing verification-gated package card"],
      ["Export / share", "Delegated to the existing package action card"],
      ["Restore / relink", "Existing verification-gated package recovery pipeline"],
      ["Backup authority", "Existing archive/package authorities"],
      ["Identity recovery", typeof W.H2O?.Studio?.platform?.__inspectDesktopIdentityOrphanReconciliation === "function" ? "Available · governed authority" : "Unavailable"],
    ]);
  }

  function chromePresentation() {
    return Object.freeze({
      actions: Object.freeze([]),
      guidance: "Open H2O Studio Desktop to inspect, export, restore, or recover saved-chat packages.",
      recoveryGuidance: "Account and Sync identity recovery is available in Desktop Studio.",
    });
  }


  /* ── Desktop identity orphan reconciliation ───────────────────────────────
   * The Desktop writer identity is persisted twice: authoritatively in SQLite
   * and as a second WKWebView-side copy. When the copies disagree the identity
   * authority reports `divergent` and every outbound writer path fails closed
   * with round2a-sync-peer-identity-divergent - including Item 11 local
   * Browser Delivery preparation.
   *
   * This card exposes the EXISTING governed recovery authority and nothing
   * else. It reimplements no reconciliation logic, edits no identity storage,
   * accepts no identity value or backup path, and offers no force/bypass:
   * inspection and reconciliation are two deliberate activations over
   * platform.__inspectDesktopIdentityOrphanReconciliation and
   * platform.__applyDesktopIdentityOrphanReconciliation. */
  function identityAuthorityApi() {
    const platform = W.H2O?.Studio?.platform;
    if (!platform ||
        typeof platform.__inspectDesktopIdentityOrphanReconciliation !== "function" ||
        typeof platform.__applyDesktopIdentityOrphanReconciliation !== "function") {
      return null;
    }
    return platform;
  }

  /* Report the canonical result verbatim. A blocked result must stay legible as
   * a blocked result: the failure code is the operator's only signal for why a
   * fail-closed authority refused, so it is never flattened into "error". */
  /* The two canonical result shapes report the divergent copy differently, and
   * conflating them is dangerous in exactly one direction: inspect/prepare
   * carries no `status` at all, so testing `status === "divergent"` renders
   * "Not present" for a result that in fact PROVED the orphan exists - the
   * opposite of the truth, displayed immediately before a removal action.
   *
   * Presence is therefore derived only from what each shape actually
   * guarantees: apply reports canonical `status`; inspect proves the orphan by
   * authorizing its removal and writing its rollback backup. Absence is never
   * inferred from a missing field - an unrecognised shape reports Unknown. */
  function divergentCopyState(result) {
    if (!result || result.ok !== true) return "Not reported";
    const status = result.status;
    if (status === "divergent") return "Present";
    if (status === "sqlite-only" || status === "matching" || status === "migrated") {
      return "Not present";
    }
    if (status === undefined || status === null || status === "") {
      /* Inspect shape: the removal authorization and the rollback backup are
       * the authority's own proof that the orphan was found. */
      if (result.removalAuthorized === true && result.backupCreated === true) {
        return "Confirmed";
      }
      return "Unknown / not reported";
    }
    return "Unknown / not reported";
  }

  function projectReconciliation(result) {
    if (!result) return Object.freeze([["Reconciliation", "Not inspected yet"]]);
    const rows = [
      ["Result", result.ok === true ? V.valueText(result.verdict, "ok") : "Blocked"],
    ];
    if (result.ok !== true) {
      rows.push(["Blocked reason", V.valueText(result.errorCode, "unavailable")]);
    }
    rows.push(
      ["Authority status", V.valueText(result.status, "not-reported")],
      ["Canonical", result.canonical === true ? "Yes" : "No"],
      ["Authoritative fingerprint", V.valueText(result.sqliteFingerprintSha256Hex, "None")],
      ["Divergent copy", divergentCopyState(result)],
      ["Removal authorized", result.removalAuthorized === true ? "Yes" : "No"],
      ["Removal performed", result.removalPerformed === true ? "Yes" : "No"],
      ["Rollback backup", result.backupCreated === true ? V.valueText(result.backupLeafName, "created") : "Not created"],
      ["Backup mode", V.valueText(result.backupMode, "None")],
      ["Backup SHA-256", V.valueText(result.backupSha256Hex, "None")],
      ["Identity mutation", result.identityMutationPerformed === true ? "UNEXPECTED" : "None"],
      ["SQLite mutation", result.sqliteMutationPerformed === true ? "UNEXPECTED" : "None"],
      ["Restart required", result.restartRequired === true ? "Yes" : "No"],
      ["Network used", result.noNetwork === true ? "None" : "UNEXPECTED"],
    );
    return Object.freeze(rows);
  }

  function renderReconciliationCard(result, message) {
    const available = !!identityAuthorityApi();
    const note = available
      ? "Inspect proves the divergence and writes the protected rollback backup; it removes nothing. Reconcile then removes only the divergent orphan copy through the same authority and requires a Desktop restart."
      : "The governed identity recovery authority is unavailable in this runtime.";
    return V.card("Desktop identity orphan reconciliation",
      `<p style="margin:0;opacity:.72;font-size:12px;line-height:1.5">${V.escapeHtml(note)}</p>` +
      V.statusRows(projectReconciliation(result)) +
      `<div style="display:flex;gap:8px;flex-wrap:wrap">${
        V.action("identity-inspect", "Inspect identity divergence", { disabled: !available })
      }${
        V.action("identity-reconcile", "Reconcile identity orphan", { disabled: !available, danger: true })
      }</div>` +
      (message ? `<p style="margin:0;font-size:12px;opacity:.8">${V.escapeHtml(message)}</p>` : ""));
  }

  panels.register({
    routeId: "settings.sync-new.archive-recovery",
    panelId: "h2o-settings-archive-recovery-panel",
    authority: {
      displaySources: [
        "H2O.Studio.archiveHealthUi",
        "H2O.Studio.archiveInspector",
      ],
      actionApis: [
        "archive health delegated package action cards",
        "existing verification-gated package recovery modules",
        "legacy Round 2A identity recovery",
      ],
      persistenceOwners: ["existing archive stores and packages", "existing SQLite identity/orphan backup authority"],
    },
    test: Object.freeze({ project, chromePresentation, projectReconciliation, divergentCopyState }),
    async mount(host, context = {}) {
      const platform = context.platform === "chrome" ? "chrome" : "desktop";
      const chrome = platform === "chrome";
      const root = V.frame(host, {
        routeId: "settings.sync-new.archive-recovery",
        panelId: "h2o-settings-archive-recovery-panel",
        intro: chrome
          ? "Saved-chat archive and recovery tools are available in Desktop Studio."
          : "Archive and package recovery reuse the existing verified-package pipeline. Identity recovery remains a separate dangerous authority.",
        body: "",
      });
      const studio = W.H2O?.Studio || {};
      if (chrome) {
        const presentation = chromePresentation();
        V.setBody(root,
          V.card("Saved-chat archive", V.statusRows(project(studio, platform))) +
          V.card("Restore & recovery", `<p style="margin:0;opacity:.72;font-size:12px;line-height:1.5">${V.escapeHtml(presentation.guidance)}</p>`) +
          `<details class="wbSettingsCard" data-archive-recovery-deliberate="1" style="padding:16px;border:1px solid rgba(248,113,113,.28);border-radius:10px;background:rgba(239,68,68,.045);overflow:visible"><summary style="cursor:pointer;font-weight:650">Recovery · deliberate actions</summary><div style="display:flex;flex-direction:column;gap:10px;margin-top:12px"><p style="margin:0;opacity:.72;font-size:12px;line-height:1.5">${V.escapeHtml(presentation.recoveryGuidance)}</p></div></details>`
        );
        return () => { /* Chrome mounts no archive action handlers. */ };
      }
      let reconciliation = null;
      let reconciliationMessage = "";
      const renderBody = () => V.setBody(root,
        V.card("Capability", V.statusRows(project(studio, platform))) +
        V.card("Archive health and packages", '<div id="h2o-settings-archive-health-host"><p style="margin:0;opacity:.7">Archive health is unavailable on this platform.</p></div>') +
        renderReconciliationCard(reconciliation, reconciliationMessage) +
        `<details class="wbSettingsCard" style="padding:16px;border:1px solid rgba(248,113,113,.28);border-radius:10px;background:rgba(239,68,68,.045);overflow:visible"><summary style="cursor:pointer;font-weight:650">Recovery · deliberate actions</summary><div style="display:flex;flex-direction:column;gap:10px;margin-top:12px"><p style="margin:0;opacity:.72;font-size:12px;line-height:1.5">Package restore and relink remain verification-gated by the existing archive APIs above. Identity/orphan reconciliation is more dangerous and is exposed below as two separate deliberate actions over the existing governed authority; this panel stores no identity or backup bytes.</p><div style="display:flex;gap:8px;flex-wrap:wrap">${V.link("#/settings/sync/object-sync", "Open shared identity recovery")}${V.link("#/settings/data", "Open Data tools")}</div></div></details>`
      );
      renderBody();

      /* Registration is not activation. Nothing here runs the recovery
       * authority: both entry points are reachable only from an explicit click
       * on their own control, one activation performing exactly one call. */
      const removeClick = V.listen(root, "click", async (event) => {
        const button = event.target?.closest?.("[data-domain-action]");
        if (!button || !root.contains(button) || button.disabled) return;
        const domainAction = button.dataset.domainAction;
        if (domainAction !== "identity-inspect" && domainAction !== "identity-reconcile") return;
        event.preventDefault();
        const api = identityAuthorityApi();
        if (!api) {
          reconciliationMessage = "Governed identity recovery authority is unavailable.";
          renderBody();
          return;
        }
        button.disabled = true;
        try {
          reconciliation = domainAction === "identity-inspect"
            ? await api.__inspectDesktopIdentityOrphanReconciliation()
            : await api.__applyDesktopIdentityOrphanReconciliation();
          reconciliationMessage = reconciliation?.ok === true
            ? (domainAction === "identity-inspect"
              ? "Inspection complete. Nothing was removed."
              : "Reconciliation complete. Restart Desktop Studio to adopt the canonical identity.")
            : `Blocked: ${V.valueText(reconciliation?.errorCode, "unavailable")}`;
        } catch (error) {
          reconciliation = null;
          reconciliationMessage = `Blocked: ${V.clean(error?.message || error) || "unavailable"}`;
        }
        renderBody();
        mountHealth();
      });

      const health = root.querySelector("#h2o-settings-archive-health-host");
      function mountHealth() {
        const target = root.querySelector("#h2o-settings-archive-health-host");
        try {
          if (target && typeof studio.archiveHealthUi?.renderArchiveHealthCard === "function") {
            studio.archiveHealthUi.renderArchiveHealthCard(target, {
              diagnose: (options) => studio.ingestion?.diagnoseSavedChatArchiveV1?.(options),
              diagnoseOptions: { includeCasChecks: true, includeRendererChecks: true, includeDbChecks: true, limit: 500 },
            });
          }
        } catch (error) {
          if (target) target.textContent = `Archive health blocked: ${V.clean(error?.message || error) || "unavailable"}`;
        }
      }
      try {
        if (health && typeof studio.archiveHealthUi?.renderArchiveHealthCard === "function") {
          studio.archiveHealthUi.renderArchiveHealthCard(health, {
            diagnose: (options) => studio.ingestion?.diagnoseSavedChatArchiveV1?.(options),
            diagnoseOptions: { includeCasChecks: true, includeRendererChecks: true, includeDbChecks: true, limit: 500 },
          });
        }
      } catch (error) {
        if (health) health.textContent = `Archive health blocked: ${V.clean(error?.message || error) || "unavailable"}`;
      }
      return () => { removeClick(); };
    },
  });
})();
