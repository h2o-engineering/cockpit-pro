// Sync Settings M3 — WebDAV status adapter over the existing setup/runtime owner.
(() => {
  "use strict";
  const W = typeof globalThis !== "undefined" ? globalThis : window;
  const panels = W.H2O?.Studio?.settings?.domainPanels;
  if (!panels) return;
  const V = panels.view;

  function project(facts, platform = "desktop") {
    const value = facts || {};
    if (platform === "chrome") {
      return Object.freeze({
        rows: Object.freeze([
          ["Status", "Desktop Studio required"],
          ["Why it's blocked", "WebDAV setup and remote sync run in Desktop Studio."],
        ]),
        ready: false,
      });
    }
    const rows = [
      ["Server settings", value.descriptorValid === true ? "Configured" : "Not configured"],
      ["Credentials", value.credentialsReady === true ? "Ready (redacted)" : "Not ready"],
      ["Server reachable", value.reachabilityReady === true ? "Known available" : "Not established"],
      ["Status", value.ready === true ? "Ready" : (value.configured === true || value.descriptorValid === true ? "Blocked" : "Not configured")],
    ];
    if (value.ready !== true && V.clean(value.reason)) rows.push(["Why it's blocked", value.reason]);
    return Object.freeze({
      rows: Object.freeze(rows),
      ready: value.ready === true,
    });
  }

  function presentation(platform = "desktop") {
    const chrome = platform === "chrome";
    return Object.freeze({
      desktopRequired: chrome,
      actions: Object.freeze(chrome ? [] : ["setup", "publish-pull", "refresh"]),
      guidance: chrome ? "Open H2O Studio Desktop to configure and use WebDAV." : "",
    });
  }

  panels.register({
    routeId: "settings.sync-new.webdav",
    panelId: "h2o-settings-webdav-panel",
    authority: {
      displaySources: [
        "H2O.Studio.sync.getReadinessSnapshot.webdav",
        "H2O.Studio.sync.realTransportWebDavSetupUi.getReadinessFacts",
      ],
      actionApis: ["legacy.sync.webdav setup authority", "legacy Object Sync Publish / Pull & Apply"],
      persistenceOwners: ["existing WebDAV descriptor authority", "OS credential authority"],
    },
    test: Object.freeze({ project, presentation }),
    async mount(host, context = {}) {
      const platform = context.platform === "chrome" ? "chrome" : "desktop";
      const root = V.frame(host, {
        routeId: "settings.sync-new.webdav",
        panelId: "h2o-settings-webdav-panel",
        intro: "Remote sync. Local Desktop ↔ Chrome transfer keeps working when WebDAV is unavailable.",
        body: V.card("WebDAV Remote Sync", "<p style=\"margin:0;opacity:.7\">Reading the existing local setup authority…</p>"),
      });
      let disposed = false;
      async function render() {
        const sync = W.H2O?.Studio?.sync || {};
        const api = sync.realTransportWebDavSetupUi;
        let facts = null;
        let error = "";
        try {
          const snapshot = await sync.getReadinessSnapshot?.({ uiMounted: true });
          facts = snapshot?.webdav || await api?.getReadinessFacts?.();
        }
        catch (value) { error = V.clean(value?.message || value); }
        if (disposed) return;
        const model = project(facts, platform);
        const presentationModel = presentation(platform);
        const configuration = presentationModel.desktopRequired
          ? V.card("WebDAV availability", `<p style="margin:0;opacity:.72;font-size:12px;line-height:1.5">${V.escapeHtml(presentationModel.guidance)}</p>`)
          : V.card("Configuration and operations", `<p style="margin:0;opacity:.72;font-size:12px;line-height:1.5">The established WebDAV setup surface has a single form host. This New view reads its public redacted status; setup, Publish, and Pull & Apply continue to invoke that same Legacy authority rather than creating a second credential form or transport.</p><div style="display:flex;gap:8px;flex-wrap:wrap">${V.link("#/settings/sync/webdav", "Open shared WebDAV setup")}${V.link("#/settings/sync/object-sync", "Open shared Publish / Pull controls")}${V.action("refresh", "Refresh local status")}</div>${error ? `<p style="margin:0;color:#fca5a5;font-size:12px">${V.escapeHtml(error)}</p>` : ""}`);
        V.setBody(root,
          V.card("WebDAV status", V.statusRows(model.rows)) +
          configuration
        );
      }
      const removeClick = V.listen(root, "click", async (event) => {
        const button = event.target?.closest?.('[data-domain-action="refresh"]');
        if (!button || !root.contains(button)) return;
        event.preventDefault();
        await render();
      });
      await render();
      return () => { disposed = true; removeClick(); };
    },
  });
})();
