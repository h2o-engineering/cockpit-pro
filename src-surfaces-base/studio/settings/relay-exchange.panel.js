// Sync Settings M3 — transport-neutral Relay Exchange over existing queues/index.
(() => {
  "use strict";
  const W = typeof globalThis !== "undefined" ? globalThis : window;
  const panels = W.H2O?.Studio?.settings?.domainPanels;
  if (!panels) return;
  const V = panels.view;

  function project(outbox, inbox, index) {
    const outRows = Array.isArray(outbox?.rows) ? outbox.rows : [];
    const inRows = Array.isArray(inbox?.rows) ? inbox.rows : [];
    const entries = Array.isArray(index?.entries) ? index.entries : [];
    return Object.freeze({
      rows: Object.freeze([
        ["Outbox", `${Number(outbox?.counts?.rows) || outRows.length} total · ${Number(outbox?.counts?.pendingUpload) || 0} pending upload`],
        ["Inbox", `${Number(inbox?.counts?.rows) || inRows.length} total · ${Number(inbox?.counts?.pendingReview) || 0} pending review`],
        ["Index", `${Number(index?.counts?.total) || entries.length} derived entries`],
        ["Duplicates", String(Number(index?.counts?.duplicates) || 0)],
        ["Replay attempts", String(Number(index?.counts?.replayAttempts) || 0)],
        ["Blocked", String(Number(index?.counts?.blocked) || 0)],
      ]),
      entries: Object.freeze(entries.slice(0, 12).map((entry) => Object.freeze({
        kind: V.valueText(entry.kind, "unknown"),
        direction: V.valueText(entry.direction, "local"),
        status: V.valueText(entry.relayStatus, "unknown"),
      }))),
    });
  }

  function entryRows(entries) {
    if (!entries.length) return '<p style="margin:0;opacity:.7;font-size:12px">No relay envelopes are currently indexed.</p>';
    return `<div style="display:grid;gap:7px">${entries.map((entry) => `<div style="display:grid;grid-template-columns:1fr auto auto;gap:8px;padding:8px;border:1px solid rgba(255,255,255,.07);border-radius:8px"><strong>${V.escapeHtml(entry.kind)}</strong><span style="opacity:.7">${V.escapeHtml(entry.direction)}</span><span style="opacity:.7">${V.escapeHtml(entry.status)}</span></div>`).join("")}</div>`;
  }

  panels.register({
    routeId: "settings.convergence.relay-exchange",
    panelId: "h2o-settings-relay-exchange-panel",
    authority: {
      displaySources: [
        "H2O.Desktop.Sync.listRelayOutbox",
        "H2O.Desktop.Sync.listRelayInbox",
        "H2O.Desktop.Sync.listRelayIndex",
      ],
      actionApis: ["legacy Outbox Publish", "legacy Pull / Relay"],
      persistenceOwners: ["existing relay-outbox", "existing relay-inbox", "derived relay-index"],
    },
    test: Object.freeze({ project }),
    async mount(host) {
      const root = V.frame(host, {
        routeId: "settings.convergence.relay-exchange",
        panelId: "h2o-settings-relay-exchange-panel",
        intro: "Outbox, Pull / Relay, and Inbox are one transport-neutral exchange feeding Convergence. This view creates no queue and performs no transport on open.",
        body: V.card("Relay Exchange", "<p style=\"margin:0;opacity:.7\">Reading the existing queues…</p>"),
      });
      let disposed = false;
      let message = "";
      async function render() {
        const sync = W.H2O?.Desktop?.Sync || {};
        const available = typeof sync.listRelayOutbox === "function" &&
          typeof sync.listRelayInbox === "function" &&
          typeof sync.listRelayIndex === "function";
        let outbox = null;
        let inbox = null;
        let index = null;
        try {
          if (!available) throw new Error("desktop-relay-authority-unavailable-on-this-platform");
          [outbox, inbox, index] = await Promise.all([
            sync.listRelayOutbox?.(),
            sync.listRelayInbox?.(),
            sync.listRelayIndex?.(),
          ]);
        } catch (error) {
          message = `Read blocked: ${V.clean(error?.message || error) || "relay authority unavailable"}`;
        }
        if (disposed) return;
        const model = project(outbox, inbox, index);
        V.setBody(root,
          V.card("Capability", V.statusRows([["Platform", available ? "Desktop Studio" : "Unavailable on this platform"]])) +
          (available ? V.card("Exchange state", V.statusRows(model.rows)) : "") +
          (available ? V.card("Redacted envelope index", entryRows(model.entries)) : "") +
          V.card("Operator actions", `<div style="display:flex;gap:8px;flex-wrap:wrap">${V.link("#/settings/sync/outbox", "Open Legacy Outbox")}${V.link("#/settings/sync/relay", "Open Legacy Pull / Relay")}${V.link("#/settings/sync/inbox", "Open Legacy Inbox")}${V.action("refresh", "Refresh")}</div><p style="margin:0;opacity:.72;font-size:12px">${V.escapeHtml(message || "The links operate the same queues; no relay persistence is duplicated.")}</p>`)
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
