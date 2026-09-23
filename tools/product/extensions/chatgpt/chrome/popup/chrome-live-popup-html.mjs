// @version 1.1.0
import { resolveChromeBuildVisibilityFromEnvironment } from "../chrome-live-build-context.mjs";

const SETTINGS_ICON = `<svg class="settings-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/>
  <path d="M19.4 15a1.9 1.9 0 0 0 .4 2.1l.1.1a2.3 2.3 0 0 1-1.6 3.9 2.3 2.3 0 0 1-1.6-.7l-.1-.1a1.9 1.9 0 0 0-2.1-.4 1.9 1.9 0 0 0-1.1 1.8V22a2.3 2.3 0 0 1-4.6 0v-.2a1.9 1.9 0 0 0-1.1-1.8 1.9 1.9 0 0 0-2.1.4l-.1.1a2.3 2.3 0 0 1-1.6.7 2.3 2.3 0 0 1-1.6-3.9l.1-.1A1.9 1.9 0 0 0 4.6 15a1.9 1.9 0 0 0-1.8-1.1H2.6a2.3 2.3 0 0 1 0-4.6h.2A1.9 1.9 0 0 0 4.6 8a1.9 1.9 0 0 0-.4-2.1l-.1-.1A2.3 2.3 0 0 1 5.7 1.9c.6 0 1.2.2 1.6.7l.1.1A1.9 1.9 0 0 0 9.5 3a1.9 1.9 0 0 0 1.1-1.8V1a2.3 2.3 0 0 1 4.6 0v.2A1.9 1.9 0 0 0 16.3 3a1.9 1.9 0 0 0 2.1-.4l.1-.1c.4-.5 1-.7 1.6-.7a2.3 2.3 0 0 1 1.6 3.9l-.1.1A1.9 1.9 0 0 0 19.4 9a1.9 1.9 0 0 0 1.8 1.1h.2a2.3 2.3 0 0 1 0 4.6h-.2A1.9 1.9 0 0 0 19.4 15z"/>
</svg>`;

