// Sync Settings — parallel Legacy/New route and domain-panel authority.
//
// This module is deliberately passive: it owns route identity and the narrow
// adapters that point at existing authorities, but it never mounts UI or
// invokes a sync operation. Domain panels are presentation-only consumers;
// Legacy retirement or New route promotion requires later owner approval.
(() => {
  "use strict";

  const W = typeof globalThis !== "undefined" ? globalThis : window;
  const H2O = W.H2O = W.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.settings = H2O.Studio.settings || {};

  const freezeRoute = (route) => Object.freeze({
    ...route,
    transition: Object.freeze({ ...(route.transition || {}) }),
  });

  const NEW_AND_SHARED_ROUTES = Object.freeze([
    freezeRoute({
      id: "settings.sync-new.local-folder",
      path: "#/settings/sync-new/local-folder",
      label: "Local Folder",
      domain: "sync-new",
      architecture: "new",
      targetHostId: "h2o-settings-local-folder-panel",
      transition: { kind: "domain-panel", panelId: "h2o-settings-local-folder-panel" },
    }),
    freezeRoute({
      id: "settings.sync-new.webdav",
      path: "#/settings/sync-new/webdav",
      label: "WebDAV",
      domain: "sync-new",
      architecture: "new",
      targetHostId: "h2o-settings-webdav-panel",
      transition: { kind: "domain-panel", panelId: "h2o-settings-webdav-panel" },
    }),
    freezeRoute({
      id: "settings.sync-new.browser-delivery",
      path: "#/settings/sync-new/browser-delivery",
      label: "Browser Delivery",
      domain: "sync-new",
      architecture: "new",
      targetHostId: "h2o-settings-browser-delivery-panel",
      transition: { kind: "domain-panel", panelId: "h2o-settings-browser-delivery-panel" },
    }),
    freezeRoute({
      id: "settings.sync-new.archive-recovery",
      path: "#/settings/sync-new/archive-recovery",
      label: "Archive & Recovery",
      domain: "sync-new",
      architecture: "new",
      targetHostId: "h2o-settings-archive-recovery-panel",
      transition: { kind: "domain-panel", panelId: "h2o-settings-archive-recovery-panel" },
    }),
    freezeRoute({
      id: "settings.sync-new.automation",
      path: "#/settings/sync-new/automation",
      label: "Automation",
      domain: "sync-new",
      architecture: "new",
      targetHostId: "h2o-settings-automation-panel",
      transition: { kind: "domain-panel", panelId: "h2o-settings-automation-panel" },
    }),
    freezeRoute({
      id: "settings.sync-new.advanced",
      path: "#/settings/sync-new/advanced",
      label: "Advanced",
      domain: "sync-new",
      architecture: "new",
      targetHostId: "h2o-settings-advanced-diagnostics-panel",
      transition: { kind: "domain-panel", panelId: "h2o-settings-advanced-diagnostics-panel" },
    }),
    freezeRoute({
      id: "settings.convergence.relay-exchange",
      path: "#/settings/convergence/relay-exchange",
      label: "Relay Exchange",
      domain: "convergence",
      architecture: "shared",
      targetHostId: "h2o-settings-relay-exchange-panel",
      transition: { kind: "domain-panel", panelId: "h2o-settings-relay-exchange-panel" },
    }),
    freezeRoute({
      id: "settings.convergence.review",
      path: "#/settings/convergence/review",
      label: "Review",
      domain: "convergence",
      architecture: "shared",
      targetHostId: "h2o-convergence-review-panel",
      transition: { kind: "convergence", tool: "review" },
    }),
    freezeRoute({
      id: "settings.convergence.conflict",
      path: "#/settings/convergence/conflict",
      label: "Conflict",
      domain: "convergence",
      architecture: "shared",
      targetHostId: "h2o-manual-sync-panel",
      transition: { kind: "manual-sync", sectionIds: Object.freeze(["h2o-sync-section-conflict-review"]) },
    }),
    ...["color", "rename", "move", "delete", "binding"].map((tool) => freezeRoute({
      id: `settings.convergence.${tool}`,
      path: `#/settings/convergence/${tool}`,
      label: tool[0].toUpperCase() + tool.slice(1),
      domain: "convergence",
      architecture: "shared",
      targetHostId: `h2o-${tool === "color" ? "convergence-action" : `${tool}-convergence`}-panel`,
      transition: { kind: "convergence", tool },
    })),
    freezeRoute({
      id: "settings.activity.audit",
      path: "#/settings/activity",
      label: "Activity & Audit",
      domain: "activity",
      architecture: "shared",
      targetHostId: "h2o-settings-activity-audit-panel",
      transition: { kind: "domain-panel", panelId: "h2o-settings-activity-audit-panel" },
    }),
  ]);

  // Legacy Sync remains a first-class comparison surface through M1-M5. Stable
  // section IDs replace label matching internally without changing its visible
  // sections, controls, routes, or shared runtime ownership.
  const LEGACY_SYNC_ROUTES = Object.freeze([
    ...[
      ["status", "Status", ["h2o-sync-section-status"]],
      ["outbox", "Outbox", ["h2o-sync-section-outbox"]],
      ["inbox", "Inbox", ["h2o-sync-section-inbox"]],
      ["relay", "Relay", ["h2o-sync-section-relay"]],
      ["proposal-review", "Proposal Review", ["h2o-sync-section-proposal-review"]],
      ["conflict-review", "Conflict Review", ["h2o-sync-section-conflict-review"]],
      ["apply-log", "Apply Log", ["h2o-sync-section-apply-log"]],
      ["object-sync", "Object Sync", ["h2o-round2a-operator-panel"]],
    ].map(([slug, label, sectionIds]) => freezeRoute({
      id: `legacy.sync.${slug}`,
      path: `#/settings/sync/${slug}`,
      label,
      domain: "sync",
      architecture: "legacy",
      targetHostId: "h2o-manual-sync-panel",
      transition: { kind: "manual-sync", sectionIds: Object.freeze(sectionIds) },
    })),
    freezeRoute({
      id: "legacy.sync.webdav",
      path: "#/settings/sync/webdav",
      label: "WebDAV",
      domain: "sync",
      architecture: "legacy",
      targetHostId: "wbRealTransportWebDavSetupSubtab",
      transition: { kind: "webdav" },
    }),
  ]);

  // Pre-existing non-shell Convergence URLs remain resolvable, but they are
  // unrelated to the Legacy/New Sync comparison and stay out of both rails.
  const COMPATIBILITY_ROUTES = Object.freeze([
    freezeRoute({
      id: "legacy.convergence.snapshot",
      path: "#/settings/convergence/snapshot",
      label: "Snapshot",
      domain: "convergence",
      architecture: "shared",
      targetHostId: "h2o-snapshot-convergence-panel",
      exposed: false,
      transition: { kind: "convergence", tool: "snapshot" },
    }),
    freezeRoute({
      id: "legacy.convergence.library-sync",
      path: "#/settings/convergence/library-sync",
      label: "Library Sync",
      domain: "convergence",
      architecture: "shared",
      targetHostId: "h2o-library-sync-operator-panel",
      exposed: false,
      transition: { kind: "convergence", tool: "library-sync" },
    }),
    freezeRoute({
      id: "legacy.convergence.execute",
      path: "#/settings/convergence/execute",
      label: "Execute",
      domain: "convergence",
      architecture: "shared",
      targetHostId: "h2o-execute-lane-panel",
      exposed: false,
      transition: { kind: "convergence", tool: "execute" },
    }),
  ]);

  const normalizePath = (input) => {
    const raw = String(input || "#/settings/sync/status").trim().split("?")[0];
    const withHash = raw.startsWith("#") ? raw : `#${raw.startsWith("/") ? "" : "/"}${raw}`;
    return withHash.replace(/\/+$/, "").toLowerCase() || "#/settings/sync/status";
  };
  const PUBLIC_ROUTES = Object.freeze([
    ...LEGACY_SYNC_ROUTES,
    ...NEW_AND_SHARED_ROUTES,
    ...COMPATIBILITY_ROUTES,
  ]);
  const byPath = new Map(PUBLIC_ROUTES.map((route) => [route.path, route]));
  const defaults = Object.freeze({
    sync: LEGACY_SYNC_ROUTES.find((route) => route.id === "legacy.sync.status"),
    "sync-new": NEW_AND_SHARED_ROUTES.find((route) => route.id === "settings.sync-new.local-folder"),
    convergence: NEW_AND_SHARED_ROUTES.find((route) => route.id === "settings.convergence.review"),
    activity: NEW_AND_SHARED_ROUTES.find((route) => route.id === "settings.activity.audit"),
  });
  const SYNC_LAYOUTS = Object.freeze([
    Object.freeze({
      id: "legacy",
      label: "Legacy",
      domain: "sync",
      defaultPath: defaults.sync.path,
    }),
    Object.freeze({
      id: "new",
      label: "New",
      domain: "sync-new",
      defaultPath: defaults["sync-new"].path,
    }),
  ]);

  const resolveHash = (input) => {
    const requestedPath = normalizePath(input);
    const direct = byPath.get(requestedPath);
    if (direct) return Object.freeze({ ...direct, requestedPath, fallback: false });
    const match = requestedPath.match(/^#\/settings\/(sync|sync-new|convergence|activity)(?:\/|$)/);
    if (!match) return null;
    const fallback = defaults[match[1]];
    return Object.freeze({ ...fallback, requestedPath, fallback: true });
  };

  const api = Object.freeze({
    schema: "h2o.studio.settings.routes.v1",
    routes: PUBLIC_ROUTES,
    legacyRoutes: LEGACY_SYNC_ROUTES,
    newRoutes: Object.freeze(NEW_AND_SHARED_ROUTES.filter((route) => route.architecture === "new")),
    compatibilityRoutes: COMPATIBILITY_ROUTES,
    syncLayouts: SYNC_LAYOUTS,
    domains: Object.freeze([
      Object.freeze({ id: "sync", label: "Sync", path: "#/settings/sync/status" }),
      Object.freeze({ id: "convergence", label: "Convergence", path: "#/settings/convergence/relay-exchange" }),
      Object.freeze({ id: "activity", label: "Activity & Audit", path: "#/settings/activity" }),
    ]),
    resolveHash,
    resolve: (domain, subsection = "") => resolveHash(
      domain === "activity"
        ? "#/settings/activity"
        : `#/settings/${String(domain || "sync")}/${String(subsection || "")}`
    ),
    list: (domain) => PUBLIC_ROUTES.filter((route) =>
      route.domain === String(domain || "") && route.exposed !== false),
  });

  H2O.Studio.settings.routes = api;
})();
