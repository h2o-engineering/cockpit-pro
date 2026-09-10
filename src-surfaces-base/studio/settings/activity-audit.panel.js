// Sync Settings M3 — neutral read-only Activity & Audit over the relay index.
(() => {
  "use strict";
  const W = typeof globalThis !== "undefined" ? globalThis : window;
  const panels = W.H2O?.Studio?.settings?.domainPanels;
  if (!panels) return;
  const V = panels.view;
  const FAMILIES = Object.freeze([
    ["convergence-binding", "Convergence / binding"],
    ["delete", "Delete"],
    ["move", "Move"],
    ["rename", "Rename"],
    ["folder-metadata-color", "Folder apply / metadata / color"],
    ["remote-apply-preview", "Remote apply preview"],
    ["snapshot-archive-receipt", "Snapshot / archive receipt"],
    ["other-apply", "Other apply receipt"],
  ]);

  function project(index) {
    const entries = (Array.isArray(index?.entries) ? index.entries : [])
      .filter((entry) => V.clean(entry?.kind) === "applyEvent");
    const counts = Object.fromEntries(FAMILIES.map(([id]) => [id, 0]));
    for (const entry of entries) {
      const family = V.clean(entry.activityFamily) || "other-apply";
      counts[Object.prototype.hasOwnProperty.call(counts, family) ? family : "other-apply"] += 1;
    }
    return Object.freeze({
      total: entries.length,
      families: Object.freeze(FAMILIES.map(([id, label]) => Object.freeze([label, String(counts[id])]))),
      entries: Object.freeze(entries.slice(0, 20).map((entry) => Object.freeze({
        family: FAMILIES.find(([id]) => id === entry.activityFamily)?.[1] || "Other apply receipt",
        direction: V.valueText(entry.direction, "local"),
        status: V.valueText(entry.relayStatus, "unknown"),
        at: V.valueText(entry.uploadTimestamp || entry.downloadTimestamp, "Time unavailable"),
      }))),
    });
  }

  function eventRows(entries) {
    if (!entries.length) return '<p style="margin:0;opacity:.7;font-size:12px">No apply-event receipts are currently indexed.</p>';
    return `<div style="display:grid;gap:7px">${entries.map((entry) => `<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 12px;padding:9px;border:1px solid rgba(255,255,255,.07);border-radius:8px"><strong>${V.escapeHtml(entry.family)}</strong><span style="opacity:.7">${V.escapeHtml(entry.status)}</span><span style="opacity:.67;font-size:12px">${V.escapeHtml(entry.direction)}</span><time style="opacity:.67;font-size:12px">${V.escapeHtml(entry.at)}</time></div>`).join("")}</div>`;
  }

  panels.register({
    routeId: "settings.activity.audit",
    panelId: "h2o-settings-activity-audit-panel",
    authority: {
      displaySources: ["H2O.Desktop.Sync.listRelayIndex activityFamily projection"],
      actionApis: ["read-only refresh", "legacy Apply Log navigation"],
      persistenceOwners: ["existing relay outbox/inbox apply-event receipts"],
    },
    test: Object.freeze({ project, families: FAMILIES }),
    async mount(host) {
      const root = V.frame(host, {
        routeId: "settings.activity.audit",
        panelId: "h2o-settings-activity-audit-panel",
        intro: "A neutral, read-only view of existing apply-event receipts across domains. It has no apply or persistence API.",
        body: V.card("Activity & Audit", "<p style=\"margin:0;opacity:.7\">Reading the existing redacted index…</p>"),
      });
      let disposed = false;
      let message = "";
      async function render() {
        const available = typeof W.H2O?.Desktop?.Sync?.listRelayIndex === "function";
        let index = null;
        try {
          if (!available) throw new Error("desktop-activity-authority-unavailable-on-this-platform");
          index = await W.H2O.Desktop.Sync.listRelayIndex();
        }
        catch (error) { message = `Read blocked: ${V.clean(error?.message || error) || "audit authority unavailable"}`; }
        if (disposed) return;
        const model = project(index);
        V.setBody(root,
          V.card("Capability", V.statusRows([["Platform", available ? "Desktop Studio" : "Unavailable on this platform"]])) +
          (available ? V.card("Receipt families", V.statusRows([["Total apply events", String(model.total)], ...model.families])) : "") +
          (available ? V.card("Recent redacted activity", eventRows(model.entries)) : "") +
          V.card("Read-only controls", `<div style="display:flex;gap:8px;flex-wrap:wrap">${V.action("refresh", "Refresh")}${V.link("#/settings/sync/apply-log", "Open Legacy Apply Log")}</div><p style="margin:0;opacity:.72;font-size:12px">${V.escapeHtml(message || "Refresh reads the same derived index; it cannot apply or mutate an event.")}</p>`)
        );
      }
      const removeClick = V.listen(root, "click", async (event) => {
        const button = event.target?.closest?.('[data-domain-action="refresh"]');
        if (!button || !root.contains(button)) return;
        event.preventDefault();
        message = "Refreshed from the existing relay index.";
        await render();
      });
      await render();
      return () => { disposed = true; removeClick(); };
    },
  });
})();
