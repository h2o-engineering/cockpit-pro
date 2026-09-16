// @version 1.0.0
import { resolveChromeBuildVisibilityFromEnvironment } from "../chrome-live-build-context.mjs";

export function makeChromeLivePopupCss() {
  // T03 (leased, additive): identity-surface styles are appended only for opt-in builds.
  const buildVisibility = resolveChromeBuildVisibilityFromEnvironment();
  return `:root {
  --bg: #121314;
  --panel: #1a1c1f;
  --line: #2b2f35;
  --text: #eceff3;
  --muted: #a6adb8;
  --accent: #8dd35f;
  --danger: #ff7a7a;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
}
body[data-bg-mode="body"] {
  --bg: #2a2a2a;
  --panel: #242424;
  --line: #3a3a3a;
}
body[data-bg-mode="bar"] {
  --bg: #212121;
  --panel: #1e1e1e;
  --line: #343434;
}
body[data-bg-mode="side"] {
  --bg: #141414;
  --panel: #171717;
  --line: #2a2a2a;
}
body {
  width: 900px;
  min-width: 800px;
  max-width: 800px;
  height: 600px;
  font: 12px/1.3 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}
.app {
  --leftbar-width: 214px;
  --leftbar-track-width: 214px;
  --leftbar-rail-width: 36px;
  --leftbar-rail-collapsed-left: 4px;
  --panel-pad-top: 10px;
  --panel-pad-right: 10px;
  --panel-pad-bottom: 10px;
  --panel-pad-left: 10px;
  --brand-logo-size: 30px;
  --app-gap: 10px;
  width: 100%;
  padding: var(--panel-pad-top) var(--panel-pad-right) var(--panel-pad-bottom) var(--panel-pad-left);
  display: grid;
  grid-template-columns: var(--leftbar-track-width) minmax(0, 1fr);
  gap: var(--app-gap);
  height: 100%;
  min-height: 0;
  max-width: 100%;
  justify-content: start;
  overflow-x: hidden;
  position: relative;
}
.app.leftbar-collapsed {
  --leftbar-width: 0px;
  --leftbar-track-width: 0px;
  --app-gap: 0px;
}
.leftbar-rail {
  display: none;
  position: absolute;
  top: var(--panel-pad-top);
  bottom: var(--panel-pad-bottom);
  left: var(--panel-pad-left);
  width: 36px;
  min-width: 36px;
  min-height: auto;
  border: 0;
  border-right: 1px solid rgba(255,255,255,.09);
  border-radius: 0;
  background: var(--bg);
  box-shadow: none;
  padding: 6px 5px 2px;
  align-items: stretch;
  justify-content: space-between;
  flex-direction: column;
  gap: 8px;
  z-index: 40;
}
.leftbar-rail[hidden] {
  display: none !important;
}
.app.leftbar-collapsed .leftbar-rail {
  display: flex;
  left: var(--leftbar-rail-collapsed-left);
}
.leftbar-rail-top,
.leftbar-rail-bottom {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  width: 100%;
}
.leftbar-rail-bottom {
  margin-top: auto;
}
.leftbar-rail-tabs {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  width: 100%;
}
.logo-toggle {
  appearance: none;
  border: 0;
  padding: 0;
  margin: 0;
  background: transparent;
  cursor: pointer;
  flex: 0 0 auto;
}
.rail-logo-toggle,
.brand-logo-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--brand-logo-size);
  height: var(--brand-logo-size);
  flex: 0 0 var(--brand-logo-size);
}
.rail-logo-toggle {
  align-self: center;
}
.leftbar-rail-btn {
  appearance: none;
  width: 100%;
  min-width: 0;
  height: 20px;
  min-height: 20px;
  padding: 0;
  border: 1px solid rgba(255,255,255,.14);
  border-radius: 6px;
  background: rgba(255,255,255,.04);
  color: var(--muted);
  font-size: 9px;
  line-height: 1;
  font-weight: 800;
  letter-spacing: .02em;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.leftbar-rail-btn.active {
  border-color: rgba(96,165,250,.48);
  background: rgba(59,130,246,.16);
  color: #dbeafe;
}
.leftbar-rail-settings {
  margin-top: auto;
}
.controls {
  grid-column: 1 / 2;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  width: var(--leftbar-width);
  min-height: 0;
  overflow: hidden;
  overflow-x: hidden;
  padding: 0 4px 2px 0;
  position: relative;
  transition: width 180ms ease, opacity 180ms ease, padding 180ms ease;
}
.top {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
}
.brand {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}
.brand-copy {
  min-width: 0;
  flex: 0 1 auto;
  width: max-content;
  max-width: 100%;
  display: grid;
  gap: 4px;
}
.brand-logo {
  display: block;
  width: var(--brand-logo-size);
  height: var(--brand-logo-size);
  border-radius: 6px;
  flex: 0 0 auto;
  box-shadow: 0 3px 10px rgba(0,0,0,.22);
  object-fit: contain;
  background: rgba(255,255,255,.04);
}
.rail-brand-logo {
  display: block;
  width: var(--brand-logo-size);
  height: var(--brand-logo-size);
}
.brand-swatch-row {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: flex-end;
  width: max-content;
  max-width: 100%;
  justify-self: end;
}
.project-color-dot {
  appearance: none;
  width: 16px;
  height: 10px;
  min-width: 16px;
  min-height: 10px;
  padding: 0;
  border: 1px solid rgba(255,255,255,.18);
  border-radius: 999px;
  background: rgba(255,255,255,.2);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.2), 0 0 0 1px rgba(0,0,0,.18);
  cursor: pointer;
}
.project-color-dot.is-yellow {
  border-color: rgba(246,201,75,.55);
  background: linear-gradient(180deg, rgba(246,201,75,.95), rgba(214,166,37,.95));
}
.project-color-dot.is-green {
  border-color: rgba(141,211,95,.55);
  background: linear-gradient(180deg, rgba(141,211,95,.95), rgba(97,159,57,.95));
}
.project-color-dot.is-red {
  border-color: rgba(255,107,107,.55);
  background: linear-gradient(180deg, rgba(255,107,107,.95), rgba(208,73,73,.95));
}
.project-color-dot.is-blue {
  border-color: rgba(79,140,255,.55);
  background: linear-gradient(180deg, rgba(79,140,255,.95), rgba(50,97,195,.95));
}
.brand-title {
  margin: 0;
  width: max-content;
  max-width: 100%;
  font-size: 19px;
  line-height: 1.08;
  font-weight: 760;
  letter-spacing: .02em;
  white-space: nowrap;
  background: linear-gradient(135deg, #f5f8ff 0%, #cfd7ea 45%, #9fb4d6 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.brand-title-btn {
  appearance: none;
  padding: 0;
  margin: 0;
  border: 0;
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  width: max-content;
  max-width: 100%;
  text-align: left;
  cursor: pointer;
}
.brand-title-btn:focus-visible {
  outline: none;
  border-radius: 8px;
  box-shadow: 0 0 0 2px rgba(96,165,250,.28);
}
.brand-utility {
  display: grid;
  gap: 8px;
  width: max-content;
  max-width: 100%;
}
.brand-utility[hidden] {
  display: none !important;
}
.brand-utility-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.header-util-btn {
  appearance: none;
  min-height: 24px;
  padding: 4px 9px;
  border: 1px solid rgba(255,255,255,.16);
  border-radius: 999px;
  background: rgba(255,255,255,.04);
  color: var(--text);
  font-size: 10px;
  line-height: 1;
  font-weight: 700;
  letter-spacing: .02em;
  cursor: pointer;
}
.header-util-btn.active,
.header-util-btn[aria-expanded="true"] {
  border-color: rgba(96,165,250,.46);
  background: rgba(59,130,246,.14);
  color: #dbeafe;
  box-shadow: 0 0 0 2px rgba(59,130,246,.12);
}
.header-util-pop {
  width: min(248px, 100%);
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 10px;
  background: rgba(22,22,22,.97);
  box-shadow: 0 12px 24px rgba(0,0,0,.34);
  padding: 10px;
}
.header-util-pop[hidden] {
  display: none !important;
}
.utility-check {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
}
.utility-check input {
  margin: 0;
}
.settings-note {
  font-size: 10px;
  line-height: 1.4;
  color: var(--muted);
}
.view-toggle-btn {
  min-width: 24px;
  padding: 3px 6px;
  border-radius: 999px;
  font-size: 10px;
  line-height: 1;
  border: 1px solid rgba(255,255,255,.26);
  background: rgba(255,255,255,.04);
}
.view-toggle-btn.active {
  border-color: rgba(255,255,255,.82);
  box-shadow: 0 0 0 2px rgba(255,255,255,.18);
  background: rgba(255,255,255,.11);
}
.controls-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
}
.app.leftbar-collapsed .controls {
  width: 0;
  padding: 0;
  overflow: hidden;
}
.app.leftbar-collapsed .brand {
  display: none;
}
.app.leftbar-collapsed .controls-main {
  display: none;
}
.app.leftbar-collapsed .top {
  display: none;
}
.controls-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  flex: 0 0 auto;
}
.controls-tab {
  min-height: 30px;
  padding: 6px 8px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .01em;
  background: rgba(255,255,255,.03);
}
.controls-tab.active {
  border-color: rgba(96,165,250,.45);
  background: rgba(59,130,246,.12);
  color: #dbeafe;
}
.controls-pages {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
}
.controls-page {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  flex: 1 1 auto;
}
.controls-page[hidden] {
  display: none !important;
}
.controls-page-scroll {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 4px;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.controls-page-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.controls-tail-anchor {
  position: relative;
  display: flex;
  justify-content: flex-start;
  flex: 0 0 auto;
  width: 100%;
  margin-top: auto;
}
.controls-tail-dock {
  position: relative;
  display: grid;
  gap: 0;
  justify-items: start;
  flex: 0 0 auto;
  width: 100%;
  margin-top: auto;
}
.controls-tail-dock[hidden] {
  display: none !important;
}
.controls-tail-row {
  position: relative;
  display: flex;
  align-items: flex-end;
  justify-content: flex-start;
  width: 100%;
}
.settings-btn {
  width: 32px;
  min-width: 32px;
  height: 32px;
  min-height: 32px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-color: rgba(96,165,250,.34);
  background: rgba(59,130,246,.09);
  color: #dbeafe;
}
.settings-icon {
  display: block;
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  pointer-events: none;
}
.leftbar-rail-settings .settings-icon {
  width: 12px;
  height: 12px;
}
.settings-btn[aria-expanded="true"] {
  border-color: rgba(96,165,250,.55);
  box-shadow: 0 0 0 2px rgba(59,130,246,.16);
  background: rgba(59,130,246,.14);
}
.settings-head {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .03em;
  margin-bottom: 10px;
}
.settings-section {
  display: grid;
  gap: 8px;
}
.settings-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: var(--muted);
}
.settings-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}
.bg-mode-btn {
  min-height: 28px;
  padding: 6px 8px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .01em;
  background: rgba(255,255,255,.04);
  color: var(--text);
}
.bg-mode-btn[data-popup-bg-mode="body"] {
  background: rgba(42,42,42,.96);
}
.bg-mode-btn[data-popup-bg-mode="bar"] {
  background: rgba(33,33,33,.96);
}
.bg-mode-btn[data-popup-bg-mode="side"] {
  background: rgba(20,20,20,.96);
}
.bg-mode-btn.active {
  border-color: rgba(255,255,255,.86);
  box-shadow: 0 0 0 2px rgba(255,255,255,.14);
}
.meta {
  background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.01));
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px;
}
.meta-head {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .08em;
  color: var(--muted);
  text-transform: uppercase;
  margin-bottom: 8px;
}
#counts {
  font-size: 12px;
  line-height: 1.05;
  font-weight: 760;
  letter-spacing: -.02em;
  color: #f5f8ff;
  white-space: nowrap;
}
.mono {
  margin-top: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  color: var(--muted);
  word-break: break-all;
}
.totals {
  margin-top: 12px;
  display: grid;
  gap: 10px;
}
.total-line {
  --tone-k: #cbd5e1;
  --tone-v: #f8fafc;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 10px;
}
.total-line .k {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .01em;
  color: var(--tone-k);
  white-space: nowrap;
}
.total-line .v {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: baseline;
  color: var(--tone-v);
  font-size: 12px;
  line-height: 1.05;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
}
.total-line .v-main {
  font-weight: 500;
}
.total-line .v-sep {
  font-weight: 500;
  opacity: .7;
}
.total-line .v-em {
  font-weight: 800;
}
.total-line .v-single {
  font-weight: 700;
}
.total-line[data-tone="lines"] { --tone-k: #93c5fd; --tone-v: #dbeafe; }
.total-line[data-tone="size"] { --tone-k: #67e8f9; --tone-v: #cffafe; }
.total-line[data-tone="score"] { --tone-k: #fcd34d; --tone-v: #fef3c7; }
.total-line[data-tone="watch"] { --tone-k: #c4b5fd; --tone-v: #ede9fe; }
.total-line[data-tone="profiled"] { --tone-k: #bef264; --tone-v: #ecfccb; }
.total-line[data-tone="load"] { --tone-k: #fdba74; --tone-v: #ffedd5; }
.total-line[data-tone="heap"] { --tone-k: #f9a8d4; --tone-v: #fce7f3; }
.total-line[data-tone="failures"] { --tone-k: #fca5a5; --tone-v: #fee2e2; }
.actions-panel {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: rgba(255,255,255,.02);
  padding: 8px;
}
.actions-head {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .01em;
  margin-bottom: 6px;
}
.actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.actions button {
  min-height: 28px;
  padding: 3px 5px;
  font-size: 10px;
  line-height: 1.15;
  font-weight: 700;
  white-space: nowrap;
}
#all-on {
  border-color: rgba(141,211,95,.45);
  background: rgba(141,211,95,.12);
  color: #d9f7bd;
}
#all-off {
  border-color: rgba(255,122,122,.45);
  background: rgba(255,122,122,.12);
  color: #ffc4c4;
}
#page-off {
  border-color: rgba(245,158,11,.45);
  background: rgba(245,158,11,.12);
  color: #fbd38d;
}
#reload {
  border-color: rgba(96,165,250,.45);
  background: rgba(59,130,246,.12);
  color: #bfdbfe;
}
#reset {
  border-color: rgba(255,255,255,.18);
  background: rgba(255,255,255,.04);
  color: #eef2f7;
}
#reset-layout {
  border-color: rgba(167,139,250,.45);
  background: rgba(124,58,237,.12);
  color: #ddd6fe;
}
.info-panel {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: rgba(255,255,255,.02);
  padding: 8px;
}
.info-head {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .01em;
  margin-bottom: 6px;
}
.adv-opt {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px;
  align-items: center;
  font-size: 10px;
  color: var(--muted);
  margin-bottom: 6px;
}
.adv-opt input {
  margin: 0;
  width: 12px;
  height: 12px;
}
.info-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.info-opt {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px;
  align-items: center;
  font-size: 10px;
  color: var(--muted);
  min-height: 18px;
}
.info-opt input {
  margin: 0;
  width: 12px;
  height: 12px;
}
.sets {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: rgba(255,255,255,.02);
  padding: 8px;
}
.sets-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 4px;
}
.sets-title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .01em;
}
.sets-meta {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: .06em;
  color: var(--muted);
  text-transform: uppercase;
}
.set-slots {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  margin-bottom: 6px;
}
.set-btn {
  text-align: center;
  min-height: 36px;
  padding: 4px 5px;
  border-radius: 6px;
}
.set-btn .set-main {
  font-size: 11px;
  line-height: 1.1;
}
.set-btn .set-sub {
  font-size: 8px;
  line-height: 1.2;
  color: var(--muted);
}
.set-btn.has {
  border-color: #3f4f63;
  background: rgba(141,211,95,.08);
}
.set-btn.selected {
  border-color: rgba(141, 211, 95, .78);
  box-shadow: inset 0 0 0 1px rgba(141, 211, 95, .45);
}
.set-btn.resolved {
  border-color: rgba(96, 165, 250, .58);
  box-shadow: inset 0 0 0 1px rgba(96, 165, 250, .42);
}
.set-btn.preview-pending {
  border-color: rgba(245, 158, 11, .58);
  background: rgba(245, 158, 11, .1);
}
.set-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  align-items: stretch;
}
.sets-subtitle {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--muted);
}
.set-click-opt {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px;
  align-items: center;
  font-size: 10px;
  line-height: 1.25;
  color: var(--muted);
  margin-bottom: 12px;
}
.set-click-opt input {
  margin: 0;
  width: 12px;
  height: 12px;
}
.page-set-row {
  display: grid;
  gap: 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(255,255,255,.06);
}
.binding-opt {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px;
  align-items: center;
  font-size: 10px;
  line-height: 1.25;
  color: var(--muted);
  margin-top: 2px;
}
.binding-opt input {
  margin: 0;
  width: 12px;
  height: 12px;
  accent-color: #ef4444;
}
.binding-opt input:checked + span {
  color: #fecaca;
}
.page-set-title {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .06em;
  color: var(--muted);
  text-transform: uppercase;
  white-space: nowrap;
}
.binding-row {
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
}
.page-set-status {
  min-width: 0;
  font-size: 11px;
  line-height: 1.2;
  font-weight: 700;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 9px 10px;
  background: rgba(255,255,255,.03);
  color: var(--text);
}
.page-set-status[data-mode="preview"] {
  border-color: rgba(245, 158, 11, .48);
  background: rgba(245, 158, 11, .12);
  color: #fde68a;
}
.page-set-status[data-mode="chat"] {
  border-color: rgba(141, 211, 95, .45);
  background: rgba(141, 211, 95, .12);
  color: #d9f7bd;
}
.page-set-status[data-mode="global-set"] {
  border-color: rgba(96, 165, 250, .45);
  background: rgba(59, 130, 246, .12);
  color: #bfdbfe;
}
.page-set-status[data-mode="global-toggles"] {
  border-color: rgba(141, 211, 95, .45);
  background: rgba(141, 211, 95, .12);
  color: #d9f7bd;
}
.page-set-status[data-mode="all-off"] {
  border-color: rgba(239, 68, 68, .45);
  background: rgba(239, 68, 68, .12);
  color: #fecaca;
}
.page-set-status[data-mode="none"] {
  border-color: rgba(255,255,255,.14);
  background: rgba(255,255,255,.03);
  color: var(--muted);
}
.binding-row select {
  appearance: none;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text);
  border-radius: 6px;
  padding: 8px 10px;
  font: 12px/1.2 inherit;
  min-width: 0;
}
button {
  appearance: none;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text);
  border-radius: 6px;
  padding: 6px 8px;
  cursor: pointer;
  font: inherit;
}
button:hover { border-color: #48515e; }
button:active { transform: translateY(1px); }
.hint {
  color: var(--muted);
  font-size: 10px;
  margin: 4px 0 0;
  width: 100%;
  text-align: left;
}
.hint:empty {
  display: none;
}
.list {
  grid-column: 2 / 3;
  min-height: 0;
  height: 100%;
  width: 100%;
  position: relative;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior-x: contain;
  padding-right: 4px;
  padding-bottom: 10px;
  scrollbar-width: none;
  -ms-overflow-style: none;
  transition: margin-left 180ms ease;
}
.app.leftbar-collapsed .list {
  margin-left: calc(var(--leftbar-rail-width) + var(--leftbar-rail-collapsed-left));
}
.list::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.off-window {
  display: grid;
  flex: 1 1 auto;
  min-height: 0;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: linear-gradient(180deg, rgba(22,24,28,.98), rgba(18,20,24,.98));
  box-shadow: 0 10px 24px rgba(0,0,0,.32);
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
}
.off-window[hidden] {
  display: none !important;
}
.off-window-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(255,255,255,.08);
}
.off-window-title {
  font-size: 12px;
  font-weight: 700;
}
.off-window-count {
  font-size: 10px;
  color: var(--muted);
}
.off-window-body {
  overflow: auto;
  padding: 8px;
  scrollbar-width: thin;
}
.off-sec + .off-sec {
  margin-top: 8px;
}
.off-sec-title {
  font-size: 11px;
  color: #d9dde5;
  margin: 0 0 6px;
}
.off-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 8px;
  padding: 6px 8px;
  background: rgba(255,255,255,.02);
}
.off-row + .off-row {
  margin-top: 4px;
}
.off-row.is-off {
  background: rgba(255, 87, 87, .08);
}
.off-row.is-on {
  background: rgba(141, 211, 95, .10);
}
.off-dot-btn {
  width: 14px;
  height: 14px;
  min-width: 14px;
  min-height: 14px;
  padding: 0;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,.35);
  box-shadow: 0 0 0 1px rgba(0,0,0,.24);
  flex: 0 0 auto;
  cursor: pointer;
}
.off-dot-btn.off {
  background: #ff5757;
}
.off-dot-btn.on {
  background: #82d84f;
}
.off-dot-btn:hover {
  transform: scale(1.08);
}
.off-alias {
  font-family: inherit;
  font-size: 11px;
  line-height: 1.18;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.off-alias.off {
  color: #ff6b7f;
}
.off-alias.on {
  color: #98df6f;
}
.off-empty {
  border: 1px dashed var(--line);
  border-radius: 8px;
  padding: 8px;
  color: var(--muted);
}
button.mini {
  padding: 3px 6px;
  border-radius: 6px;
  font-size: 10px;
}
.table-shell {
  --script-col-w: 248px;
  --script-col-min-w: 248px;
  --metrics-table-min: 900px;
  --script-edge-pad: 12px;
  --group-meta-col-w: 24ch;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  position: relative;
  overflow: visible;
}
.table-head {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: linear-gradient(180deg, rgba(24,26,31,.96), rgba(21,23,27,.96));
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  min-width: 0;
  position: sticky;
  top: 0;
  z-index: 80;
  backdrop-filter: blur(2px);
  box-shadow: 0 2px 0 rgba(0,0,0,.22);
}
.grp {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: rgba(255,255,255,.02);
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  min-width: 0;
}
.grp-rowwrap {
  display: grid;
  grid-template-columns: minmax(var(--script-col-min-w), var(--script-col-w)) minmax(0, 1fr);
  align-items: stretch;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  overflow-x: hidden;
}
.groups-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  overflow-x: hidden;
}
.metrics-master-row {
  height: 1px;
  border: 0;
  border-radius: 0;
  background: transparent;
  overflow: hidden;
}
.metrics-master-spacer {
  min-width: 0;
  min-height: 1px;
}
.metrics-master-row .metrics-track {
  padding-top: 0;
  padding-bottom: 0;
}
.metrics-master-ghost {
  height: 1px;
}
.metrics-slider-row {
  position: sticky;
  top: 0;
  z-index: 6;
  margin-bottom: 2px;
  display: none;
}
.metrics-slider-spacer {
  min-width: 0;
}
.metrics-slider-wrap {
  display: flex;
  align-items: center;
  padding: 5px 8px;
  border-left: 0;
  background: linear-gradient(180deg, rgba(18,20,24,.95), rgba(16,18,22,.92));
  backdrop-filter: blur(2px);
}
.metrics-slider-wrap.disabled {
  opacity: .55;
}
.metrics-slider {
  width: 100%;
  margin: 0;
  appearance: none;
  height: 8px;
  border-radius: 999px;
  background: #1a1f28;
  border: 1px solid #2d3542;
  outline: none;
}
.metrics-slider::-webkit-slider-runnable-track {
  height: 8px;
  border-radius: 999px;
  background: #1a1f28;
}
.metrics-slider::-webkit-slider-thumb {
  appearance: none;
  margin-top: -2px;
  width: 26px;
  height: 12px;
  border-radius: 999px;
  background: #3e4a5d;
  border: 1px solid #5e6e87;
}
.metrics-slider::-moz-range-track {
  height: 8px;
  border-radius: 999px;
  background: #1a1f28;
  border: 1px solid #2d3542;
}
.metrics-slider::-moz-range-thumb {
  width: 26px;
  height: 12px;
  border-radius: 999px;
  background: #3e4a5d;
  border: 1px solid #5e6e87;
}
.grp-rowwrap + .grp-rowwrap {
  border-top: 1px solid rgba(255,255,255,.06);
}
.grp-head {
  background: rgba(18,21,27,.92);
}
.grp-totals,
.grp-totals-full {
  background: rgba(255,255,255,.01);
}
.grp-rows {
  display: flex;
  flex-direction: column;
}
.grp-row + .grp-row {
  border-top: 1px solid rgba(255,255,255,.05);
}
.grp-row {
  background: rgba(255,255,255,.028);
}
.metrics-scroll {
  min-width: 0;
  max-width: 100%;
  height: 100%;
  overflow-x: hidden;
  overflow-y: hidden;
  border-left: 0;
}
.metrics-scroll.metrics-master {
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.metrics-scroll.metrics-master::-webkit-scrollbar {
  height: 0;
}
.metrics-scroll.metrics-master::-webkit-scrollbar-track {
  background: transparent;
}
.metrics-scroll.metrics-master::-webkit-scrollbar-thumb {
  background: transparent;
}
.metrics-track {
  width: max-content;
  min-width: var(--metrics-table-min);
  padding: 4px 6px 4px 0;
}
.metrics-head .metrics-track {
  padding-top: 6px;
  padding-bottom: 6px;
}
.metrics-totals .metrics-track,
.metrics-totals-full .metrics-track {
  padding-top: 4px;
  padding-bottom: 4px;
}
.row-metrics .metrics-track {
  padding-top: 4px;
  padding-bottom: 4px;
}
.metrics-group-head .metrics-track {
  padding-top: 4px;
  padding-bottom: 4px;
}
.script-head,
.script-totals,
.row-script {
  min-width: 0;
  padding: 5px 8px;
}
.script-head,
.group-head-left {
  overflow: hidden;
  position: relative;
  isolation: isolate;
}
.row-script {
  overflow-x: hidden;
  overflow-y: hidden;
  position: relative;
  isolation: isolate;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.row-script::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}
.table-head-script { padding-top: 6px; padding-bottom: 6px; }
.script-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  min-width: 0;
  width: 100%;
  padding-right: var(--script-edge-pad);
}
.script-head-main {
  min-width: 0;
  display: grid;
  gap: 0;
}
.script-head-top {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 8px;
}
.script-head-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .01em;
}
.sf-inline-controls {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: nowrap;
  margin-left: 0;
  justify-self: start;
}
.sf-inline-select {
  appearance: none;
  border: 1px solid #39404a;
  background: rgba(255,255,255,.02);
  color: var(--muted);
  border-radius: 6px;
  padding: 1px 5px;
  font-size: 9px;
  line-height: 1.35;
  min-height: 18px;
}
.sf-inline-adv {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 1px solid #39404a;
  background: rgba(255,255,255,.02);
  color: var(--muted);
  border-radius: 6px;
  padding: 1px 5px;
  font-size: 9px;
  line-height: 1.2;
  min-height: 18px;
  white-space: nowrap;
}
.sf-inline-adv input {
  margin: 0;
  width: 10px;
  height: 10px;
}
.sf-inline-controls .view-toggle-btn {
  min-width: 24px;
  min-height: 18px;
  padding: 1px 7px;
  font-size: 9px;
  line-height: 1.2;
  border-radius: 6px;
}
.group-main {
  min-width: 0;
}
.group-title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .01em;
  white-space: nowrap;
}
.group-meta {
  font-size: 10px;
  color: var(--muted);
}
.group-head-left {
  min-width: 0;
  width: 100%;
  padding: 5px 8px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  padding-right: var(--script-edge-pad);
  position: relative;
}
.group-title-inline {
  min-width: 0;
  width: 100%;
  max-width: 100%;
  min-width: 88px;
  justify-self: stretch;
}
.group-title-input {
  appearance: none;
  border: 1px solid transparent;
  border-radius: 5px;
  padding: 0 3px;
  margin: 0;
  min-width: 0;
  width: 100%;
  background: transparent;
  color: var(--text);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .01em;
  line-height: 1.1;
  min-height: 18px;
  text-align: left;
}
.group-title-input:hover {
  border-color: rgba(255,255,255,.12);
}
.group-title-input:focus {
  outline: none;
  border-color: #4b5668;
  background: rgba(255,255,255,.06);
}
.group-meta-inline {
  width: var(--group-meta-col-w);
  min-width: var(--group-meta-col-w);
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: clip;
  margin-left: 0;
  text-align: right;
  justify-self: start;
  position: absolute;
  top: 50%;
  left: 0;
  transform: translateY(-50%);
  right: auto;
  z-index: auto;
  background: transparent;
  padding-left: 0;
  pointer-events: none;
}
.group-toggle-dot {
  width: 12px;
  height: 12px;
  min-width: 12px;
  border-radius: 3px;
  border: 1px solid #687182;
  background: #5a606c;
  padding: 0;
  margin: 0;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.18);
}
.group-toggle-dot.on {
  background: #8dd35f;
  border-color: #9ade76;
  box-shadow: 0 0 0 2px rgba(141,211,95,.14);
}
.script-totals {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.group-total-line {
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-script {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  min-width: 0;
  width: 100%;
  max-width: 100%;
  gap: 8px;
  align-items: center;
  padding-right: 12px;
}
.row-hide-dot {
  width: 9px;
  height: 9px;
  min-width: 9px;
  min-height: 9px;
  padding: 0;
  border-radius: 999px;
  border: 1px solid rgba(255, 132, 132, .9);
  background: #ff4f5e;
  box-shadow: 0 0 0 1px rgba(0,0,0,.28);
  cursor: pointer;
}
.row-hide-dot:hover {
  transform: scale(1.1);
}
.row-main {
  min-width: 0;
}
.row-script .name {
  font-size: 11px;
  line-height: 1.18;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.metrics-scroll.metrics-follower {
  position: relative;
  z-index: 4;
  background: inherit;
}
.row-script .alias {
  display: none;
}
.row-script.off,
.row-metrics.off {
  opacity: .68;
}
.metrics-row {
  display: grid;
  gap: 2px;
  align-items: center;
  min-height: 22px;
}
.metric-cell {
  min-width: 0;
  display: flex;
  justify-content: flex-start;
  align-items: center;
  overflow: hidden;
}
.stat-chip {
  border: 1px solid #39404a;
  border-radius: 6px;
  padding: 1px 4px;
  font-size: 9px;
  line-height: 1.2;
  color: #d4dae3;
  background: rgba(255,255,255,.03);
  white-space: nowrap;
}
.stat-chip.warn {
  border-color: rgba(255,196,94,.45);
  color: #ffd88f;
}
.stat-chip.bad {
  border-color: rgba(255,122,122,.45);
  color: #ffb3b3;
}
.stat-chip.good {
  border-color: rgba(141,211,95,.45);
  color: #c9efac;
}
.head-chip {
  border: 0;
  border-radius: 0;
  padding: 0;
  font-size: 11px;
  line-height: 1.2;
  font-weight: 700;
  letter-spacing: .01em;
  color: var(--text);
  background: transparent;
  white-space: nowrap;
}
.metric-head-cell {
  position: relative;
  padding-left: 8px;
}
.script-col-resizer {
  position: absolute;
  top: 0;
  right: -5px;
  bottom: 0;
  width: 10px;
  cursor: col-resize;
  z-index: 5;
  touch-action: none;
}
.script-col-resizer::before {
  content: "";
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 4px;
  width: 1px;
  background: rgba(255,255,255,.28);
}
.script-col-resizer:hover::before,
.script-col-resizer:active::before {
  background: rgba(255,255,255,.55);
}
.metrics-col-resizer {
  position: absolute;
  top: -3px;
  right: -5px;
  bottom: -3px;
  width: 10px;
  cursor: col-resize;
  z-index: 3;
  touch-action: none;
}
.metrics-col-resizer::before {
  content: "";
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 4px;
  width: 1px;
  background: rgba(255,255,255,.18);
}
.metrics-col-resizer:hover::before,
.metrics-col-resizer:active::before {
  background: rgba(255,255,255,.48);
}

/* Full-popup diagnostics workspace. The existing header remains the sole
   workspace chrome; this shell only replaces the content beneath it. */
.diagnostics-workspace[hidden] { display: none !important; }
.app.diagnostics-workspace-active {
  --app-gap: 10px;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  gap: 10px;
}
.app.diagnostics-workspace-active .leftbar-rail,
.app.diagnostics-workspace-active .controls-main,
.app.diagnostics-workspace-active .list {
  display: none !important;
}
.app.diagnostics-workspace-active .controls,
.app.diagnostics-workspace-active.leftbar-collapsed .controls {
  grid-column: 1;
  grid-row: 1;
  width: 100%;
  min-height: auto;
  padding: 0 2px 8px;
  overflow: visible;
  border-bottom: 1px solid rgba(255,255,255,.09);
  opacity: 1;
}
.app.diagnostics-workspace-active.leftbar-collapsed .brand,
.app.diagnostics-workspace-active.leftbar-collapsed .top {
  display: flex;
}
.app.diagnostics-workspace-active .brand {
  align-items: center;
}
.app.diagnostics-workspace-active .brand-copy {
  width: 100%;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
}
.app.diagnostics-workspace-active .brand-title-btn,
.app.diagnostics-workspace-active .brand-utility {
  grid-column: 1;
}
.app.diagnostics-workspace-active .brand-swatch-row {
  grid-column: 2;
  grid-row: 1;
  justify-self: end;
}
.diagnostics-workspace {
  grid-column: 1;
  grid-row: 2;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(250px, 28%) minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 14px;
  background:
    radial-gradient(circle at 18% 0%, rgba(96,165,250,.09), transparent 34%),
    linear-gradient(145deg, rgba(25,28,34,.99), rgba(16,18,22,.99));
  box-shadow: 0 18px 42px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.035);
}
.diagnostics-workspace.is-sidebar-collapsed {
  grid-template-columns: 0 minmax(0, 1fr);
}
.diagnostics-sidebar {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 18px 14px;
  border-right: 1px solid rgba(255,255,255,.09);
  background: linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.012));
  scrollbar-width: thin;
}
.diagnostics-workspace.is-sidebar-collapsed .diagnostics-sidebar {
  visibility: hidden;
  padding-inline: 0;
  border-right: 0;
}
.diagnostics-sidebar-head h1,
.diagnostics-detail-head h2,
.diagnostics-empty h3,
.diagnostics-panel h3,
.diagnostics-selected-controls h2 {
  margin: 0;
  color: var(--text);
}
.diagnostics-sidebar-head h1 {
  margin-top: 2px;
  font-size: 20px;
  letter-spacing: -.02em;
}
.diagnostics-sidebar-head p,
.diagnostics-detail-head p,
.diagnostics-empty p {
  margin: 6px 0 0;
  color: var(--muted);
  line-height: 1.5;
}
.diagnostics-eyebrow {
  color: #9ec8ff;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.diagnostics-module-nav {
  display: grid;
  gap: 8px;
  margin-top: 18px;
}
.diagnostics-module-button {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 9px;
  width: 100%;
  padding: 10px;
  text-align: left;
  border-radius: 10px;
  background: rgba(255,255,255,.025);
}
.diagnostics-module-button[aria-current="page"] {
  border-color: rgba(96,165,250,.5);
  background: linear-gradient(135deg, rgba(59,130,246,.18), rgba(96,165,250,.08));
  box-shadow: inset 3px 0 0 #60a5fa, 0 8px 18px rgba(0,0,0,.15);
}
.diagnostics-module-icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: rgba(96,165,250,.13);
  color: #b9d8ff;
  font-size: 15px;
}
.diagnostics-module-copy { min-width: 0; }
.diagnostics-module-copy strong,
.diagnostics-module-copy span { display: block; }
.diagnostics-module-copy strong { font-size: 11px; }
.diagnostics-module-copy span {
  margin-top: 3px;
  color: var(--muted);
  font-size: 9px;
  line-height: 1.35;
}
.diagnostics-selected-controls {
  display: grid;
  gap: 10px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid rgba(255,255,255,.08);
}
.diagnostics-controls-head,
.diagnostics-panel-head,
.diagnostics-detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.diagnostics-selected-controls h2,
.diagnostics-panel h3 { font-size: 11px; }
.diagnostics-action-grid { display: grid; gap: 7px; }
.diagnostics-action-grid button {
  min-height: 31px;
  text-align: left;
  border-radius: 8px;
  background: rgba(255,255,255,.035);
}
.diagnostics-action-grid button.is-primary {
  border-color: rgba(96,165,250,.48);
  background: linear-gradient(135deg, rgba(59,130,246,.24), rgba(59,130,246,.11));
  color: #e1efff;
}
.diagnostics-action-grid button.is-danger { color: #ffc4c4; }
.diagnostics-action-grid button:disabled,
.diagnostics-raw-actions button:disabled {
  cursor: wait;
  opacity: .52;
  transform: none;
}
.diagnostics-command-status {
  min-height: 14px;
  color: var(--muted);
  font-size: 9px;
}
.diagnostics-command-error {
  padding: 8px;
  border: 1px solid rgba(255,122,122,.3);
  border-radius: 8px;
  background: rgba(255,122,122,.08);
  color: #ffd0d0;
  font-size: 9px;
  line-height: 1.4;
}
.diagnostics-detail {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 18px;
  scrollbar-width: thin;
}
.diagnostics-detail:focus { outline: none; }
.diagnostics-detail:focus-visible {
  box-shadow: inset 0 0 0 2px rgba(96,165,250,.36);
}
.diagnostics-detail-head {
  padding-bottom: 14px;
  border-bottom: 1px solid rgba(255,255,255,.08);
}
.diagnostics-detail-head h2 {
  margin-top: 3px;
  font-size: 18px;
  letter-spacing: -.015em;
}
.diagnostics-detail-state {
  display: grid;
  justify-items: end;
  gap: 4px;
  min-width: 118px;
  color: var(--muted);
  font-size: 9px;
  text-align: right;
}
.diagnostics-state-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  width: max-content;
  max-width: 100%;
  padding: 3px 7px;
  border: 1px solid rgba(166,173,184,.3);
  border-radius: 999px;
  background: rgba(166,173,184,.08);
  color: #d9dee7;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: .03em;
}
.diagnostics-state-badge::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #a6adb8;
}
.diagnostics-state-badge.is-large { padding: 5px 9px; font-size: 10px; }
.diagnostics-state-badge[data-run-state="armed"]::before,
.diagnostics-state-badge[data-run-state="navigating"]::before,
.diagnostics-state-badge[data-run-state="settling"]::before {
  background: #f6c94b;
  box-shadow: 0 0 0 4px rgba(246,201,75,.1);
}
.diagnostics-state-badge[data-run-state="complete"]::before { background: var(--accent); }
.diagnostics-state-badge[data-run-state="error"]::before { background: var(--danger); }
.diagnostics-empty {
  min-height: 280px;
  display: grid;
  place-content: center;
  justify-items: center;
  padding: 34px;
  text-align: center;
}
.diagnostics-empty-mark {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  margin-bottom: 12px;
  border: 1px solid rgba(96,165,250,.28);
  border-radius: 14px;
  background: radial-gradient(circle, rgba(96,165,250,.17), rgba(96,165,250,.035));
  color: #a9d0ff;
  font-size: 26px;
}
.diagnostics-empty p { max-width: 390px; }
.diagnostics-report { display: grid; gap: 12px; margin-top: 14px; }
.diagnostics-report[hidden] { display: none !important; }
.diagnostics-summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.diagnostics-summary-card {
  min-width: 0;
  padding: 10px;
  border: 1px solid rgba(255,255,255,.085);
  border-radius: 10px;
  background: linear-gradient(150deg, rgba(255,255,255,.05), rgba(255,255,255,.018));
  box-shadow: inset 0 1px 0 rgba(255,255,255,.025);
}
.diagnostics-summary-card span,
.diagnostics-summary-card strong { display: block; }
.diagnostics-summary-card span { color: var(--muted); font-size: 9px; }
.diagnostics-summary-card strong {
  margin-top: 5px;
  overflow-wrap: anywhere;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}
.diagnostics-info-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.diagnostics-panel,
.diagnostics-raw {
  min-width: 0;
  padding: 12px;
  border: 1px solid rgba(255,255,255,.085);
  border-radius: 11px;
  background: rgba(7,9,12,.28);
}
.diagnostics-panel-head { align-items: center; margin-bottom: 10px; }
.diagnostics-panel-head > span { color: var(--muted); font-size: 9px; }
.diagnostics-panel-head-wrap { flex-wrap: wrap; }
.diagnostics-kv {
  display: grid;
  grid-template-columns: minmax(94px, .65fr) minmax(0, 1fr);
  gap: 7px 10px;
  margin: 0;
}
.diagnostics-kv dt { color: var(--muted); }
.diagnostics-kv dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.diagnostics-table-wrap { min-width: 0; overflow-x: auto; }
.diagnostics-table {
  width: 100%;
  min-width: 690px;
  border-collapse: collapse;
  table-layout: fixed;
}
.diagnostics-table th,
.diagnostics-table td {
  padding: 7px 6px;
  border-bottom: 1px solid rgba(255,255,255,.065);
  vertical-align: top;
  text-align: left;
  overflow-wrap: anywhere;
}
.diagnostics-table th {
  color: var(--muted);
  font-size: 8px;
  letter-spacing: .045em;
  text-transform: uppercase;
}
.diagnostics-table td { font-size: 9px; }
.diagnostics-filter-row { display: flex; flex-wrap: wrap; gap: 5px; }
.diagnostics-filter-button {
  min-height: 24px;
  padding: 4px 7px;
  border-radius: 999px;
  color: var(--muted);
  font-size: 9px;
}
.diagnostics-filter-button[aria-pressed="true"] {
  border-color: rgba(96,165,250,.44);
  background: rgba(59,130,246,.14);
  color: #dbeafe;
}
.diagnostics-timeline { display: grid; gap: 6px; }
.diagnostics-timeline-empty { padding: 12px 0; color: var(--muted); }
.diagnostics-event {
  display: grid;
  grid-template-columns: 58px 88px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  min-width: 0;
  padding: 7px 8px;
  border-left: 2px solid rgba(166,173,184,.3);
  border-radius: 0 7px 7px 0;
  background: rgba(255,255,255,.025);
}
.diagnostics-event[data-category="navigation"] { border-left-color: #60a5fa; }
.diagnostics-event[data-category="title"] { border-left-color: #c084fc; }
.diagnostics-event[data-category="performance"] { border-left-color: #f6c94b; }
.diagnostics-event[data-category="error"] { border-left-color: var(--danger); }
.diagnostics-event-time,
.diagnostics-event-source { color: var(--muted); font-size: 8px; font-variant-numeric: tabular-nums; }
.diagnostics-event-copy { min-width: 0; }
.diagnostics-event-copy strong { display: block; overflow-wrap: anywhere; font-size: 9px; }
.diagnostics-event-copy span { display: block; margin-top: 2px; color: var(--muted); overflow-wrap: anywhere; font-size: 8px; }
.diagnostics-warnings {
  border-color: rgba(246,201,75,.24);
  background: rgba(246,201,75,.045);
}
.diagnostics-warnings ul { margin: 0; padding-left: 17px; }
.diagnostics-warnings li { margin: 5px 0; color: #ffe9a6; line-height: 1.4; }
.diagnostics-raw { padding: 0; overflow: hidden; }
.diagnostics-raw summary {
  padding: 11px 12px;
  cursor: pointer;
  color: var(--muted);
  font-weight: 700;
}
.diagnostics-raw[open] summary { border-bottom: 1px solid rgba(255,255,255,.08); }
.diagnostics-raw-actions { display: flex; justify-content: flex-end; padding: 8px 10px 0; }
.diagnostics-raw-actions button { padding: 4px 8px; font-size: 9px; }
.diagnostics-raw pre {
  max-height: 230px;
  margin: 0;
  padding: 10px 12px 14px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: #cbd5e1;
  font: 9px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.diagnostics-workspace button:focus-visible,
.project-color-dot[data-popup-action="open-diagnostics"]:focus-visible {
  outline: 2px solid rgba(147,197,253,.92);
  outline-offset: 2px;
}
@media (max-width: 720px) {
  .diagnostics-workspace { grid-template-columns: minmax(220px, 34%) minmax(0, 1fr); }
  .diagnostics-summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .diagnostics-info-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  .diagnostics-workspace *,
  .diagnostics-workspace *::before,
  .diagnostics-workspace *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; }
}
.switch { position: relative; width: 30px; height: 17px; display: inline-block; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider {
  position: absolute; inset: 0;
  background: #3b4048; border-radius: 999px; transition: .15s ease;
  border: 1px solid rgba(255,255,255,.12);
}
.slider::before {
  content: "";
  position: absolute; width: 11px; height: 11px; left: 2px; top: 2px;
  border-radius: 50%; background: #d8dee8; transition: .15s ease;
}
.switch input:checked + .slider { background: rgba(141,211,95,.35); }
.switch input:checked + .slider::before { transform: translateX(12px); background: #b7f089; }
.empty, .error {
  border: 1px dashed var(--line);
  border-radius: 8px;
  padding: 8px;
  color: var(--muted);
}
.error { color: #ffd4d4; border-color: rgba(255,122,122,.35); }
` + (buildVisibility.enabled ? LOADED_BUILD_IDENTITY_CSS : "");
}

const LOADED_BUILD_IDENTITY_CSS = `.h2o-env-badge {
  margin-top: 4px;
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 2px 6px;
}
.h2o-env-identity-list {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 10px;
  margin: 6px 0 0;
  font-size: 11px;
}
.h2o-env-identity-list dt { color: var(--muted); }
.h2o-env-identity-list dd {
  margin: 0;
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
`;
