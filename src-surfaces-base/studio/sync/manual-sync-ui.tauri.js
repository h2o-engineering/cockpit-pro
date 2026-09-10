/* H2O Desktop Sync - F10.8.5 manual sync UI
 *
 * Desktop/Tauri-only operator surface over the existing relay outbox, inbox,
 * relay index, proposal-preview, conflict-report, and apply receipt APIs.
 *
 * Safety invariants:
 *   - UI layer only. No apply, convergence, automatic review, automatic merge,
 *     automatic refresh, timers, or background transport.
 *   - Publish and pull are explicit operator button actions that call the
 *     already-existing WebDAV relay adapter. This module does not alter
 *     transport, inbox, outbox, index, proposal, conflict, or apply logic.
 *   - Lists are counts-first and redacted: no serialized envelopes, raw remote
 *     names, folder names, chat ids, or content are rendered.
 */
(function (global) {
  'use strict';

  function detectTauri() {
    try {
      if (typeof global.__TAURI_INTERNALS__ !== 'undefined') return true;
      if (typeof global.__TAURI__ !== 'undefined') return true;
      if (global.H2O && global.H2O.Studio && global.H2O.Studio.platform &&
          global.H2O.Studio.platform.env && global.H2O.Studio.platform.env.isTauri === true) return true;
    } catch (_) { /* ignore */ }
    return false;
  }
  if (!detectTauri()) return;

  var H2O = global.H2O = global.H2O || {};
  H2O.Desktop = H2O.Desktop || {};
  H2O.Desktop.Sync = H2O.Desktop.Sync || {};
  if (H2O.Desktop.Sync.__manualSyncUiInstalled) return;

  var VERSION = '0.1.0-f10.8.5';
  var PANEL_ID = 'h2o-manual-sync-panel';
  var LAUNCHER_ID = 'h2o-manual-sync-launcher';
  var STYLE_ID = 'h2o-manual-sync-style';

  var state = {
    open: false,
    snapshot: null,
    message: '',
    busy: false
  };

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function safeObject(value) {
    return isObject(value) ? value : {};
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function cleanString(value) {
    return String(value == null ? '' : value).trim();
  }

  function escapeHtml(value) {
    return cleanString(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function shortHash(value) {
    var text = cleanString(value);
    if (!text) return 'missing';
    return text.length > 14 ? text.slice(0, 12) + '…' : text;
  }

  function codeList(value) {
    return asArray(value).map(function (item) {
      return isObject(item) ? cleanString(item.code) : cleanString(item);
    }).filter(Boolean);
  }

  function countWhere(rows, predicate) {
    var count = 0;
    for (var i = 0; i < rows.length; i += 1) {
      if (predicate(rows[i])) count += 1;
    }
    return count;
  }

  function maxIso(rows, field) {
    var max = '';
    for (var i = 0; i < rows.length; i += 1) {
      var value = cleanString(rows[i] && rows[i][field]);
      if (!value) continue;
      if (!max || Date.parse(value) > Date.parse(max)) max = value;
    }
    return max || 'never';
  }

  async function safeCall(fn, fallback) {
    if (typeof fn !== 'function') return fallback;
    try {
      var result = await fn();
      return result || fallback;
    } catch (e) {
      var next = Object.assign({}, fallback);
      next.ok = false;
      next.blockers = ['sync-ui-call-failed'];
      next.warnings = [cleanString((e && e.message) || e)];
      return next;
    }
  }

  async function identitySummary() {
    var api = H2O.Studio && H2O.Studio.identity;
    if (!api) return { status: 'unavailable' };
    try {
      if (typeof api.whenReady === 'function') await api.whenReady();
      if (typeof api.diagnose === 'function') return safeObject(api.diagnose());
    } catch (_) { /* fall through */ }
    return { status: 'unavailable' };
  }

  function summarizeOutbox(outbox) {
    var rows = asArray(outbox.rows);
    return {
      ok: outbox.ok === true,
      rows: rows,
      counts: {
        rows: Number(safeObject(outbox.counts).rows) || rows.length,
        pendingUpload: Number(safeObject(outbox.counts).pendingUpload) || countWhere(rows, function (row) {
          return cleanString(row.relayStatus) === 'pending-upload';
        }),
        uploaded: Number(safeObject(outbox.counts).uploaded) || countWhere(rows, function (row) {
          return cleanString(row.relayStatus) === 'uploaded';
        })
      },
      lastPublish: maxIso(rows, 'uploadedAtIso'),
      blockers: codeList(outbox.blockers),
      warnings: codeList(outbox.warnings)
    };
  }

  function summarizeInbox(inbox) {
    var rows = asArray(inbox.rows);
    return {
      ok: inbox.ok === true,
      rows: rows,
      counts: {
        rows: Number(safeObject(inbox.counts).rows) || rows.length,
        pendingReview: Number(safeObject(inbox.counts).pendingReview) || countWhere(rows, function (row) {
          return cleanString(row.relayStatus) === 'pending-review';
        }),
        expired: Number(safeObject(inbox.counts).expired) || countWhere(rows, function (row) {
          return cleanString(row.relayStatus) === 'expired';
        }),
        blocked: Number(safeObject(inbox.counts).blocked) || countWhere(rows, function (row) {
          return cleanString(row.relayStatus) === 'blocked';
        })
      },
      lastPull: maxIso(rows, 'receivedAtIso'),
      blockers: codeList(inbox.blockers),
      warnings: codeList(inbox.warnings)
    };
  }

  function summarizeIndex(index) {
    var entries = asArray(index.entries);
    return {
      ok: index.ok === true,
      entries: entries,
      counts: Object.assign({
        total: entries.length,
        duplicates: countWhere(entries, function (entry) { return entry.duplicate === true; }),
        replayAttempts: countWhere(entries, function (entry) { return entry.replayAttempt === true; }),
        stale: countWhere(entries, function (entry) { return entry.stale === true; }),
        expired: countWhere(entries, function (entry) { return entry.expired === true; })
      }, safeObject(index.counts)),
      duplicates: asArray(index.duplicates),
      replays: asArray(index.replays),
      blockers: codeList(index.blockers),
      warnings: codeList(index.warnings)
    };
  }

  async function collectSnapshot() {
    var sync = H2O.Desktop.Sync;
    var identity = await identitySummary();
    var outbox = summarizeOutbox(await safeCall(sync.listRelayOutbox, {
      ok: false,
      rows: [],
      counts: { rows: 0, pendingUpload: 0, uploaded: 0 },
      blockers: ['relay-outbox-unavailable'],
      warnings: []
    }));
    var inbox = summarizeInbox(await safeCall(sync.listRelayInbox, {
      ok: false,
      rows: [],
      counts: { rows: 0, pendingReview: 0, expired: 0, blocked: 0 },
      blockers: ['relay-inbox-unavailable'],
      warnings: []
    }));
    var index = summarizeIndex(await safeCall(sync.listRelayIndex, {
      ok: false,
      entries: [],
      counts: {},
      duplicates: [],
      replays: [],
      blockers: ['relay-index-unavailable'],
      warnings: []
    }));
    var previewEntries = index.entries.filter(function (entry) {
      return cleanString(entry.kind) === 'preview' || cleanString(entry.kind) === 'proposal';
    });
    var conflictEntries = index.entries.filter(function (entry) {
      return cleanString(entry.kind) === 'conflictCandidate' ||
        cleanString(entry.relayStatus) === 'blocked' ||
        codeList(safeObject(entry.validation).blockers).length > 0;
    });
    var applyEntries = index.entries.filter(function (entry) {
      return cleanString(entry.kind) === 'applyEvent';
    });
    return {
      generatedAtIso: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      identity: identity,
      outbox: outbox,
      inbox: inbox,
      index: index,
      sections: {
        previewEntries: previewEntries,
        conflictEntries: conflictEntries,
        applyEntries: applyEntries,
        proposalPreviewAvailable: !!(H2O.Studio && H2O.Studio.diagnostics &&
          typeof H2O.Studio.diagnostics.previewFolderSyncProposal === 'function'),
        conflictReportAvailable: !!(H2O.Studio && H2O.Studio.diagnostics &&
          typeof H2O.Studio.diagnostics.buildFolderConflictReport === 'function'),
        applyEventBuilderAvailable: typeof sync.buildFolderApplyEvent === 'function'
      }
    };
  }

  function injectStyle() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#h2o-manual-sync-launcher{position:fixed;right:18px;bottom:18px;z-index:2147482600;border:1px solid rgba(148,163,184,.45);border-radius:999px;padding:10px 14px;background:var(--wb-panel,#151923);color:var(--wb-text,#f8fafc);font:600 13px/1.2 system-ui,sans-serif;box-shadow:0 12px 34px rgba(0,0,0,.24);cursor:pointer}',
      '#h2o-manual-sync-panel{position:fixed;right:18px;top:64px;width:min(980px,calc(100vw - 36px));max-height:calc(100vh - 84px);z-index:2147482601;overflow:auto;border:1px solid rgba(148,163,184,.35);border-radius:20px;background:var(--wb-surface,#10141d);color:var(--wb-text,#f8fafc);box-shadow:0 24px 90px rgba(0,0,0,.38);font:13px/1.45 system-ui,sans-serif}',
      '#h2o-manual-sync-panel *{box-sizing:border-box}',
      '.h2oSyncHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:18px 20px;border-bottom:1px solid rgba(148,163,184,.22)}',
      '.h2oSyncBody{padding:18px 20px 22px}',
      '.h2oSyncKicker{margin:0 0 4px;color:var(--wb-muted,#94a3b8);font-size:12px;text-transform:uppercase;letter-spacing:.08em}',
      '.h2oSyncTitle{margin:0;font-size:20px;line-height:1.15}',
      '.h2oSyncNote{margin:8px 0 0;color:var(--wb-muted,#94a3b8)}',
      '.h2oSyncBtn{border:1px solid rgba(148,163,184,.34);border-radius:12px;background:rgba(148,163,184,.12);color:inherit;padding:9px 12px;font-weight:650;cursor:pointer}',
      '.h2oSyncClose{min-width:38px;height:38px;padding:0;border-radius:999px;font-size:20px;line-height:1}',
      '#h2o-manual-sync-panel[data-settings-hosted="true"] .h2oSyncClose{display:none}',
      '.h2oSyncBtn[disabled]{opacity:.55;cursor:not-allowed}',
      '.h2oSyncPrimary{background:rgba(59,130,246,.24);border-color:rgba(96,165,250,.5)}',
      '.h2oSyncDanger{background:rgba(239,68,68,.16);border-color:rgba(248,113,113,.38)}',
      '.h2oSyncGrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:14px 0}',
      '.h2oSyncCard{border:1px solid rgba(148,163,184,.22);border-radius:16px;padding:12px;background:rgba(148,163,184,.08)}',
      '.h2oSyncMetric{display:block;font-size:24px;font-weight:800;line-height:1.05}',
      '.h2oSyncLabel{display:block;color:var(--wb-muted,#94a3b8);font-size:12px;margin-top:4px}',
      '.h2oSyncSection{border:1px solid rgba(148,163,184,.2);border-radius:16px;margin:12px 0;background:rgba(2,6,23,.12);overflow:hidden}',
      '.h2oSyncSection>summary{cursor:pointer;padding:13px 14px;font-weight:750}',
      '.h2oSyncSectionBody{padding:0 14px 14px}',
      '.h2oSyncRows{display:grid;gap:8px;margin:10px 0 0}',
      '.h2oSyncRow{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;border:1px solid rgba(148,163,184,.16);border-radius:12px;padding:9px;background:rgba(148,163,184,.06)}',
      '.h2oSyncMono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
      '.h2oSyncPill{display:inline-flex;align-items:center;border:1px solid rgba(148,163,184,.26);border-radius:999px;padding:3px 8px;color:var(--wb-muted,#94a3b8);font-size:12px}',
      '.h2oSyncForm{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px;margin:12px 0}',
      '.h2oSyncInput{width:100%;border:1px solid rgba(148,163,184,.28);border-radius:10px;background:rgba(15,23,42,.48);color:inherit;padding:9px 10px}',
      '.h2oSyncCodes{color:var(--wb-muted,#94a3b8);font-size:12px;margin-top:8px}',
      '@media(max-width:760px){.h2oSyncGrid{grid-template-columns:repeat(2,minmax(0,1fr))}.h2oSyncForm{grid-template-columns:1fr}.h2oSyncRow{grid-template-columns:1fr}}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function metric(label, value) {
    return '<div class="h2oSyncCard"><span class="h2oSyncMetric">' + escapeHtml(value) +
      '</span><span class="h2oSyncLabel">' + escapeHtml(label) + '</span></div>';
  }

  function codes(label, list) {
    var values = codeList(list);
    if (!values.length) return '';
    return '<div class="h2oSyncCodes">' + escapeHtml(label) + ': ' +
      values.map(escapeHtml).join(', ') + '</div>';
  }

  function entryRow(entry) {
    var validation = safeObject(entry.validation);
    var blockers = codeList(validation.blockers);
    var warnings = codeList(validation.warnings);
    var detail = [
      'event ' + shortHash(entry.eventDigest),
      'dedupe ' + shortHash(entry.dedupeKey)
    ].join(' · ');
    var flags = [];
    if (entry.duplicate) flags.push('duplicate');
    if (entry.replayAttempt) flags.push('replay');
    if (entry.stale) flags.push('stale');
    if (entry.expired) flags.push('expired');
    if (blockers.length) flags.push('blocked');
    if (warnings.length) flags.push('warning');
    return '<div class="h2oSyncRow">' +
      '<div><strong>' + escapeHtml(cleanString(entry.kind) || 'unknown') + '</strong>' +
      '<div class="h2oSyncMono">' + escapeHtml(detail) + '</div></div>' +
      '<span class="h2oSyncPill">' + escapeHtml(cleanString(entry.relayStatus) || 'unknown') + '</span>' +
      '<span class="h2oSyncPill">' + escapeHtml(flags.join(', ') || cleanString(entry.direction) || 'local') + '</span>' +
      '</div>';
  }

  function rowList(entries, emptyText) {
    var rows = asArray(entries);
    if (!rows.length) return '<p class="h2oSyncNote">' + escapeHtml(emptyText) + '</p>';
    return '<div class="h2oSyncRows">' + rows.slice(0, 20).map(entryRow).join('') + '</div>' +
      (rows.length > 20 ? '<p class="h2oSyncNote">Showing first 20 redacted entries.</p>' : '');
  }

  function configForm() {
    return '<div class="h2oSyncForm">' +
      '<input class="h2oSyncInput" id="h2o-sync-url" autocomplete="off" placeholder="WebDAV URL">' +
      '<input class="h2oSyncInput" id="h2o-sync-user" autocomplete="off" placeholder="Username">' +
      '<input class="h2oSyncInput" id="h2o-sync-secret" type="password" autocomplete="off" placeholder="Password">' +
      '<input class="h2oSyncInput" id="h2o-sync-peer" autocomplete="off" placeholder="Relay peer id">' +
      '</div>';
  }

  function readConfig() {
    function value(id) {
      var node = document.getElementById(id);
      return node ? node.value : '';
    }
    return {
      serverUrl: value('h2o-sync-url'),
      username: value('h2o-sync-user'),
      password: value('h2o-sync-secret'),
      peerId: value('h2o-sync-peer')
    };
  }

  function renderSnapshot(snapshot) {
    var outbox = snapshot.outbox;
    var inbox = snapshot.inbox;
    var index = snapshot.index;
    var sections = snapshot.sections;
    var totalConflicts = sections.conflictEntries.length + Number(index.counts.replayAttempts || 0);
    var accepted = Number(inbox.counts.pendingReview || 0);
    var deduped = Number(index.counts.duplicates || 0);
    var expired = Number(inbox.counts.expired || index.counts.expired || 0);
    var blocked = Number(inbox.counts.blocked || index.counts.blocked || 0);
    return '<div class="h2oSyncHeader">' +
      '<div><p class="h2oSyncKicker">Desktop manual sync</p>' +
      '<h2 class="h2oSyncTitle">Relay control surface</h2>' +
      '<p class="h2oSyncNote">Manual only. No apply, convergence, automatic refresh, automatic merge, or raw remote names.</p></div>' +
      '<div><button class="h2oSyncBtn" id="h2o-sync-refresh">Refresh counts</button> ' +
      '<a class="h2oSyncBtn" href="#/settings/sync/status">Open in Settings</a> ' +
      '<button class="h2oSyncBtn h2oSyncDanger h2oSyncClose" id="h2o-sync-close" type="button" aria-label="Close Manual Sync panel" title="Close">×</button></div>' +
      '</div><div class="h2oSyncBody">' +
      (state.message ? '<div class="h2oSyncCard">' + escapeHtml(state.message) + '</div>' : '') +
      '<section class="h2oSyncSection" id="h2o-sync-section-status" open><summary>1. Sync Status</summary><div class="h2oSyncSectionBody">' +
      '<div class="h2oSyncGrid">' +
      metric('outbox pending-upload', outbox.counts.pendingUpload) +
      metric('outbox uploaded', outbox.counts.uploaded) +
      metric('inbox pending review', inbox.counts.pendingReview) +
      metric('conflict signals', totalConflicts) +
      metric('inbox accepted', accepted) +
      metric('inbox deduped', deduped) +
      metric('inbox expired', expired) +
      metric('inbox blocked', blocked) +
      '</div>' +
      '<p class="h2oSyncNote">Peer identity: ' + escapeHtml(snapshot.identity.status || 'unknown') +
      ' · surface ' + escapeHtml(snapshot.identity.surfaceKind || 'unknown') +
      ' · display ' + escapeHtml(snapshot.identity.displayName || 'unset') + '</p>' +
      '<p class="h2oSyncNote">Last publish: ' + escapeHtml(outbox.lastPublish) +
      ' · Last pull: ' + escapeHtml(inbox.lastPull) +
      ' · Snapshot: ' + escapeHtml(snapshot.generatedAtIso) + '</p>' +
      codes('outbox blockers', outbox.blockers) + codes('inbox blockers', inbox.blockers) +
      codes('index warnings', index.warnings) +
      '</div></section>' +
      '<section class="h2oSyncSection" id="h2o-sync-section-outbox" open><summary>2. Outbox</summary><div class="h2oSyncSectionBody">' +
      '<p class="h2oSyncNote">Pending envelopes can be published manually. Upload marks relay rows as uploaded only through the existing relay adapter.</p>' +
      configForm() +
      '<button class="h2oSyncBtn h2oSyncPrimary" id="h2o-sync-publish">Publish pending outbox</button>' +
      rowList(index.entries.filter(function (entry) { return entry.direction === 'outbox' && entry.relayStatus === 'pending-upload'; }), 'No pending-upload envelopes.') +
      '</div></section>' +
      '<section class="h2oSyncSection" id="h2o-sync-section-relay"><summary>3. Pull</summary><div class="h2oSyncSectionBody">' +
      '<p class="h2oSyncNote">Pull is manual only. Downloaded envelopes go to local inbox validation and pending review/quarantine; they do not mutate state.</p>' +
      '<button class="h2oSyncBtn h2oSyncPrimary" id="h2o-sync-pull">Pull relay inbox</button>' +
      '</div></section>' +
      '<section class="h2oSyncSection" id="h2o-sync-section-inbox"><summary>4. Inbox</summary><div class="h2oSyncSectionBody">' +
      '<div class="h2oSyncGrid">' + metric('accepted', accepted) + metric('deduped', deduped) +
      metric('expired', expired) + metric('blocked', blocked) + '</div>' +
      rowList(index.entries.filter(function (entry) { return entry.direction === 'inbox'; }), 'No inbox entries.') +
      '</div></section>' +
      '<section class="h2oSyncSection" id="h2o-sync-section-proposal-review"><summary>5. Proposal Review (preview only)</summary><div class="h2oSyncSectionBody">' +
      '<p class="h2oSyncNote">Preview generator available: ' + escapeHtml(sections.proposalPreviewAvailable ? 'yes' : 'no') +
      '. This section does not approve or apply proposals.</p>' +
      rowList(sections.previewEntries, 'No preview/proposal envelopes in the relay ledger.') +
      '</div></section>' +
      '<section class="h2oSyncSection" id="h2o-sync-section-conflict-review"><summary>6. Conflict Review (preview only)</summary><div class="h2oSyncSectionBody">' +
      '<p class="h2oSyncNote">Conflict report builder available: ' + escapeHtml(sections.conflictReportAvailable ? 'yes' : 'no') +
      '. This section does not auto-resolve conflicts.</p>' +
      rowList(sections.conflictEntries, 'No conflict or blocker entries in the relay ledger.') +
      '</div></section>' +
      '<section class="h2oSyncSection" id="h2o-sync-section-apply-log"><summary>7. Apply Log (read-only)</summary><div class="h2oSyncSectionBody">' +
      '<p class="h2oSyncNote">Apply receipt builder available: ' + escapeHtml(sections.applyEventBuilderAvailable ? 'yes' : 'no') +
      '. Receipts are evidence only and are not remote commands.</p>' +
      rowList(sections.applyEntries, 'No apply receipt entries in the relay ledger.') +
      '</div></section>' +
      '</div>';
  }

  function bindPanel() {
    var close = document.getElementById('h2o-sync-close');
    var refresh = document.getElementById('h2o-sync-refresh');
    var publish = document.getElementById('h2o-sync-publish');
    var pull = document.getElementById('h2o-sync-pull');
    if (close) close.addEventListener('click', closeManualSyncPanel);
    if (refresh) refresh.addEventListener('click', function () { refreshManualSyncPanel(); });
    if (publish) publish.addEventListener('click', function () { publishOutbox(); });
    if (pull) pull.addEventListener('click', function () { pullInbox(); });
  }

  function ensurePanel() {
    injectStyle();
    var panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('section');
      panel.id = PANEL_ID;
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Manual sync');
      document.body.appendChild(panel);
    }
    return panel;
  }

  async function renderPanel() {
    var panel = ensurePanel();
    if (!state.snapshot) state.snapshot = await collectSnapshot();
    panel.innerHTML = renderSnapshot(state.snapshot);
    bindPanel();
  }

  async function openManualSyncPanel() {
    state.open = true;
    state.message = state.message || '';
    await refreshManualSyncPanel();
    return state.snapshot;
  }

  function closeManualSyncPanel() {
    state.open = false;
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();
  }

  async function refreshManualSyncPanel() {
    state.snapshot = await collectSnapshot();
    if (state.open) await renderPanel();
    return state.snapshot;
  }

  async function publishOutbox() {
    if (state.busy) return null;
    state.busy = true;
    try {
      var fn = H2O.Desktop.Sync.uploadRelayOutbox;
      if (typeof fn !== 'function') {
        state.message = 'Publish unavailable: WebDAV relay adapter is not installed.';
        return await refreshManualSyncPanel();
      }
      var result = await fn(readConfig());
      state.message = 'Publish result: uploaded ' + cleanString(result.uploaded || 0) +
        ', already present ' + cleanString(result.alreadyPresent || 0) +
        ', failed ' + cleanString(result.failed || 0) +
        (codeList(result.blockers).length ? ' · blockers ' + codeList(result.blockers).join(', ') : '');
      return await refreshManualSyncPanel();
    } finally {
      state.busy = false;
    }
  }

  async function pullInbox() {
    if (state.busy) return null;
    state.busy = true;
    try {
      var fn = H2O.Desktop.Sync.downloadRelayInbox;
      if (typeof fn !== 'function') {
        state.message = 'Pull unavailable: WebDAV relay adapter is not installed.';
        return await refreshManualSyncPanel();
      }
      var result = await fn(readConfig());
      state.message = 'Pull result: downloaded ' + cleanString(result.downloaded || 0) +
        ', ingested ' + cleanString(result.ingested || 0) +
        ', duplicates ' + cleanString(result.duplicateIgnored || 0) +
        ', blocked ' + cleanString(result.blocked || 0) +
        (codeList(result.blockers).length ? ' · blockers ' + codeList(result.blockers).join(', ') : '');
      return await refreshManualSyncPanel();
    } finally {
      state.busy = false;
    }
  }

  function installLauncher() {
    if (typeof document === 'undefined' || !document.body || document.getElementById(LAUNCHER_ID)) return;
    injectStyle();
    var button = document.createElement('button');
    button.id = LAUNCHER_ID;
    button.type = 'button';
    button.textContent = 'Manual Sync';
    button.setAttribute('aria-label', 'Open manual sync panel');
    button.addEventListener('click', function () { openManualSyncPanel(); });
    document.body.appendChild(button);
  }

  function removeLauncher() {
    if (typeof document === 'undefined') return;
    var button = document.getElementById(LAUNCHER_ID);
    if (button) button.remove();
  }

  function bootLauncher() {
    if (typeof document === 'undefined') return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', installLauncher, { once: true });
    } else {
      installLauncher();
    }
  }

  H2O.Desktop.Sync.openManualSyncPanel = openManualSyncPanel;
  H2O.Desktop.Sync.closeManualSyncPanel = closeManualSyncPanel;
  H2O.Desktop.Sync.refreshManualSyncPanel = refreshManualSyncPanel;
  H2O.Desktop.Sync.installManualSyncLauncher = installLauncher;
  H2O.Desktop.Sync.removeManualSyncLauncher = removeLauncher;
  H2O.Desktop.Sync.__manualSyncUiInstalled = true;
  H2O.Desktop.Sync.__manualSyncUiVersion = VERSION;

})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