export function makeChromeLivePopupHtml({
  panelLogoPath = "panel-icons/icon128.png",
  titleDiagnosticEnabled = false,
} = {}) {
  // T03 (leased, additive; semantic owner L-DEVELOPER-CONTROLS): opt-in loaded-build
  // identity surface plus stable qualification anchors. Without the opt-in build
  // context every byte below is unchanged.
  const visibility = resolveChromeBuildVisibilityFromEnvironment();
  const q = (name) => (visibility.enabled ? ` data-h2o-qual="${name}"` : "");
  const escapeAttr = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const envBadge = visibility.enabled
    ? `
            <div class="h2o-env-badge" id="h2o-env-badge" data-h2o-qual="env-identity-badge" title="Loaded environment · surface · build (read-only)" aria-label="Loaded environment identity" data-built-for-lane="${escapeAttr(visibility.laneKey)}" data-built-for-surface="${escapeAttr(visibility.surfaceSet)}" data-build-version-name="${escapeAttr(visibility.versionName)}" data-source-revision="${escapeAttr(visibility.sourceRevision)}">${escapeAttr(visibility.laneKey)} · ${escapeAttr(visibility.surfaceSet)} · ${escapeAttr(visibility.versionName)}</div>`
    : "";
  const envIdentityDetail = visibility.enabled
    ? `
              <section class="info-panel h2o-env-identity" id="h2o-env-identity" data-h2o-qual="env-identity-detail" data-h2o-diagnostics-build="${titleDiagnosticEnabled ? "1" : "0"}" aria-labelledby="h2o-env-identity-head">
                <div class="info-head" id="h2o-env-identity-head">Loaded build identity</div>
                <dl class="h2o-env-identity-list" id="h2o-env-identity-list" aria-live="off"></dl>
              </section>
`
    : "";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>H2O Dev Controls</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div class="app" id="app"${q("popup-root")}>
    <aside class="leftbar-rail" id="leftbar-rail" aria-label="Collapsed leftbar" hidden>
      <div class="leftbar-rail-top">
        <button type="button" class="logo-toggle rail-logo-toggle" id="rail-logo-toggle" title="Open leftbar" aria-label="Open leftbar" aria-pressed="true">
          <img class="brand-logo rail-brand-logo" src="${panelLogoPath}" alt="H2O logo" width="20" height="20">
        </button>
        <div class="leftbar-rail-tabs" role="tablist" aria-label="Collapsed leftbar tabs">
          <button type="button" class="leftbar-rail-btn" data-rail-tab="main" title="Main">M</button>
          <button type="button" class="leftbar-rail-btn" data-rail-tab="info" title="Info">I</button>
          <button type="button" class="leftbar-rail-btn" data-rail-tab="hidden" title="Hidden">H</button>
        </div>
      </div>
      <div class="leftbar-rail-bottom">
        <button type="button" class="leftbar-rail-btn leftbar-rail-settings" id="rail-settings" title="Settings" aria-label="Settings">${SETTINGS_ICON}</button>
      </div>
    </aside>

    <aside class="controls">
      <header class="top">
        <div class="brand">
          <button type="button" class="logo-toggle brand-logo-btn" id="logo-toggle" title="Toggle leftbar" aria-label="Toggle leftbar" aria-pressed="false">
            <img class="brand-logo" src="${panelLogoPath}" alt="H2O logo" width="20" height="20">
          </button>
          <div class="brand-copy">
            <button
              type="button"
              class="brand-title-btn"
              id="brand-title-toggle"
              title="Double-click to reveal utility controls"
              aria-label="H2O Dev Controls utility controls"
              aria-haspopup="true"
              aria-expanded="false"
            >
              <span class="brand-title">H2O Dev Controls</span>
            </button>
            <div class="brand-utility" id="brand-utility" hidden>
              <div class="brand-utility-row" role="toolbar" aria-label="Popup utility controls">
                <button type="button" class="header-util-btn" id="appearance-toggle" aria-haspopup="true" aria-expanded="false">Appearance</button>
                <button type="button" class="header-util-btn" id="settings-toggle" aria-haspopup="true" aria-expanded="false">Settings</button>
              </div>
              <div class="header-util-pop appearance-pop" id="appearance-pop" hidden>
                <div class="settings-head">Appearance</div>
                <section class="settings-section">
                  <div class="settings-label">Background</div>
                  <div class="settings-row" id="bg-mode-dots" aria-label="Background mode">
                    <button type="button" class="bg-mode-btn" data-popup-bg-mode="body" title="Body mode">Body</button>
                    <button type="button" class="bg-mode-btn" data-popup-bg-mode="bar" title="Bar mode">Bar</button>
                    <button type="button" class="bg-mode-btn" data-popup-bg-mode="side" title="Side mode">Side</button>
                  </div>
                </section>
              </div>
              <div class="header-util-pop settings-pop" id="settings-pop" hidden>
                <div class="settings-head">Settings</div>
                <section class="settings-section">
                  <div class="settings-label">Workflow</div>
                  <div class="settings-note">Reserved for panel behavior defaults and reset actions.</div>
                </section>
                <section class="settings-section">
                  <div class="settings-label">Later</div>
                  <div class="settings-note">Prepared for future dev preferences like reload/default-state/sort/reset options.</div>
                </section>
              </div>
            </div>
            <div class="brand-swatch-row" aria-label="Project colors">
              <button type="button" class="project-color-dot is-blue" title="Project blue"></button>
              <button type="button" class="project-color-dot is-red" title="Project red"></button>
              <button type="button" class="project-color-dot is-green" title="Project green"></button>
              ${titleDiagnosticEnabled ? `<button type="button" class="project-color-dot is-yellow" title="Open Diagnostics Workspace" aria-label="Open Diagnostics Workspace" data-popup-action="open-diagnostics"${q("yellow-action")}></button>` : ""}
            </div>${envBadge}
          </div>
        </div>
      </header>

      <div class="controls-main" id="controls-main">
        <div class="controls-tabs" role="tablist" aria-label="Control sections">
          <button
            type="button"
            class="controls-tab active"
            id="controls-tab-main"
            data-controls-tab="main"
            role="tab"
            aria-selected="true"
            aria-controls="controls-page-main"
          >Main</button>
          <button
            type="button"
            class="controls-tab"
            id="controls-tab-info"
            data-controls-tab="info"
            role="tab"
            aria-selected="false"
            aria-controls="controls-page-info"
          >Info</button>
          <button
            type="button"
            class="controls-tab controls-tab-hidden"
            id="controls-tab-hidden"
            data-controls-tab="hidden"
            role="tab"
            aria-selected="false"
            aria-controls="controls-page-hidden"
            title="Hidden scripts"
          >Hidden</button>
        </div>

        <div class="controls-pages">
          <div class="controls-page is-active" id="controls-page-main" data-controls-page="main" role="tabpanel"${q("main-page")}>
            <div class="controls-page-scroll">
              <section class="actions-panel">
                <div class="actions-head">Quick Actions</div>
                <div class="actions">
                  <button id="all-on" type="button"${q("action-all-on")}>All On</button>
                  <button id="all-off" type="button"${q("action-all-off")}>All Off</button>
                  <button id="page-off" type="button" title="Reload the active tab once with H2O scripts disabled">This Page Off</button>
                  <button id="reload" type="button">Reload Tab</button>
                  <button id="reset" type="button">Reset</button>
                  <button id="reset-layout" type="button">Reset Layout</button>
                </div>
              </section>

              <section class="actions-panel" id="identity-provider-permission-panel" hidden${q("identity-provider-panel")}>
                <div class="actions-head">Dev Auth</div>
                <div class="actions">
                  <button id="grant-supabase-permission" type="button">Grant Supabase Permission</button>
                </div>
                <div id="identity-provider-permission-status" class="settings-note">Provider permission not ready.</div>
              </section>

              <section class="sets">
                <div class="sets-head">
                  <div class="sets-title">Sets</div>
                  <div id="sets-meta" class="sets-meta">0 saved</div>
                </div>
                <div class="set-slots" id="set-slots"${q("set-slots")}></div>
                <label class="set-click-opt">
                  <input id="set-click-reload" type="checkbox" checked>
                  <span>Reload on set click</span>
                </label>
                <div class="sets-subtitle">Save to Set</div>
                <div class="set-actions">
                  <button id="set-save" type="button"${q("set-save")}>Save</button>
                  <button id="set-edit" type="button">Edit</button>
                  <button id="set-clear" type="button">Clear</button>
                </div>
                <div class="page-set-row">
                  <div class="sets-subtitle">Page Binding</div>
                  <div id="page-set-status" class="page-set-status" data-mode="none">Resolved now: Select Global</div>
                  <label class="binding-row">
                    <span class="page-set-title">This Chat</span>
                    <select id="page-set-chat">
                      <option value="0">None</option>
                      <option value="1">Set 1</option>
                      <option value="2">Set 2</option>
                      <option value="3">Set 3</option>
                      <option value="4">Set 4</option>
                      <option value="5">Set 5</option>
                      <option value="6">Set 6</option>
                    </select>
                  </label>
                  <label class="binding-row">
                    <span class="page-set-title">Global</span>
                    <select id="page-set-global">
                      <option value="0">None</option>
                      <option value="1">Set 1</option>
                      <option value="2">Set 2</option>
                      <option value="3">Set 3</option>
                      <option value="4">Set 4</option>
                      <option value="5">Set 5</option>
                      <option value="6">Set 6</option>
                    </select>
                  </label>
                  <label class="binding-opt">
                    <input id="page-set-bypass" type="checkbox">
                    <span>Turn off all scripts when reload</span>
                  </label>
                </div>
              </section>
            </div>
            <div class="controls-tail-anchor" data-settings-anchor="main"></div>
          </div>

          <div class="controls-page" id="controls-page-info" data-controls-page="info" role="tabpanel" hidden${q("info-page")}>
            <div class="controls-page-scroll">
              <div class="meta">
                <div class="meta-head">Info</div>
                <div id="counts">Loading...</div>
                <div id="pack-url" class="mono"></div>
                <div id="totals" class="totals"></div>
              </div>

              <section class="info-panel">
                <div class="info-head">Columns</div>
                <label class="adv-opt">
                  <input id="advanced-runtime" type="checkbox">
                  <span>Advanced runtime (load last + ewma)</span>
                </label>
                <div class="info-grid" id="info-grid"${q("info-grid")}></div>
              </section>
${envIdentityDetail}
            </div>
            <div class="controls-tail-anchor" data-settings-anchor="info"></div>
          </div>

          <div class="controls-page" id="controls-page-hidden" data-controls-page="hidden" role="tabpanel" hidden>
            <div class="controls-page-scroll">
              <section class="off-window" id="off-window">
                <header class="off-window-head">
                  <div class="off-window-title">Hidden Scripts</div>
                  <div class="off-window-count" id="off-window-count">0 non-visible</div>
                </header>
                <div class="off-window-body" id="off-window-body"></div>
              </section>
            </div>
            <div class="controls-tail-anchor" data-settings-anchor="hidden"></div>
          </div>
        </div>

        <div class="controls-tail-dock" id="controls-tail-dock" hidden aria-hidden="true"></div>
        <div class="hint" id="hint" aria-live="polite"></div>
      </div>
    </aside>

    <div class="list" id="list"${q("controls-inventory")}>
      <div class="table-shell" id="table-shell"></div>
    </div>

    ${titleDiagnosticEnabled ? `<section class="diagnostics-workspace" id="diagnostics-workspace" aria-labelledby="diagnostics-workspace-title" hidden${q("diagnostics-workspace")}>
      <aside class="diagnostics-sidebar" id="diagnostics-sidebar" aria-label="Diagnostics navigation and controls">
        <div class="diagnostics-sidebar-head">
          <div class="diagnostics-eyebrow">Developer tools</div>
          <h1 id="diagnostics-workspace-title">Diagnostics</h1>
          <p>Passive, bounded evidence from the existing H2O extension.</p>
        </div>
        <nav class="diagnostics-module-nav" id="diagnostics-module-list" aria-label="Diagnostic modules"></nav>
        <section class="diagnostics-selected-controls" aria-labelledby="diagnostics-controls-title">
          <div class="diagnostics-controls-head">
            <h2 id="diagnostics-controls-title">Selected controls</h2>
            <span class="diagnostics-state-badge" id="title-diag-sidebar-state" data-run-state="idle">Idle</span>
          </div>
          <div class="diagnostics-action-grid" role="group" aria-label="Title navigation diagnostic controls">
            <button id="title-diag-reset" type="button">Reset evidence</button>
            <button id="title-diag-arm" type="button" class="is-primary">Arm next navigation</button>
            <button id="title-diag-status" type="button">Refresh status</button>
            <button id="title-diag-export" type="button">Export evidence</button>
            <button id="title-diag-clear" type="button" class="is-danger">Clear evidence</button>
          </div>
          <div class="diagnostics-command-status" id="title-diag-command-status" role="status" aria-live="polite"></div>
          <div class="diagnostics-command-error" id="title-diag-command-error" role="alert" hidden></div>
        </section>
      </aside>

      <main class="diagnostics-detail" id="diagnostics-detail" tabindex="-1">
        <header class="diagnostics-detail-head">
          <div>
            <div class="diagnostics-eyebrow">Stage 0B-2B · passive navigation evidence</div>
            <h2 id="title-diag-detail-title">Title navigation diagnostic</h2>
            <p id="title-diag-detail-description">Capture one manual chat-to-chat navigation across document replacement.</p>
          </div>
          <div class="diagnostics-detail-state">
            <span class="diagnostics-state-badge is-large" id="title-diag-state" data-run-state="idle">Idle</span>
            <span id="title-diag-last-updated">Not refreshed</span>
            <span id="title-diag-completion-reason" hidden></span>
          </div>
        </header>

        <section class="diagnostics-empty" id="title-diag-empty">
          <div class="diagnostics-empty-mark" aria-hidden="true">⌁</div>
          <h3>Ready for a passive capture</h3>
          <p>Arm once, then navigate manually to another quiet normal chat. The diagnostic never navigates, renames, or changes title state on its own.</p>
        </section>

        <div class="diagnostics-report" id="title-diag-report" hidden>
          <section class="diagnostics-summary-grid" aria-label="Diagnostic summary">
            <article class="diagnostics-summary-card"><span>Events</span><strong id="title-diag-event-count">0</strong></article>
            <article class="diagnostics-summary-card"><span>Documents</span><strong id="title-diag-document-count">0</strong></article>
            <article class="diagnostics-summary-card"><span>Loader marker</span><strong id="title-diag-marker-match">Unknown</strong></article>
            <article class="diagnostics-summary-card"><span>Timeout</span><strong id="title-diag-timeout">No</strong></article>
            <article class="diagnostics-summary-card" id="title-diag-overflow-card" hidden><span>Dropped / overflow</span><strong id="title-diag-overflow">0</strong></article>
          </section>

          <div class="diagnostics-info-grid">
            <section class="diagnostics-panel" aria-labelledby="title-diag-build-heading">
              <div class="diagnostics-panel-head"><h3 id="title-diag-build-heading">Build identity</h3></div>
              <dl class="diagnostics-kv" id="title-diag-build"></dl>
            </section>
            <section class="diagnostics-panel" aria-labelledby="title-diag-navigation-heading">
              <div class="diagnostics-panel-head"><h3 id="title-diag-navigation-heading">Navigation summary</h3></div>
              <dl class="diagnostics-kv" id="title-diag-navigation"></dl>
            </section>
          </div>

          <section class="diagnostics-panel" aria-labelledby="title-diag-documents-heading">
            <div class="diagnostics-panel-head"><h3 id="title-diag-documents-heading">Documents</h3><span id="title-diag-documents-note"></span></div>
            <div class="diagnostics-table-wrap">
              <table class="diagnostics-table">
                <thead><tr><th>Seq</th><th>Trusted document</th><th>Lifecycle</th><th>Route</th><th>Content instance</th><th>Page instance</th><th>Ready timing</th></tr></thead>
                <tbody id="title-diag-documents"></tbody>
              </table>
            </div>
          </section>

          <section class="diagnostics-panel" aria-labelledby="title-diag-events-heading">
            <div class="diagnostics-panel-head diagnostics-panel-head-wrap">
              <h3 id="title-diag-events-heading">Timeline</h3>
              <div class="diagnostics-filter-row" id="title-diag-event-filters" role="group" aria-label="Filter diagnostic events"></div>
            </div>
            <div class="diagnostics-timeline" id="title-diag-events"></div>
          </section>

          <section class="diagnostics-panel diagnostics-warnings" id="title-diag-warnings-panel" aria-labelledby="title-diag-warnings-heading" hidden>
            <div class="diagnostics-panel-head"><h3 id="title-diag-warnings-heading">Warnings and errors</h3></div>
            <ul id="title-diag-warnings"></ul>
          </section>

          <details class="diagnostics-raw" id="title-diag-raw-details">
            <summary>Raw sanitized evidence</summary>
            <div class="diagnostics-raw-actions"><button type="button" id="title-diag-copy-raw">Copy sanitized JSON</button></div>
            <pre id="title-diag-raw" tabindex="0"></pre>
          </details>
        </div>
      </main>
    </section>` : ""}
  </div>
  <script src="popup.js"></script>
  ${titleDiagnosticEnabled ? `<script src="title-navigation-diagnostic-popup.js"></script>` : ""}
</body>
</html>
`;
}
