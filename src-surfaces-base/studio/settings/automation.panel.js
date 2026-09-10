// Sync Settings M4 — truthful Automation & Background Activity presentation.
(() => {
  "use strict";
  const W = typeof globalThis !== "undefined" ? globalThis : window;
  const panels = W.H2O?.Studio?.settings?.domainPanels;
  if (!panels) return;
  const V = panels.view;
  const CANONICAL_SYNC_MODES = Object.freeze([
    Object.freeze({ value: "manual", label: "Manual" }),
    Object.freeze({ value: "notify", label: "Notify" }),
    Object.freeze({ value: "auto", label: "Auto" }),
  ]);

  function projectCanonicalSyncMode(config) {
    const rawMode = V.clean(config?.mode).toLowerCase();
    const option = CANONICAL_SYNC_MODES.find((entry) => entry.value === rawMode) || null;
    return Object.freeze({
      mode: option?.value || "",
      label: option?.label || "Unavailable",
      valid: !!option,
    });
  }

  function canonicalSyncModeCard(model) {
    const value = model || projectCanonicalSyncMode(null);
    const control = value.valid
      ? `<label style="display:grid;gap:6px;max-width:320px"><span style="font-size:12px;opacity:.72">Automation mode</span><select data-sync-mode-control="1" data-canonical-mode="${V.escapeHtml(value.mode)}" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.18);color:inherit;font:inherit">${CANONICAL_SYNC_MODES.map((option) => `<option value="${V.escapeHtml(option.value)}"${option.value === value.mode ? " selected" : ""}>${V.escapeHtml(option.label)}</option>`).join("")}</select></label>`
      : '<p style="margin:0;opacity:.72;font-size:12px">The canonical Sync mode is unavailable. No mode can be changed until the existing configuration authority is readable.</p>';
    return V.card("Sync mode",
      V.statusRows([["Current mode", value.label]]) + control +
      '<p style="margin:0;opacity:.68;font-size:12px;line-height:1.45">Manual stops automatic object-protocol Sync. Notify preserves the existing notification behavior. Auto allows the existing automatic reconciliation runtime.</p>',
      { data: 'data-canonical-sync-mode-card="1"' });
  }

  function projectCapability(name, capability) {
    const value = capability || {};
    return Object.freeze({
      name,
      configured: value.configured === true,
      effective: value.effective === true,
      rows: Object.freeze([
        ["Configured", value.configured === true ? "On" : "Off"],
        ["Effective", value.effective === true ? "Yes" : "No"],
        ["Requirements met", value.prerequisitesSatisfied === true ? "Yes" : "No"],
        ["Running", value.schedulerActive === true ? "Yes" : "No"],
        ["Why it's blocked", V.valueText(value.reason || value.ineffectiveReason, "None")],
        ["Last activity", V.valueText(value.lastActivity || value.lastExportAt, "None yet")],
        ["Operation", V.valueText(value.operation?.state, "idle")],
      ]),
    });
  }

  function chromeBlockerText(value) {
    return ({
      "folder-not-connected": "Connect a local folder first.",
      "folder-not-configured": "Configure a local folder first.",
      "permission-required": "Allow access to the local folder first.",
      "permission-prompt": "Allow access to the local folder first.",
      "permission-denied": "Local folder permission is denied.",
      "permission-unavailable": "Local folder permission is unavailable.",
      "scheduler-not-running": "Background activity is not running.",
      "sync-folder-latest-missing": "No local update is available yet.",
      "write-gate-blocked": "Chrome Export is not available right now.",
    })[V.clean(value).toLowerCase()] || "Automation is not working yet.";
  }

  function operationText(value) {
    return ({
      "in-flight": "In progress",
      success: "Completed",
      completed: "Completed",
      blocked: "Blocked",
      error: "Error",
    })[V.clean(value).toLowerCase()] || "";
  }

  function projectChromeCapability(name, capability) {
    const value = capability || {};
    const truth = projectCapability(name, value);
    const operation = operationText(value.operation?.state);
    const rows = [
      ["Configured", truth.configured ? "On" : "Off"],
      ["Working", truth.effective ? "Yes" : "No"],
      ["Requirements met", value.prerequisitesSatisfied === true ? "Yes" : "No"],
      ["Running", value.schedulerActive === true ? "Yes" : "No"],
    ];
    if (truth.configured && !truth.effective && V.clean(value.reason || value.ineffectiveReason)) {
      rows.push(["Why it's blocked", chromeBlockerText(value.reason || value.ineffectiveReason)]);
    }
    rows.push(["Last activity", V.valueText(value.lastActivity || value.lastExportAt, "None yet")]);
    if (operation) rows.push(["Operation", operation]);
    return Object.freeze({
      name,
      configured: truth.configured,
      effective: truth.effective,
      rows: Object.freeze(rows),
    });
  }

  function projectFocusImport(status, localFolder) {
    const value = status || {};
    const configured = value.flagEnabled === true;
    const prerequisitesSatisfied = localFolder?.configured === true;
    const schedulerActive = value.listenersBound === true;
    return projectCapability("Import on focus", {
      configured,
      prerequisitesSatisfied,
      schedulerActive,
      effective: configured && prerequisitesSatisfied && schedulerActive,
      reason: !configured ? "not-configured"
        : (!prerequisitesSatisfied ? "folder-not-configured"
          : (!schedulerActive ? "scheduler-not-running" : "")),
      lastActivity: value.lastScanAt || null,
      operation: { state: value.lastScanError ? "error" : "idle" },
    });
  }

  function capabilityCard(model, actions, note) {
    return V.card(model.name,
      V.statusRows(model.rows) +
      (actions ? `<div style="display:flex;gap:8px;flex-wrap:wrap">${actions}</div>` : "") +
      (note ? `<p style="margin:0;opacity:.68;font-size:12px;line-height:1.45">${V.escapeHtml(note)}</p>` : "")
    );
  }

  panels.register({
    routeId: "settings.sync-new.automation",
    panelId: "h2o-settings-automation-panel",
    authority: {
      displaySources: [
        "H2O.Studio.sync.getConfig",
        "H2O.Studio.sync.getReadinessSnapshot",
        "H2O.Studio.sync.folder.getReadinessSnapshot",
        "H2O.Studio.sync.focusImport.status",
        "H2O.Studio.sync.autoImport.getAutomationSnapshot",
      ],
      actionApis: [
        "H2O.Studio.sync.setConfig({ mode })",
        "H2O.Studio.sync.autoExport.enable/disable",
        "H2O.Studio.sync.focusImport.enable/disable",
        "H2O.Studio.sync.folder.enableAutoSync/disableAutoSync",
        "H2O.Studio.sync.autoImport.enable/disable",
      ],
      persistenceOwners: [
        "canonical object-protocol Sync config h2o:studio:sync:config:v1",
        "existing Desktop auto-export setting",
        "existing Desktop focus-import flag",
        "existing Chrome folder-import auto-sync state",
        "existing Chrome export feature flags",
      ],
    },
    test: Object.freeze({
      projectCanonicalSyncMode,
      projectCapability,
      projectChromeCapability,
      projectFocusImport,
      chromeBlockerText,
      operationText,
    }),
    async mount(host) {
      const root = V.frame(host, {
        routeId: "settings.sync-new.automation",
        panelId: "h2o-settings-automation-panel",
        intro: "Configured intent and effective runtime behavior are separate. Opening this panel reads state only; no import, export, or sync is started.",
        body: V.card("Automation", '<p style="margin:0;opacity:.7">Reading the existing automation authorities…</p>'),
      });
      let disposed = false;
      let message = "";
      let modeWriteInFlight = false;

      const chromeFolder = () => {
        const folder = W.H2O?.Studio?.sync?.folder;
        return folder && typeof folder.connectFolder === "function" ? folder : null;
      };

      async function readModels() {
        const sync = W.H2O?.Studio?.sync || {};
        const folder = chromeFolder();
        if (folder) {
          const snapshot = await folder.getReadinessSnapshot?.({ uiMounted: true });
          const config = await sync.getConfig?.();
          const chromeAuto = projectChromeCapability("Folder Auto Sync", snapshot?.automation?.chromeAutoImport);
          const exportRaw = await sync.autoImport?.getAutomationSnapshot?.();
          const chromeExport = projectChromeCapability("Chrome Export", {
            ...exportRaw,
            reason: exportRaw?.ineffectiveReason,
            lastActivity: exportRaw?.lastExportAt,
            operation: { state: exportRaw?.inFlight === true ? "in-flight" : "idle" },
          });
          return {
            platform: "Chrome Studio",
            localFolder: snapshot?.localFolder || {},
            canonicalMode: projectCanonicalSyncMode(config),
            models: [chromeAuto, chromeExport],
          };
        }
        const snapshot = await sync.getReadinessSnapshot?.({ uiMounted: true });
        const config = await sync.getConfig?.();
        const autoExport = projectCapability("Auto Export", snapshot?.automation?.desktopAutoExport);
        const watcher = projectCapability("Folder watcher", snapshot?.automation?.desktopWatcher);
        const focusStatus = await sync.focusImport?.status?.();
        const focus = projectFocusImport(focusStatus, snapshot?.localFolder || {});
        return {
          platform: "Desktop Studio",
          localFolder: snapshot?.localFolder || {},
          canonicalMode: projectCanonicalSyncMode(config),
          models: [watcher, autoExport, focus],
        };
      }

      function actionPair(prefix, model, enableLabel, disableLabel) {
        return V.action(`${prefix}-enable`, enableLabel, { disabled: model.configured }) +
          V.action(`${prefix}-disable`, disableLabel, { disabled: !model.configured });
      }

      function configuredAction(prefix, model, enableLabel, disableLabel) {
        return model.configured
          ? V.action(`${prefix}-disable`, disableLabel)
          : V.action(`${prefix}-enable`, enableLabel);
      }

      async function render() {
        let state = { platform: "Unavailable", models: [] };
        let error = "";
        try { state = await readModels(); }
        catch (value) { error = V.clean(value?.message || value) || "automation authority unavailable"; }
        if (disposed) return;
        const chrome = state.platform === "Chrome Studio";
        const cards = state.models.map((model, index) => {
          let actions = "";
          let note = "";
          if (chrome && index === 0) {
            actions = configuredAction("chrome-auto", model, "Enable Folder Auto Sync", "Disable Folder Auto Sync");
            note = "Controls the established folder-import poller separately from object-protocol Sync mode.";
          } else if (chrome && index === 1) {
            actions = configuredAction("chrome-export", model, "Enable Chrome Export", "Disable Chrome Export");
            note = "Automatically makes supported Chrome changes available to the connected local folder.";
          } else if (!chrome && model.name === "Auto Export") {
            actions = actionPair("desktop-export", model, "Enable Auto Export", "Disable Auto Export");
            note = "Manual folder mode can keep a configured Auto Export request ineffective.";
          } else if (!chrome && model.name === "Import on focus") {
            actions = actionPair("desktop-focus", model, "Enable Import on Focus", "Disable Import on Focus");
            note = "Uses the established focus/visibility listener authority; no polling is introduced here.";
          } else {
            actions = V.link("#/settings/sync-new/local-folder", "Configure folder mode");
            note = "The watcher is owned by the existing folder configuration and is not started directly by this panel.";
          }
          return capabilityCard(model, actions, note);
        }).join("");
        V.setBody(root,
          canonicalSyncModeCard(state.canonicalMode) +
          (chrome ? "" : V.card("Runtime", V.statusRows([
            ["Platform", state.platform],
            ["Capabilities", String(state.models.length)],
            ["Panel operation", "read only until an explicit control change"],
          ]))) + cards +
          V.card("Result", `<p data-domain-message="1" style="margin:0;opacity:.72;font-size:12px">${V.escapeHtml(error ? `Blocked: ${error}` : (message || "No automation action has been run."))}</p>`)
        );
      }

      const removeModeChange = V.listen(root, "change", async (event) => {
        const control = event.target?.closest?.("[data-sync-mode-control]");
        if (!control || !root.contains(control) || modeWriteInFlight) return;
        const requestedMode = V.clean(control.value).toLowerCase();
        const priorMode = V.clean(control.dataset.canonicalMode).toLowerCase();
        if (!CANONICAL_SYNC_MODES.some((option) => option.value === requestedMode) ||
            !CANONICAL_SYNC_MODES.some((option) => option.value === priorMode) ||
            requestedMode === priorMode) {
          control.value = priorMode;
          return;
        }
        /* A select changes its displayed value before this handler runs. Put
         * the last authoritative value back immediately; only the readback
         * render below is allowed to display a successful transition. */
        control.value = priorMode;
        control.disabled = true;
        modeWriteInFlight = true;
        try {
          const sync = W.H2O?.Studio?.sync || {};
          if (typeof sync.getConfig !== "function" || typeof sync.setConfig !== "function") {
            throw new Error("canonical-sync-mode-authority-unavailable");
          }
          await sync.setConfig({ mode: requestedMode });
          const persisted = projectCanonicalSyncMode(await sync.getConfig());
          if (!persisted.valid || persisted.mode !== requestedMode) {
            throw new Error("canonical-sync-mode-readback-mismatch");
          }
          message = `Sync mode updated to ${persisted.label}.`;
        } catch (error) {
          message = `Blocked: ${V.clean(error?.message || error) || "Sync mode update failed"}`;
        } finally {
          modeWriteInFlight = false;
        }
        await render();
      });

      const removeClick = V.listen(root, "click", async (event) => {
        const button = event.target?.closest?.("[data-domain-action]");
        if (!button || !root.contains(button)) return;
        const action = V.clean(button.dataset.domainAction);
        if (!action) return;
        event.preventDefault();
        button.disabled = true;
        try {
          const sync = W.H2O?.Studio?.sync || {};
          const actions = {
            "desktop-export-enable": sync.autoExport?.enable,
            "desktop-export-disable": sync.autoExport?.disable,
            "desktop-focus-enable": sync.focusImport?.enable,
            "desktop-focus-disable": sync.focusImport?.disable,
            "chrome-auto-enable": sync.folder?.enableAutoSync,
            "chrome-auto-disable": sync.folder?.disableAutoSync,
            "chrome-export-enable": sync.autoImport?.enable,
            "chrome-export-disable": sync.autoImport?.disable,
          };
          const fn = actions[action];
          if (typeof fn !== "function") throw new Error("automation-action-unavailable");
          const result = await fn.call(action.startsWith("chrome-auto") ? sync.folder
            : action.startsWith("chrome-export") ? sync.autoImport
              : action.startsWith("desktop-focus") ? sync.focusImport : sync.autoExport);
          message = result?.status || (result === true || result === false ? "Configuration updated" : "Completed");
        } catch (error) {
          message = `Blocked: ${V.clean(error?.message || error) || "automation action unavailable"}`;
        }
        await render();
      });
      await render();
      return () => { disposed = true; removeModeChange(); removeClick(); };
    },
  });
})();
