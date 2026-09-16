/* H2O Studio — S0Y1a Studio Ribbon (Phase 1a)
 *
 * Surface module that:
 *   1. Registers the seven default tabs (Home / Format / Structure / AI Tools /
 *      Metadata / View / Export) and their groups + placeholder actions on
 *      H2O.Studio.ribbon (the passive shell from ribbon/ribbon-shell.studio.js).
 *   2. Mounts the ribbon DOM into the <section id="studioRibbon"> placeholder
 *      that studio.html provides above .wbMain.
 *   3. Reacts to ribbon shell events (contextChanged / tabChanged /
 *      collapsedChanged) and to H2O.Studio.store.prefs 'ready' to repaint.
 *
 * Strict Phase 1a discipline:
 *   - Every action button is rendered disabled with title "Coming soon".
 *   - No action handler mutates application data.
 *   - No chrome.* / localStorage / indexedDB / fetch.
 *   - No selectors against the ChatGPT replay DOM (no cg* queries).
 *   - No imports from src-surfaces-base/desk/.
 *   - Storage limited to the two ribbon prefs keys (delegated to the shell).
 *   - Visibility is driven by chat-type context from studio.js. When no
 *     reader chatType is active, the surface renders the saved-chat ribbon
 *     as the desktop/list default.
 *
 * Dependencies:
 *   - H2O.Studio.ribbon (ribbon-shell.studio.js, loaded earlier)
 *   - Optional: H2O.events.on (used for shell event subscriptions)
 *   - Optional: H2O.Studio.store.prefs (used indirectly via the shell)
 *
 * Does NOT depend on:
 *   - any other Studio feature module
 *   - studio.js exports (it talks to studio.js one-way, via shell.setContext)
 */
(function (global) {
  'use strict';

  const H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};

  /* Idempotency. */
  if (H2O.Studio.__studioRibbonSurfaceInstalled) return;
  H2O.Studio.__studioRibbonSurfaceInstalled = true;

  /* ── Default catalogue ─────────────────────────────────────────────────
   * Tabs not visible for a given chat type are filtered at render time.
   * chatTypes: which chatType values cause the tab to be rendered.
   * Phase 1a actions are all { disabled: true, tooltip: 'Coming soon' }. */
  const TAB_CATALOGUE = [
    {
      id: 'library-home', label: 'Home',
      chatTypes: ['library'],
      groups: [
        { id: 'library-view', label: 'Library', actions: [
          { id: 'library-dashboard', label: 'Dashboard' },
          { id: 'library-explorer',  label: 'Explorer' },
          { id: 'library-recents',   label: 'Recents' },
          { id: 'library-saved',     label: 'Saved' },
          { id: 'library-link',      label: 'Link' },
          { id: 'library-organize',  label: 'Organize' },
        ] },
        { id: 'library-index', label: 'Index', actions: [
          { id: 'library-refresh-index', label: 'Refresh index' },
        ] },
      ],
    },
    {
      id: 'home', label: 'Home',
      chatTypes: ['saved', 'indexed', 'imported', 'readonly'],
      groups: [
        { id: 'reader', label: 'Reader', actions: [
          { id: 'refresh-reader', label: 'Refresh' },
        ] },
        { id: 'edit', label: 'Edit', actions: [
          { id: 'rename-chat', label: 'Rename chat' },
          { id: 'copy-title',  label: 'Copy title' },
        ] },
        { id: 'history', label: 'History', actions: [
          { id: 'undo', label: 'Undo' },
          { id: 'redo', label: 'Redo' },
        ] },
        { id: 'source', label: 'Source', actions: [
          { id: 'open-original', label: 'Open original' },
        ] },
      ],
    },
    {
      id: 'format', label: 'Format',
      chatTypes: ['saved'],
      groups: [
        /* Phase 8f-1 — Clipboard group. First group in the Format tab.
         * One Copy action that writes the selected message as Markdown via
         * bridge.getTurnClean + platform.clipboard.writeText. Not a split
         * button; Cut / Paste / Format Painter are deferred to later slices. */
        { id: 'clipboard', label: 'Clipboard', actions: [
          { id: 'copy-message', label: 'Copy' },
          { id: 'format-painter', label: 'Format Painter' },
        ] },
        /* Phase 7a — Edit mode toggle. Single button at the very start
         * of the Format tab that flips a ribbon-local editMode boolean
         * and toggles data-edit-mode="on" on the reader root .wbReader.
         * The existing reader click handler (studio.js:5099-5139) keeps
         * setting .is-ribbon-selected on click; CSS in studio.css then
         * paints the premium ring on the selected turn whenever
         * data-edit-mode is "on". No text mutation, no textarea, no
         * overlay op, no export change in this slice. Phase 7b adds
         * click-to-edit textarea + text-replace overlay; Phase 7c adds
         * undo/redo + reset; Phase 7d adds export integration; Phase 7e
         * removes the legacy per-message pencil mounts (studio.js:2399
         * and 2459). */
        { id: 'edit', label: 'Edit Mode', actions: [
          { id: 'edit-mode', label: 'Edit' },
        ] },
        { id: 'headings', label: 'Headings', actions: [
          { id: 'h1', label: 'H1' },
          { id: 'h2', label: 'H2' },
          { id: 'h3', label: 'H3' },
        ] },
        /* Phase 4-1 — Font group (B / I / U / S / Clear). All four toggles
         * apply to the entire selected message body; "Clear" wipes ALL
         * per-message overlay decorations (Phase 2b + Phase 4-1 + Phase
         * 4-2) for the selected turn. Same enable rule as Headings
         * (saved-reader with a selected turn). */
        { id: 'font', label: 'Font', actions: [
          /* Phase 8d-1 — Font Family. Four curated typeface tokens plus a
           * "Default" to clear. Collapsed into one dropdown split button
           * (SPLIT_BUTTONS['font-family']) rendered before B/I/U/S/Clear;
           * those remain independent icon buttons. */
          { id: 'font-family-sans',     label: 'Sans' },
          { id: 'font-family-serif',    label: 'Serif' },
          { id: 'font-family-mono',     label: 'Mono' },
          { id: 'font-family-humanist', label: 'Humanist' },
          { id: 'font-family-default',  label: 'Default' },
          /* Phase 8d-2 — Font Size. Three curated semantic size tokens plus
           * a "Default" (normal) to clear. Collapsed into a second dropdown
           * split button (SPLIT_BUTTONS['font-size']) rendered after Font
           * Family and before B/I/U/S/Clear. */
          { id: 'font-size-small',   label: 'Small' },
          { id: 'font-size-default', label: 'Default' },
          { id: 'font-size-large',   label: 'Large' },
          { id: 'font-size-xlarge',  label: 'X-Large' },
          { id: 'bold',          label: 'B' },
          { id: 'italic',        label: 'I' },
          { id: 'underline',     label: 'U' },
          { id: 'strikethrough', label: 'S' },
          /* Phase 8e-1 — Subscript / Superscript. Inline (per-range) toggles
           * over a held text selection; individual icon buttons (NOT in any
           * SPLIT_BUTTONS), rendered after Strikethrough and before Clear. */
          { id: 'subscript',   label: 'x₂' },
          { id: 'superscript', label: 'x²' },
          { id: 'clear-formatting', label: 'Clear' },
        ] },
        /* Phase 4-2 — Text Color group. Five semantic colors plus a
         * "None" to clear. Each color is a separate ribbon action that
         * submits a `text-color` overlay op via the same applyOverlayOp
         * path Phase 4-1 uses. Markdown export is intentionally
         * color-agnostic; DOCX + screen + print CSS carry the actual
         * color. */
        { id: 'text-color', label: 'Text Color', actions: [
          { id: 'text-color-red',    label: 'Red' },
          { id: 'text-color-green',  label: 'Green' },
          { id: 'text-color-blue',   label: 'Blue' },
          { id: 'text-color-orange', label: 'Orange' },
          { id: 'text-color-gray',   label: 'Gray' },
          { id: 'text-color-none',   label: 'None' },
        ] },
        /* Phase 4-2 — Highlight group. Bridges the EXISTING
         * H2O.IHighlighter system from the Ribbon. The Ribbon does NOT
         * create a parallel highlight store: brush picks call into
         * H2O.IHighlighter.setCurrentColor; clear-highlights calls
         * H2O.Studio.store.highlights.removeForAnswer; show/hide calls
         * H2O.IHighlighter.setEnabled. Storage key (h2o:prm:cgx:nlnhghlghtr:
         * state:inline_highlights:v3) and schemaVersion 3 stay
         * unchanged — owned by store/highlights.js + S3H1a. */
        { id: 'highlight', label: 'Highlight', actions: [
          { id: 'highlight-brush-blue',   label: 'Blue' },
          { id: 'highlight-brush-red',    label: 'Red' },
          { id: 'highlight-brush-green',  label: 'Green' },
          { id: 'highlight-brush-gold',   label: 'Gold' },
          { id: 'highlight-brush-sky',    label: 'Sky' },
          { id: 'highlight-brush-pink',   label: 'Pink' },
          { id: 'highlight-brush-purple', label: 'Purple' },
          { id: 'highlight-brush-orange', label: 'Orange' },
          { id: 'highlight-clear-message', label: 'Clear' },
          { id: 'highlight-visibility',    label: 'Hide' },
        ] },
        /* Phase 4-3 — Paragraph group. Bullet / Numbered are list-mode
         * toggles (clicking the same kind twice clears). Align left /
         * center / right are also toggles relative to current align.
         * Indent / Outdent are deltas: read current indent level, submit
         * an absolute new level clamped to 0..3. All seven follow the
         * Phase 4-1/4-2 enable rule (formatActionsIsEnabled) and submit
         * via runOverlayOp, so undo/redo + drift detection work for free. */
        { id: 'paragraph', label: 'Paragraph', actions: [
          { id: 'list-bullet',   label: 'Bullet' },
          { id: 'list-numbered', label: 'Numbered' },
          { id: 'align-left',    label: 'Left' },
          { id: 'align-center',  label: 'Center' },
          { id: 'align-right',   label: 'Right' },
          { id: 'indent',        label: 'Indent' },
          { id: 'outdent',       label: 'Outdent' },
        ] },
        { id: 'blocks', label: 'Blocks', actions: [
          { id: 'quote',   label: 'Quote' },
          { id: 'code',    label: 'Code block' },
          { id: 'callout', label: 'Callout' },
        ] },
        /* Phase 4-4 — Annotate group. OneNote-style visual tags (NOT
         * Library metadata tags). Six independent toggles + a Clear
         * action that loops over currently-active kinds. Group label
         * is "Annotate" rather than "Tags" to disambiguate from the
         * Metadata tab's chat-tag store. */
        { id: 'annotate', label: 'Annotate', actions: [
          { id: 'visual-tag-todo',       label: 'To Do' },
          { id: 'visual-tag-important',  label: 'Important' },
          { id: 'visual-tag-question',   label: 'Question' },
          { id: 'visual-tag-definition', label: 'Definition' },
          { id: 'visual-tag-warning',    label: 'Warning' },
          { id: 'visual-tag-idea',       label: 'Idea' },
          { id: 'visual-tag-clear',      label: 'Clear tags' },
        ] },
        { id: 'cleanup', label: 'Cleanup', actions: [
          { id: 'clean-spacing', label: 'Clean spacing' },
        ] },
      ],
    },
    {
      id: 'structure', label: 'Structure',
      chatTypes: ['saved'],
      groups: [
        { id: 'sections', label: 'Sections', actions: [
          { id: 'add-section',      label: 'Add section' },
          { id: 'split-section',    label: 'Split section' },
          { id: 'collapse-section', label: 'Collapse section' },
        ] },
        { id: 'navigation', label: 'Navigation', actions: [
          { id: 'page-divider',     label: 'Page divider' },
          { id: 'table-of-contents', label: 'Table of contents' },
        ] },
      ],
    },
    {
      id: 'ai-tools', label: 'AI Tools',
      chatTypes: ['saved'],
      groups: [
        { id: 'extract', label: 'Extract', actions: [
          { id: 'summarize',     label: 'Summarize',     tooltip: 'AI provider unavailable', phase: '3d-b' },
          { id: 'extract-tasks', label: 'Extract tasks', tooltip: 'AI provider unavailable', phase: '3d-c1' },
          { id: 'generate-tags', label: 'Generate tags', tooltip: 'AI provider unavailable', phase: '3d-d' },
        ] },
        { id: 'rewrite', label: 'Rewrite', actions: [
          { id: 'rewrite-selection', label: 'Rewrite selected', tooltip: 'AI provider unavailable', phase: '3d-e' },
          { id: 'study-notes',       label: 'Create study notes', tooltip: 'AI provider unavailable', phase: '3d-c2' },
        ] },
      ],
    },
    {
      id: 'metadata', label: 'Metadata',
      chatTypes: ['saved', 'indexed', 'imported', 'readonly'],
      groups: [
        { id: 'labels', label: 'Labels', actions: [
          /* Phase 1c — placeholder tooltips updated with specific reason
           * for why these stay disabled (no public Workspace mutation API
           * yet; provider modules are read-only at the Studio surface). */
          { id: 'add-tags', label: 'Tags',     tooltip: 'No public Tags/Labels API yet' },
          { id: 'category', label: 'Category' },
          { id: 'folder',   label: 'Folder' },
          { id: 'project',  label: 'Project',  tooltip: 'No public Project API yet' },
          { id: 'status',   label: 'Status',   tooltip: 'Chat status is not in Studio schema yet' },
        ] },
        { id: 'source', label: 'Source', actions: [
          { id: 'source-link', label: 'Source link' },
          { id: 'system-status', label: 'System' },
        ] },
      ],
    },
    {
      id: 'view', label: 'View',
      chatTypes: ['saved', 'indexed', 'imported', 'readonly'],
      groups: [
        { id: 'modes', label: 'Modes', actions: [
          { id: 'compact-mode', label: 'Compact mode' },
          { id: 'focus-mode',   label: 'Focus mode' },
        ] },
        { id: 'overlays', label: 'Overlays', actions: [
          { id: 'show-timestamps', label: 'Timestamps' },
          { id: 'show-minimap',    label: 'MiniMap' },
        ] },
        { id: 'width', label: 'Width', actions: [
          { id: 'reading-width', label: 'Reading width' },
        ] },
      ],
    },
    {
      id: 'export', label: 'Export',
      chatTypes: ['saved', 'indexed', 'imported', 'readonly'],
      groups: [
        { id: 'copy', label: 'Copy', actions: [
          { id: 'copy-clean-transcript', label: 'Copy clean transcript' },
        ] },
        { id: 'download', label: 'Download', actions: [
          { id: 'export-markdown', label: 'Markdown' },
          { id: 'export-pdf',      label: 'PDF' },
          { id: 'export-docx',     label: 'DOCX' },
        ] },
        { id: 'print', label: 'Print', actions: [
          { id: 'print-view', label: 'Print view' },
        ] },
      ],
    },
  ];

  /* ── Helpers ─────────────────────────────────────────────────────────── */
  function getShell() {
    return H2O && H2O.Studio && H2O.Studio.ribbon;
  }
  function getContainer() {
    return document.getElementById('studioRibbon');
  }
  function getRibbonControlParking(container) {
    let parking = null;
    try { parking = document.getElementById('studioRibbonControlParking'); }
    catch (_) { parking = null; }
    if (parking) return parking;
    try {
      parking = document.createElement('div');
      parking.id = 'studioRibbonControlParking';
      parking.className = 'wbRibbonControlParking';
      parking.hidden = true;
      parking.setAttribute('aria-hidden', 'true');
      const parent = container && container.parentNode;
      if (parent) parent.insertBefore(parking, container.nextSibling || null);
      else document.body.appendChild(parking);
    } catch (_) { parking = null; }
    return parking;
  }
  function getRefreshButton() {
    try { return document.getElementById('refreshBtn'); }
    catch (_) { return null; }
  }
  function prepareRefreshButton(button) {
    if (!button) return null;
    try {
      button.className = 'wbRibbonAction wbRibbonRefreshAction';
      button.type = 'button';
      button.hidden = false;
      button.removeAttribute('aria-hidden');
      button.removeAttribute('disabled');
      button.setAttribute('data-action-id', 'refresh-reader');
      button.setAttribute('aria-disabled', 'false');
      button.setAttribute('aria-label', 'Refresh current view');
      button.title = 'Refresh current view';
      button.textContent = 'Refresh';
    } catch (_) { /* swallow */ }
    return button;
  }
  function parkRefreshControl(container) {
    const parking = getRibbonControlParking(container);
    const button = getRefreshButton();
    if (!parking || !button) return;
    try {
      if (button.parentNode !== parking) parking.appendChild(button);
      button.hidden = true;
      button.setAttribute('aria-hidden', 'true');
    } catch (_) { /* swallow */ }
  }
  let metadataPopoverKind = null;
  function getMetadataParking(container) {
    let parking = null;
    try { parking = document.getElementById('studioRibbonMetadataParking'); }
    catch (_) { parking = null; }
    if (parking) return parking;
    try {
      parking = document.createElement('div');
      parking.id = 'studioRibbonMetadataParking';
      parking.className = 'wbRibbonMetadataParking';
      parking.hidden = true;
      parking.setAttribute('aria-hidden', 'true');
      const parent = container && container.parentNode;
      if (parent) parent.insertBefore(parking, container.nextSibling || null);
      else document.body.appendChild(parking);
    } catch (_) { parking = null; }
    return parking;
  }
  function removeMetadataPopovers(container) {
    try {
      const root = container || getContainer();
      if (!root || !root.querySelectorAll) return;
      Array.prototype.slice.call(root.querySelectorAll('.wbRibbonMetadataPopover')).forEach(function (node) {
        try { node.remove(); } catch (_) {
          try { if (node.parentNode) node.parentNode.removeChild(node); } catch (__) { /* swallow */ }
        }
      });
    } catch (_) { /* swallow */ }
  }
  function parkMetadataControls(container) {
    const parking = getMetadataParking(container);
    if (!parking) return;
    ['categoryAssignWrap', 'folderAssignWrap'].forEach(function (id) {
      let node = null;
      try { node = document.getElementById(id); } catch (_) { node = null; }
      if (!node || node.parentNode === parking) return;
      try { parking.appendChild(node); } catch (_) { /* swallow */ }
    });
    removeMetadataPopovers(container);
    metadataPopoverKind = null;
    syncMetadataButtons(container);
  }
  function selectedOptionText(select) {
    if (!select) return '';
    try {
      const option = select.options && select.selectedIndex >= 0
        ? select.options[select.selectedIndex]
        : null;
      return String((option && option.textContent) || select.value || '').trim();
    } catch (_) { return ''; }
  }
  function getCategoryDetail() {
    let select = null;
    let status = null;
    try { select = document.getElementById('categoryAssignSelect'); } catch (_) { select = null; }
    try { status = document.getElementById('categoryStatusRibbon') || document.getElementById('categoryStatusTopbar'); } catch (_) { status = null; }
    const text = selectedOptionText(select);
    if (text && text !== 'Select category') return text;
    const primary = String((status && status.dataset && status.dataset.primaryName) || '').trim();
    return primary || 'Uncategorized';
  }
  function getFolderDetail() {
    let select = null;
    try { select = document.getElementById('folderAssignSelect'); } catch (_) { select = null; }
    return selectedOptionText(select) || 'Unfiled';
  }
  function getSystemStatusParts() {
    let status = null;
    try { status = document.getElementById('categoryStatusRibbon') || document.getElementById('categoryStatusTopbar'); } catch (_) { status = null; }
    const ds = (status && status.dataset) || {};
    const label = String(ds.sourceLabel || '').trim();
    const confidence = String(ds.confidenceText || '').trim();
    const primary = String(ds.primaryName || '').trim();
    return {
      visible: !!(label || confidence || primary),
      label: label || 'System',
      detail: confidence || primary || '',
    };
  }
  function metadataControlIsAvailable(kind) {
    const id = kind === 'folder' ? 'folderAssignWrap' : 'categoryAssignWrap';
    let node = null;
    try { node = document.getElementById(id); } catch (_) { node = null; }
    return !!(node && !node.hidden);
  }
  function setMetadataButtonContent(button, label, detail) {
    if (!button) return;
    try {
      button.innerHTML = '';
      button.appendChild(el('span', { class: 'wbRibbonMetadataButtonLabel' }, label));
      if (detail) button.appendChild(el('span', { class: 'wbRibbonMetadataButtonValue' }, detail));
    } catch (_) { button.textContent = detail ? (label + ' ' + detail) : label; }
  }
  function syncMetadataButtons(container) {
    const root = container || getContainer();
    if (!root || !root.querySelector) return;
    const categoryBtn = root.querySelector('[data-action-id="category"]');
    const folderBtn = root.querySelector('[data-action-id="folder"]');
    if (categoryBtn) {
      const available = metadataControlIsAvailable('category');
      setMetadataButtonContent(categoryBtn, 'Category', available ? getCategoryDetail() : '');
      categoryBtn.disabled = !available;
      categoryBtn.setAttribute('aria-disabled', available ? 'false' : 'true');
      categoryBtn.setAttribute('aria-expanded', metadataPopoverKind === 'category' ? 'true' : 'false');
      categoryBtn.title = available ? 'Edit category' : 'Category unavailable';
    }
    if (folderBtn) {
      const available = metadataControlIsAvailable('folder');
      setMetadataButtonContent(folderBtn, 'Folder', available ? getFolderDetail() : '');
      folderBtn.disabled = !available;
      folderBtn.setAttribute('aria-disabled', available ? 'false' : 'true');
      folderBtn.setAttribute('aria-expanded', metadataPopoverKind === 'folder' ? 'true' : 'false');
      folderBtn.title = available ? 'Edit folder' : 'Folder unavailable';
    }
    const statusPill = root.querySelector('[data-ribbon-metadata-status="system"]');
    if (statusPill) {
      const parts = getSystemStatusParts();
      statusPill.hidden = !parts.visible;
      setMetadataButtonContent(statusPill, parts.label, parts.detail);
      statusPill.title = parts.detail ? (parts.label + ' ' + parts.detail) : parts.label;
    }
  }
  function positionMetadataPopover(popover, trigger, container) {
    if (!(popover && trigger && container)) return;
    try {
      const rootRect = container.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      const width = Math.min(360, Math.max(260, rootRect.width - 24));
      popover.style.width = width + 'px';
      popover.style.left = Math.max(8, Math.min(triggerRect.left - rootRect.left, rootRect.width - width - 8)) + 'px';
      popover.style.top = Math.max(42, triggerRect.bottom - rootRect.top + 6) + 'px';
    } catch (_) { /* CSS fallback handles placement */ }
  }
  function toggleMetadataPopover(kind, trigger, setStatus) {
    const container = getContainer();
    if (!container) return;
    const id = kind === 'folder' ? 'folderAssignWrap' : 'categoryAssignWrap';
    let node = null;
    try { node = document.getElementById(id); } catch (_) { node = null; }
    if (!node || node.hidden) {
      if (setStatus) setStatus(kind === 'folder' ? 'Folder unavailable' : 'Category unavailable');
      syncMetadataButtons(container);
      return;
    }
    if (metadataPopoverKind === kind) {
      parkMetadataControls(container);
      if (setStatus) setStatus(kind === 'folder' ? 'Folder options closed' : 'Category options closed');
      return;
    }
    parkMetadataControls(container);
    const title = kind === 'folder' ? 'Folder' : 'Category';
    const popover = el('div', {
      class: 'wbRibbonMetadataPopover',
      role: 'dialog',
      'aria-label': title + ' options',
      'data-metadata-popover': kind,
    });
    const header = el('div', { class: 'wbRibbonMetadataPopoverHeader' });
    header.appendChild(el('div', { class: 'wbRibbonMetadataPopoverTitle' }, title));
    header.appendChild(el('button', {
      type: 'button',
      class: 'wbRibbonMetadataPopoverClose',
      'aria-label': 'Close ' + title.toLowerCase() + ' options',
      'data-metadata-popover-close': 'true',
    }, 'Close'));
    popover.appendChild(header);
    const body = el('div', { class: 'wbRibbonMetadataPopoverBody' });
    body.appendChild(node);
    popover.appendChild(body);
    container.appendChild(popover);
    metadataPopoverKind = kind;
    positionMetadataPopover(popover, trigger, container);
    syncMetadataButtons(container);
    if (setStatus) setStatus(kind === 'folder' ? 'Folder options open' : 'Category options open');
  }
  function safeEmit(name, detail) {
    try {
      if (H2O && H2O.events && typeof H2O.events.emit === 'function') {
        H2O.events.emit(name, detail || {});
      }
    } catch (_) { /* swallow */ }
  }
  function safeOn(name, fn) {
    try {
      if (H2O && H2O.events && typeof H2O.events.on === 'function') {
        H2O.events.on(name, fn);
      }
    } catch (_) { /* swallow */ }
  }
  function getPlatform() {
    try { return (H2O && H2O.Studio && H2O.Studio.platform) || null; }
    catch (_) { return null; }
  }
  function getRibbonBridge() {
    try { return (H2O && H2O.Studio && H2O.Studio.RibbonBridge) || null; }
    catch (_) { return null; }
  }
  /* Phase 5b-1 — read the held inline-selection capture (snapshotted by
   * studio.js on selectionchange so a ribbon-button click that collapses
   * the selection does not lose it). Returns the last successful capture
   * diagnostic or null. */
  function getHeldInlineCapture() {
    try {
      const isel = H2O && H2O.Studio && H2O.Studio.inlineSelection;
      if (isel && typeof isel.getHeldCapture === 'function') return isel.getHeldCapture();
    } catch (_) {}
    return null;
  }
  function getOverlayApi() {
    try { return (H2O && H2O.Studio && H2O.Studio.overlay) || null; }
    catch (_) { return null; }
  }
  function getInference() {
    try {
      const platform = getPlatform();
      return (platform && platform.inference) || null;
    } catch (_) { return null; }
  }
  function normalizeInferenceStatus(status) {
    if (!status || typeof status !== 'object') {
      return {
        available: false,
        configured: false,
        reason: 'adapter-missing',
        message: 'AI provider unavailable',
      };
    }
    return {
      available: status.available === true,
      configured: status.configured === true,
      provider: status.provider || null,
      reason: status.reason || (status.available === true ? null : 'provider-unavailable'),
      message: status.message || (status.available === true ? 'AI provider available' : 'AI provider unavailable'),
      phase: status.phase || '3d-a',
    };
  }
  function getInferenceStatus() {
    const inference = getInference();
    if (!inference || typeof inference.getStatus !== 'function') {
      return normalizeInferenceStatus(null);
    }
    try {
      const status = inference.getStatus();
      if (status && typeof status.then === 'function') {
        return {
          available: false,
          configured: false,
          reason: 'status-pending',
          message: 'AI provider unavailable',
          phase: '3d-a',
        };
      }
      return normalizeInferenceStatus(status);
    } catch (_) {
      return {
        available: false,
        configured: false,
        reason: 'status-error',
        message: 'AI provider unavailable',
        phase: '3d-a',
      };
    }
  }
  function getAiUnavailableMessage() {
    const status = getInferenceStatus();
    return status.message || 'AI provider unavailable';
  }
  function makePassiveAiHandler(actionId) {
    return {
      actionId: actionId,
      isEnabled: function () {
        /* Phase 3d-A only installs the passive contract and disabled UI.
         * No AI requests are allowed from ribbon actions in this slice. */
        return false;
      },
      disabledTooltip: function () {
        const status = getInferenceStatus();
        return status.available ? 'Coming soon' : (status.message || 'AI provider unavailable');
      },
      onClick: function (ctx, setStatus) {
        setStatus(getAiUnavailableMessage(), { persist: true });
      },
    };
  }

  const AI_TRANSCRIPT_CHAR_LIMIT = 24000;
  const AI_TRANSCRIPT_HEAD_CHARS = 12000;
  const AI_TRANSCRIPT_TAIL_CHARS = 12000;
  const AI_TRANSCRIPT_OMISSION = '\n\n[... transcript truncated for AI action ...]\n\n';
  const AI_SUMMARY_OMISSION = '\n\n[... transcript truncated for summary ...]\n\n';
  let aiSummaryRequestSeq = 0;
  let aiSummaryActiveRequestId = null;
  let aiTaskRequestSeq = 0;
  let aiTaskActiveRequestId = null;
  let aiStudyNotesRequestSeq = 0;
  let aiStudyNotesActiveRequestId = null;
  let aiTagsRequestSeq = 0;
  let aiTagsActiveRequestId = null;
  let aiRewriteRequestSeq = 0;
  let aiRewriteActiveRequestId = null;

  function buildAiTranscriptInput(text, transcriptMeta, opts) {
    const options = (opts && typeof opts === 'object') ? opts : {};
    const omission = (typeof options.omission === 'string' && options.omission)
      ? options.omission
      : AI_TRANSCRIPT_OMISSION;
    const raw = String(text || '').trim();
    const originalChars = raw.length;
    let bounded = raw;
    let truncated = false;
    if (originalChars > AI_TRANSCRIPT_CHAR_LIMIT) {
      bounded = raw.slice(0, AI_TRANSCRIPT_HEAD_CHARS)
        + omission
        + raw.slice(Math.max(0, originalChars - AI_TRANSCRIPT_TAIL_CHARS));
      truncated = true;
    }
    const meta = (transcriptMeta && typeof transcriptMeta === 'object') ? transcriptMeta : {};
    return {
      text: bounded,
      truncated: truncated,
      originalChars: originalChars,
      sentChars: bounded.length,
      overlayIncluded: meta.overlayIncluded === true,
      overlaySkipped: meta.overlaySkipped === true,
      overlayReason: meta.reason ? String(meta.reason) : null,
    };
  }

  function buildSummaryInput(text, transcriptMeta) {
    return buildAiTranscriptInput(text, transcriptMeta, { omission: AI_SUMMARY_OMISSION });
  }

  function buildAiPromptPreamble(ctx, transcriptInput) {
    const title = String((ctx && ctx.title) || '').trim();
    const truncationNote = transcriptInput.truncated
      ? 'The transcript was truncated deterministically: first 12000 characters, an omission marker, then the last 12000 characters.'
      : 'The transcript was not truncated.';
    const overlayNote = transcriptInput.overlaySkipped
      ? ('Overlay was skipped' + (transcriptInput.overlayReason ? ': ' + transcriptInput.overlayReason : '') + '.')
      : (transcriptInput.overlayIncluded ? 'Overlay-aware transcript was used.' : 'Raw clean transcript was used.');
    return [
      title ? ('Title: ' + title) : 'Title: Untitled chat',
      truncationNote,
      overlayNote,
    ];
  }

  function buildAiRequestBase(action, phase, transcriptInput, options) {
    return {
      input: {
        kind: 'overlay-clean-transcript',
        truncated: transcriptInput.truncated,
        originalChars: transcriptInput.originalChars,
        sentChars: transcriptInput.sentChars,
        overlayIncluded: transcriptInput.overlayIncluded,
        overlaySkipped: transcriptInput.overlaySkipped,
        overlayReason: transcriptInput.overlayReason,
      },
      metadata: {
        surface: 'studio',
        feature: 'ribbon',
        action: action,
        truncated: transcriptInput.truncated,
        originalChars: transcriptInput.originalChars,
        sentChars: transcriptInput.sentChars,
        overlayIncluded: transcriptInput.overlayIncluded,
        overlaySkipped: transcriptInput.overlaySkipped,
        overlayReason: transcriptInput.overlayReason,
      },
      options: options || {},
      phase: phase,
      action: action,
    };
  }

  function buildSummarizeRequest(ctx, summaryInput) {
    const userPrompt = [
      ...buildAiPromptPreamble(ctx, summaryInput),
      '',
      'Summarize this chat transcript. Return concise Markdown with:',
      '- Overview',
      '- Key points',
      '- Decisions or answers',
      '- Open questions, if any',
      '',
      'Transcript:',
      summaryInput.text,
    ].join('\n');
    const requestId = 'studio-ribbon-summarize-' + Date.now().toString(36) + '-' + (++aiSummaryRequestSeq);
    return Object.assign(buildAiRequestBase('summarize', '3d-b', summaryInput, {
      maxTokens: 700,
      temperature: 0.2,
    }), {
      requestId: requestId,
      messages: [
        {
          role: 'system',
          content: 'You summarize user-provided chat transcripts. Do not invent facts. If information is missing or uncertain, say so briefly. Return only the requested summary.',
        },
        { role: 'user', content: userPrompt },
      ],
    });
  }

  function buildExtractTasksRequest(ctx, transcriptInput) {
    const userPrompt = [
      ...buildAiPromptPreamble(ctx, transcriptInput),
      '',
      'Extract only explicit or strongly implied tasks from this chat transcript.',
      'Do not invent tasks, owners, dates, or priorities.',
      'If no clear tasks exist, return exactly:',
      'No clear tasks found.',
      '',
      'When tasks exist, return Markdown exactly in this format:',
      '## Tasks',
      '',
      '- [ ] Task: ...',
      '  Priority: High | Medium | Low | Not mentioned',
      '  Due: YYYY-MM-DD | Not mentioned',
      '  Source/context: ...',
      '',
      'Transcript:',
      transcriptInput.text,
    ].join('\n');
    const requestId = 'studio-ribbon-extract-tasks-' + Date.now().toString(36) + '-' + (++aiTaskRequestSeq);
    return Object.assign(buildAiRequestBase('extract-tasks', '3d-c1', transcriptInput, {
      maxTokens: 900,
      temperature: 0.1,
    }), {
      requestId: requestId,
      messages: [
        {
          role: 'system',
          content: 'You extract action items from user-provided chat transcripts. Extract only explicit or strongly implied tasks. Do not invent tasks, owners, dates, or priorities. If no clear tasks are present, return exactly: No clear tasks found.',
        },
        { role: 'user', content: userPrompt },
      ],
    });
  }

  function buildStudyNotesRequest(ctx, transcriptInput) {
    const userPrompt = [
      ...buildAiPromptPreamble(ctx, transcriptInput),
      '',
      'Create Markdown study notes from this chat transcript.',
      'Do not invent facts.',
      'Omit sections only if they are clearly not applicable.',
      'Keep the main headings when possible.',
      '',
      'Return this structure:',
      '## Study Notes',
      '',
      '### Overview',
      '...',
      '',
      '### Key Concepts',
      '...',
      '',
      '### Important Details',
      '...',
      '',
      '### Definitions / Formulas',
      '...',
      '',
      '### Examples',
      '...',
      '',
      '### Review Questions',
      '...',
      '',
      '### Study Checklist',
      '- [ ] ...',
      '',
      'Transcript:',
      transcriptInput.text,
    ].join('\n');
    const requestId = 'studio-ribbon-study-notes-' + Date.now().toString(36) + '-' + (++aiStudyNotesRequestSeq);
    return Object.assign(buildAiRequestBase('study-notes', '3d-c2', transcriptInput, {
      maxTokens: 1200,
      temperature: 0.2,
    }), {
      requestId: requestId,
      messages: [
        {
          role: 'system',
          content: 'You create study notes from user-provided chat transcripts. Do not invent facts. Omit sections only if clearly not applicable, and keep the main headings when possible.',
        },
        { role: 'user', content: userPrompt },
      ],
    });
  }

  function buildGenerateTagsRequest(ctx, transcriptInput) {
    const userPrompt = [
      ...buildAiPromptPreamble(ctx, transcriptInput),
      '',
      'Generate suggested tags for this chat transcript.',
      'Suggest 10-12 tags maximum.',
      'Use short, reusable tag names.',
      'Do not invent topics.',
      'Do not duplicate or near-duplicate tags.',
      'Do not invent confidence or reasons beyond evidence in the transcript.',
      'If no clear tags exist, return exactly:',
      'No clear tags found.',
      '',
      'When tags exist, return Markdown exactly in this format:',
      '## Suggested Tags',
      '',
      '- Tag: ...',
      '  Confidence: High | Medium | Low',
      '  Reason: ...',
      '',
      'Transcript:',
      transcriptInput.text,
    ].join('\n');
    const requestId = 'studio-ribbon-generate-tags-' + Date.now().toString(36) + '-' + (++aiTagsRequestSeq);
    return Object.assign(buildAiRequestBase('generate-tags', '3d-d', transcriptInput, {
      maxTokens: 650,
      temperature: 0.1,
    }), {
      requestId: requestId,
      messages: [
        {
          role: 'system',
          content: 'You suggest concise tags from user-provided chat transcripts. Do not invent topics, duplicate tags, or invent confidence/reasons beyond evidence. If no clear tags are present, return exactly: No clear tags found.',
        },
        { role: 'user', content: userPrompt },
      ],
    });
  }

  function getRewriteRole(turnEl, textRoot) {
    const raw = String(
      (turnEl && turnEl.getAttribute && turnEl.getAttribute('data-turn'))
      || (textRoot && textRoot.getAttribute && textRoot.getAttribute('data-message-author-role'))
      || ''
    ).toLowerCase();
    if (raw === 'assistant' || raw === 'user' || raw === 'system') return raw;
    return raw || 'unknown';
  }

  function elementHasMessageId(el, messageId) {
    const want = String(messageId || '').trim();
    if (!el || !want) return false;
    try {
      if (el.getAttribute && String(el.getAttribute('data-message-id') || '').trim() === want) return true;
      const nodes = (typeof el.querySelectorAll === 'function')
        ? Array.prototype.slice.call(el.querySelectorAll('[data-message-id]'))
        : [];
      for (let i = 0; i < nodes.length; i += 1) {
        if (String(nodes[i].getAttribute('data-message-id') || '').trim() === want) return true;
      }
    } catch (_) { /* swallow */ }
    return false;
  }

  function findRewriteSelectedTurn(ctx) {
    if (!ctx || ctx.chatType !== 'saved') return null;
    const turnIdx = Number(ctx.selectedTurnIdx);
    if (!Number.isFinite(turnIdx) || turnIdx <= 0) return null;
    let turns = [];
    try {
      turns = (typeof document.querySelectorAll === 'function')
        ? Array.prototype.slice.call(document.querySelectorAll('[data-turn]'))
        : [];
    } catch (_) { turns = []; }
    for (let i = 0; i < turns.length; i += 1) {
      try {
        if (turns[i].classList && turns[i].classList.contains('is-ribbon-selected')) {
          return turns[i];
        }
      } catch (_) { /* continue */ }
    }
    return turns[Math.floor(turnIdx) - 1] || null;
  }

  function findRewriteTextRoot(turnEl, selectedMessageId) {
    if (!turnEl || typeof turnEl.querySelectorAll !== 'function') return turnEl || null;
    const want = String(selectedMessageId || '').trim();
    if (want) {
      try {
        const messageNodes = Array.prototype.slice.call(turnEl.querySelectorAll('[data-message-id]'));
        for (let i = 0; i < messageNodes.length; i += 1) {
          if (String(messageNodes[i].getAttribute('data-message-id') || '').trim() === want) return messageNodes[i];
        }
      } catch (_) { /* fall through */ }
    }
    try {
      return turnEl.querySelector('[data-message-author-role]') || turnEl.querySelector('.cgMsgBody') || turnEl;
    } catch (_) {
      return turnEl;
    }
  }

  function extractRewriteTextFromElement(rootEl) {
    if (!rootEl) return '';
    try {
      const clone = (typeof rootEl.cloneNode === 'function') ? rootEl.cloneNode(true) : null;
      if (clone && typeof clone.querySelectorAll === 'function') {
        const removeNodes = Array.prototype.slice.call(clone.querySelectorAll('.wbEditBtn, .wbEditWrap, button, input, select, textarea, [contenteditable="true"]'));
        removeNodes.forEach(function (node) {
          try { if (node && node.parentNode) node.parentNode.removeChild(node); } catch (_) { /* swallow */ }
        });
        const codeNodes = Array.prototype.slice.call(clone.querySelectorAll('pre code, pre'));
        codeNodes.forEach(function (node) {
          try {
            const lang = String((node.className || '').match && ((node.className || '').match(/language-(\S+)/) || [])[1] || '');
            const text = String(node.textContent || '');
            const replacement = document.createTextNode('\n```' + lang + '\n' + text + '\n```\n');
            if (node.parentNode) node.parentNode.replaceChild(replacement, node);
          } catch (_) { /* swallow */ }
        });
        return String(clone.textContent || '').trim();
      }
    } catch (_) { /* fall through */ }
    try { return String(rootEl.textContent || '').trim(); }
    catch (_) { return ''; }
  }

  function buildRewriteSelectionInput(ctx) {
    const turnIdx = Number(ctx && ctx.selectedTurnIdx);
    if (!ctx || ctx.chatType !== 'saved' || !Number.isFinite(turnIdx) || turnIdx <= 0) {
      return { ok: false, reason: 'no-selection' };
    }
    const selectedMessageId = String((ctx && ctx.selectedMessageId) || '').trim();
    const turnEl = findRewriteSelectedTurn(ctx);
    if (!turnEl) return { ok: false, reason: 'no-selection' };
    const textRoot = findRewriteTextRoot(turnEl, selectedMessageId);
    const role = getRewriteRole(turnEl, textRoot);
    const raw = extractRewriteTextFromElement(textRoot);
    if (!raw.trim()) return { ok: false, reason: 'empty-selection' };
    const bounded = buildAiTranscriptInput(raw, {});
    return {
      ok: true,
      text: bounded.text,
      role: role,
      selectedTurnIdx: Math.floor(turnIdx),
      selectedMessageId: selectedMessageId || null,
      selectedMessageIdMatched: selectedMessageId ? elementHasMessageId(turnEl, selectedMessageId) : false,
      truncated: bounded.truncated,
      originalChars: bounded.originalChars,
      sentChars: bounded.sentChars,
    };
  }

  function buildRewriteSelectionRequest(ctx, selectionInput) {
    const title = String((ctx && ctx.title) || '').trim();
    const truncationNote = selectionInput.truncated
      ? 'The selected text was truncated deterministically: first 12000 characters, an omission marker, then the last 12000 characters.'
      : 'The selected text was not truncated.';
    const userPrompt = [
      title ? ('Title: ' + title) : 'Title: Untitled chat',
      'Selected turn index: ' + String(selectionInput.selectedTurnIdx),
      'Selected message ID: ' + String(selectionInput.selectedMessageId || 'Not available'),
      'Role: ' + String(selectionInput.role || 'unknown'),
      truncationNote,
      '',
      'Rewrite only the selected text.',
      'Preserve meaning, facts, technical terms, code, IDs, filenames, and identifiers.',
      'Do not add new facts.',
      'Do not remove important constraints.',
      'Keep the same language as the selected text unless the selected text is mixed-language.',
      'Return the rewritten text only.',
      'Add a short note only if necessary.',
      '',
      'Selected text:',
      selectionInput.text,
    ].join('\n');
    const requestId = 'studio-ribbon-rewrite-selection-' + Date.now().toString(36) + '-' + (++aiRewriteRequestSeq);
    return {
      requestId: requestId,
      input: {
        kind: 'selected-message-text',
        selectedTurnIdx: selectionInput.selectedTurnIdx,
        selectedMessageId: selectionInput.selectedMessageId,
        role: selectionInput.role,
        truncated: selectionInput.truncated,
        originalChars: selectionInput.originalChars,
        sentChars: selectionInput.sentChars,
      },
      metadata: {
        surface: 'studio',
        feature: 'ribbon',
        action: 'rewrite-selection',
        selectedTurnIdx: selectionInput.selectedTurnIdx,
        selectedMessageId: selectionInput.selectedMessageId,
        role: selectionInput.role,
        truncated: selectionInput.truncated,
        originalChars: selectionInput.originalChars,
        sentChars: selectionInput.sentChars,
      },
      options: {
        maxTokens: 900,
        temperature: 0.2,
      },
      phase: '3d-e',
      action: 'rewrite-selection',
      messages: [
        {
          role: 'system',
          content: 'You rewrite selected text. Preserve meaning, facts, technical terms, code, IDs, filenames, identifiers, and important constraints. Do not add new facts. Return the rewritten text only unless a short note is necessary.',
        },
        { role: 'user', content: userPrompt },
      ],
    };
  }

  function aiFailureReason(result) {
    if (!result || typeof result !== 'object') return 'unknown';
    return String(result.reason || result.error || result.message || 'unknown');
  }

  function summaryFailureReason(result) {
    return aiFailureReason(result);
  }

  function extractAiResultText(result) {
    if (typeof result === 'string') return result.trim();
    if (!result || typeof result !== 'object') return '';
    if (result.ok === false) return '';
    const directFields = ['summary', 'tasks', 'notes', 'tags', 'rewrite', 'rewrittenText', 'text', 'content', 'outputText', 'output', 'message'];
    for (let i = 0; i < directFields.length; i += 1) {
      const value = result[directFields[i]];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    if (result.result && typeof result.result === 'object') {
      return extractAiResultText(result.result);
    }
    if (result.data && typeof result.data === 'object') {
      return extractAiResultText(result.data);
    }
    return '';
  }

  function extractSummaryText(result) {
    return extractAiResultText(result);
  }

  function removeAiResultModal() {
    try {
      const existing = document.getElementById('wbRibbonAiSummaryModal');
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    } catch (_) { /* swallow */ }
  }

  function removeSummaryModal() {
    removeAiResultModal();
  }

  function showAiResultModal(titleText, resultText, transcriptInput, setStatus, opts) {
    const options = (opts && typeof opts === 'object') ? opts : {};
    const label = String(titleText || 'AI Result');
    const copyStatus = options.copyStatus || 'Copied';
    const failPrefix = options.failPrefix || 'AI action failed';
    const truncatedNote = options.truncatedNote || 'Transcript truncated';
    removeAiResultModal();
    const host = document.body || getContainer();
    if (!host || typeof host.appendChild !== 'function') {
      setStatus(failPrefix + ': result surface unavailable');
      return false;
    }
    const overlay = el('div', {
      id: 'wbRibbonAiSummaryModal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': label,
      style: 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.38);padding:24px;',
    });
    const panel = el('div', {
      class: 'wbRibbonAiSummaryPanel',
      style: 'width:min(720px,calc(100vw - 48px));max-height:min(720px,calc(100vh - 48px));display:flex;flex-direction:column;border:1px solid rgba(15,23,42,.18);border-radius:8px;background:#fff;color:#111827;box-shadow:0 24px 80px rgba(15,23,42,.28);overflow:hidden;',
    });
    const head = el('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(15,23,42,.12);',
    });
    const title = el('div', { style: 'font-size:15px;font-weight:700;line-height:1.3;' }, label);
    const closeTop = el('button', {
      type: 'button',
      title: 'Close',
      'aria-label': 'Close',
      style: 'border:1px solid rgba(15,23,42,.16);background:#fff;color:#111827;border-radius:6px;padding:5px 9px;font-size:13px;cursor:pointer;',
    }, 'Close');
    const body = el('pre', {
      style: 'margin:0;padding:16px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-height:520px;',
    });
    body.textContent = String(resultText || '');
    const foot = el('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-top:1px solid rgba(15,23,42,.12);',
    });
    const note = el('div', {
      style: 'font-size:12px;color:#4b5563;line-height:1.35;',
    }, transcriptInput && transcriptInput.truncated ? truncatedNote : '');
    const actions = el('div', { style: 'display:flex;align-items:center;gap:8px;' });
    const copyBtn = el('button', {
      type: 'button',
      style: 'border:1px solid rgba(15,23,42,.16);background:#111827;color:#fff;border-radius:6px;padding:6px 11px;font-size:13px;cursor:pointer;',
    }, 'Copy');
    const closeBtn = el('button', {
      type: 'button',
      style: 'border:1px solid rgba(15,23,42,.16);background:#fff;color:#111827;border-radius:6px;padding:6px 11px;font-size:13px;cursor:pointer;',
    }, 'Close');

    function close() { removeSummaryModal(); }
    function copySummary() {
      const platform = getPlatform();
      const clip = platform && platform.clipboard;
      if (!clip || typeof clip.writeText !== 'function') {
        setStatus(failPrefix + ': clipboard unavailable');
        return;
      }
      Promise.resolve(clip.writeText(String(resultText || ''))).then(
        function () { setStatus(copyStatus); },
        function (err) {
          const msg = (err && (err.message || String(err))) || 'unknown error';
          setStatus(failPrefix + ': ' + msg);
        }
      );
    }

    closeTop.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
    copyBtn.addEventListener('click', copySummary);
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) close();
    });
    overlay.addEventListener('keydown', function (ev) {
      if (ev && ev.key === 'Escape') {
        ev.preventDefault();
        close();
      }
    });

    head.appendChild(title);
    head.appendChild(closeTop);
    actions.appendChild(copyBtn);
    actions.appendChild(closeBtn);
    foot.appendChild(note);
    foot.appendChild(actions);
    panel.appendChild(head);
    panel.appendChild(body);
    panel.appendChild(foot);
    overlay.appendChild(panel);
    host.appendChild(overlay);
    try { closeTop.focus(); } catch (_) { /* swallow */ }
    return true;
  }

  function showSummaryModal(summaryText, summaryInput, setStatus) {
    return showAiResultModal('Summary', summaryText, summaryInput, setStatus, {
      copyStatus: 'Summary copied',
      failPrefix: 'Summary failed',
      truncatedNote: 'Transcript truncated for summary',
    });
  }

  function showExtractTasksModal(taskText, transcriptInput, setStatus) {
    return showAiResultModal('Extracted Tasks', taskText, transcriptInput, setStatus, {
      copyStatus: 'Tasks copied',
      failPrefix: 'Task extraction failed',
      truncatedNote: 'Transcript truncated for task extraction',
    });
  }

  function showStudyNotesModal(notesText, transcriptInput, setStatus) {
    return showAiResultModal('Study Notes', notesText, transcriptInput, setStatus, {
      copyStatus: 'Study notes copied',
      failPrefix: 'Study notes failed',
      truncatedNote: 'Transcript truncated for study notes',
    });
  }

  function showGenerateTagsModal(tagsText, transcriptInput, setStatus) {
    return showAiResultModal('Suggested Tags', tagsText, transcriptInput, setStatus, {
      copyStatus: 'Tags copied',
      failPrefix: 'Tag generation failed',
      truncatedNote: 'Transcript truncated for tag generation',
    });
  }

  function showRewriteModal(rewriteText, selectionInput, setStatus) {
    return showAiResultModal('Rewritten Text', rewriteText, selectionInput, setStatus, {
      copyStatus: 'Rewrite copied',
      failPrefix: 'Rewrite failed',
      truncatedNote: 'Selected text truncated for rewrite',
    });
  }

  function aiTranscriptActionIsEnabled(ctx) {
    if (!ctx || ctx.chatType !== 'saved') return false;
    const bridge = getRibbonBridge();
    if (!bridge || typeof bridge.getCleanTranscript !== 'function') return false;
    const inference = getInference();
    if (!inference || typeof inference.run !== 'function') return false;
    const status = getInferenceStatus();
    return status.available === true;
  }

  function aiTranscriptDisabledTooltip(ctx) {
    if (!ctx || ctx.chatType !== 'saved') return 'AI provider unavailable';
    const bridge = getRibbonBridge();
    if (!bridge || typeof bridge.getCleanTranscript !== 'function') return 'Transcript bridge unavailable';
    const inference = getInference();
    if (!inference || typeof inference.run !== 'function') return 'AI provider unavailable';
    const status = getInferenceStatus();
    return status.available ? '' : (status.message || 'AI provider unavailable');
  }

  function summarizeIsEnabled(ctx) {
    return aiTranscriptActionIsEnabled(ctx);
  }

  function summarizeDisabledTooltip(ctx) {
    return aiTranscriptDisabledTooltip(ctx);
  }

  function rewriteSelectionIsEnabled(ctx) {
    if (!ctx || ctx.chatType !== 'saved') return false;
    if (!Number.isFinite(Number(ctx.selectedTurnIdx)) || Number(ctx.selectedTurnIdx) <= 0) return false;
    const inference = getInference();
    if (!inference || typeof inference.run !== 'function') return false;
    const status = getInferenceStatus();
    return status.available === true;
  }

  function rewriteSelectionDisabledTooltip(ctx) {
    if (!ctx || ctx.chatType !== 'saved') return 'Select a message to rewrite';
    if (!Number.isFinite(Number(ctx.selectedTurnIdx)) || Number(ctx.selectedTurnIdx) <= 0) return 'Select a message to rewrite';
    const inference = getInference();
    if (!inference || typeof inference.run !== 'function') return 'AI provider unavailable';
    const status = getInferenceStatus();
    return status.available ? '' : (status.message || 'AI provider unavailable');
  }

  function libraryContextIsEnabled(ctx) {
    return !!(ctx && ctx.chatType === 'library');
  }

  function navigateLibrary(view, label) {
    return {
      isEnabled: libraryContextIsEnabled,
      onClick: function (_ctx, setStatus) {
        const target = '#/library/' + String(view || 'dashboard');
        try { global.location.hash = target; } catch (_) { /* ignore */ }
        setStatus(label || 'Library');
      },
    };
  }

  /* ── Phase 1b — wired action handlers ────────────────────────────────
   * Map of actionId -> { isEnabled(ctx), onClick(ctx, setStatus) }.
   * Actions NOT present in this map render disabled with "Coming soon"
   * tooltip (the Phase 1a default). All handlers are no-mutation: they
   * only read ribbon context + call H2O.Studio.platform.* APIs.
   *
   * Enabled rules:
   *   - copy-title:         ctx.title is a non-empty string.
   *   - open-original:      ctx.chatType === 'indexed' AND ctx.originalUrl non-empty.
   *   - copy-clean-transcript: ctx.chatType === 'saved' AND the bridge
   *                         is installed AND getCleanTranscript() returns
   *                         non-empty text.
   */
  const ACTION_HANDLERS = {
    'library-dashboard': navigateLibrary('dashboard', 'Dashboard'),
    'library-explorer':  navigateLibrary('explorer',  'Explorer'),
    'library-recents':   navigateLibrary('recents',   'Recents'),
    'library-saved':     navigateLibrary('saved',     'Saved'),
    'library-link':      navigateLibrary('linked',    'Link'),
    'library-organize':  navigateLibrary('organize',  'Organize'),
    'library-refresh-index': {
      isEnabled: libraryContextIsEnabled,
      onClick: function (_ctx, setStatus) {
        const btn = document.querySelector('.wbLibraryPageRefreshBtn');
        if (btn && typeof btn.click === 'function') {
          btn.click();
          setStatus('Refreshing Library');
          return;
        }
        setStatus('Refresh unavailable');
      },
    },
    'copy-title': {
      isEnabled: function (ctx) { return !!(ctx && ctx.title && String(ctx.title).trim()); },
      onClick: function (ctx, setStatus) {
        const text = String((ctx && ctx.title) || '').trim();
        if (!text) { setStatus('No title available'); return; }
        const platform = getPlatform();
        const clip = platform && platform.clipboard;
        if (!clip || typeof clip.writeText !== 'function') {
          setStatus('Clipboard unavailable');
          return;
        }
        setStatus('Copying title…');
        Promise.resolve(clip.writeText(text)).then(
          function () { setStatus('Title copied'); },
          function (err) {
            const msg = (err && (err.message || String(err))) || 'unknown error';
            setStatus('Copy failed: ' + msg);
          }
        );
      },
    },
    'open-original': {
      isEnabled: function (ctx) {
        if (!ctx) return false;
        if (ctx.chatType !== 'indexed') return false;
        return !!(ctx.originalUrl && String(ctx.originalUrl).trim());
      },
      onClick: function (ctx, setStatus) {
        const href = String((ctx && ctx.originalUrl) || '').trim();
        if (!href) { setStatus('No source URL'); return; }
        const runtime = H2O && H2O.Studio && H2O.Studio.platform && H2O.Studio.platform.runtime;
        setStatus('Opening original…');
        if (runtime && typeof runtime.openUrl === 'function') {
          Promise.resolve(runtime.openUrl(href)).then(
            function () { setStatus(''); },
            function (err) {
              const msg = (err && (err.message || String(err))) || 'unknown error';
              setStatus('Open failed: ' + msg);
            }
          );
          return;
        }
        setStatus('Open failed: runtime unavailable');
      },
    },
    /* Phase 2e — overlay-aware copy.
     * bridge.getCleanTranscript() returns Promise<{ text, overlayIncluded,
     * overlaySkipped, reason? }>. The handler awaits, writes
     * result.text to the clipboard, and surfaces an "overlay skipped"
     * status when the bridge fell back to raw due to drift. The
     * enable rule no longer peeks at the transcript content (the
     * bridge is now async); empty-snapshot still reports
     * "No transcript content" at click time. */
    'copy-clean-transcript': {
      isEnabled: function (ctx) {
        if (!ctx || ctx.chatType !== 'saved') return false;
        const bridge = getRibbonBridge();
        if (!bridge || typeof bridge.getCleanTranscript !== 'function') return false;
        return true;
      },
      onClick: function (ctx, setStatus) {
        const bridge = getRibbonBridge();
        if (!bridge || typeof bridge.getCleanTranscript !== 'function') {
          setStatus('Transcript bridge unavailable');
          return;
        }
        const platform = getPlatform();
        const clip = platform && platform.clipboard;
        if (!clip || typeof clip.writeText !== 'function') {
          setStatus('Clipboard unavailable');
          return;
        }
        setStatus('Copying transcript…');
        Promise.resolve(bridge.getCleanTranscript()).then(
          function (result) {
            const safe = (result && typeof result === 'object') ? result : { text: '', overlayIncluded: false, overlaySkipped: false };
            const text = String(safe.text || '');
            if (!text.trim()) { setStatus('No transcript content'); return; }
            const overlaySkipped = !!safe.overlaySkipped;
            const reason = String(safe.reason || '');
            Promise.resolve(clip.writeText(text)).then(
              function () {
                if (overlaySkipped && reason === 'drift-detected') {
                  setStatus('Transcript copied (overlay skipped — snapshot changed)');
                } else {
                  setStatus('Transcript copied');
                }
              },
              function (err) {
                const msg = (err && (err.message || String(err))) || 'unknown error';
                setStatus('Copy failed: ' + msg);
              }
            );
          },
          function (err) {
            const msg = (err && (err.message || String(err))) || 'unknown error';
            setStatus('Copy failed: ' + msg);
          }
        );
      },
    },
    /* Phase 3a — Export → Markdown.
     * Async export of the current overlay-aware saved chat as a `.md`
     * file via H2O.Studio.RibbonBridge.exportMarkdown(). The bridge
     * composes header block + Phase 2e serializer output, picks a
     * filesystem-safe filename, and routes through
     * H2O.Studio.platform.files.exportBlob (MV3 → Blob+<a download>;
     * Tauri → native dialog/fs, falling back to Blob+<a download> when
     * the dialog/fs plugins aren't allow-listed).
     *
     * Enable rule: saved-reader only + bridge installed.
     *
     * Status strings:
     *   "Preparing Markdown…"                            — pending
     *   "Markdown saved: <filename>"                     — overlay applied OR raw (no drift)
     *   "Markdown saved (overlay skipped — snapshot changed)"
     *                                                     — drift fallback
     *   "Export cancelled"                               — user dismissed Tauri save dialog
     *   "No transcript content"                          — empty snapshot
     *   "Export bridge unavailable"                      — bridge method missing
     *   "Export failed: <reason>"                        — anything else */
    'export-markdown': {
      isEnabled: function (ctx) {
        if (!ctx || ctx.chatType !== 'saved') return false;
        const bridge = getRibbonBridge();
        if (!bridge || typeof bridge.exportMarkdown !== 'function') return false;
        return true;
      },
      onClick: function (ctx, setStatus) {
        const bridge = getRibbonBridge();
        if (!bridge || typeof bridge.exportMarkdown !== 'function') {
          setStatus('Export bridge unavailable');
          return;
        }
        setStatus('Preparing Markdown…');
        Promise.resolve(bridge.exportMarkdown()).then(
          function (result) {
            const safe = (result && typeof result === 'object') ? result : { ok: false, reason: 'unknown' };
            if (safe.ok === true) {
              const filename = String(safe.filename || 'Markdown');
              if (safe.overlaySkipped && safe.overlayReason === 'drift-detected') {
                setStatus('Markdown saved (overlay skipped — snapshot changed)');
              } else {
                setStatus('Markdown saved: ' + filename);
              }
              return;
            }
            const reason = String(safe.reason || 'unknown');
            if (reason === 'cancelled') { setStatus('Export cancelled'); return; }
            if (reason === 'no-snapshot') { setStatus('No saved chat open'); return; }
            if (reason === 'no-content') { setStatus('No transcript content'); return; }
            const errSuffix = safe.error ? ': ' + String(safe.error) : '';
            setStatus('Export failed: ' + reason + errSuffix);
          },
          function (err) {
            const msg = (err && (err.message || String(err))) || 'unknown error';
            setStatus('Export failed: ' + msg);
          }
        );
      },
    },
    /* Phase 3b — Export → Download → PDF AND Export → Print → Print view.
     * Both actions invoke the SAME bridge method
     * (H2O.Studio.RibbonBridge.openPrintView) which:
     *   1. Injects a temporary <header data-print-header> with title +
     *      captured date + optional source + chat ID before .cgFrame.
     *   2. Swaps document.title for the duration of the print dialog
     *      so the browser's "Save as PDF" destination defaults to a
     *      useful filename.
     *   3. Calls window.print(); browser print dialog opens.
     *   4. Unwinds in try/finally — removes header, restores title.
     *
     * The two ribbon entries differ only in status strings:
     *   - export-pdf  promotes "Save as PDF" in the success status
     *   - print-view  is neutral (user picks destination)
     *
     * Cancellation limitation: window.print() returns no signal that
     * the user dismissed the dialog vs saved a PDF. ok:true means
     * "dialog opened"; status text is honest about it. Same constraint
     * Notion / GitHub / Google Docs all have. */

    /* Shared isEnabled rule for both Print-family actions. */
    /* (Inlined into both handlers below to mirror the format/structure
     * pattern used elsewhere in this file — no shared helper to keep
     * the dependency graph local.) */

    'export-pdf': {
      isEnabled: function (ctx) {
        if (!ctx || ctx.chatType !== 'saved') return false;
        const bridge = getRibbonBridge();
        if (!bridge || typeof bridge.openPrintView !== 'function') return false;
        return true;
      },
      onClick: function (ctx, setStatus) {
        const bridge = getRibbonBridge();
        if (!bridge || typeof bridge.openPrintView !== 'function') {
          setStatus('Print bridge unavailable');
          return;
        }
        setStatus('Opening print dialog…');
        Promise.resolve(bridge.openPrintView()).then(
          function (result) {
            const safe = (result && typeof result === 'object') ? result : { ok: false, reason: 'unknown' };
            if (safe.ok === true) {
              if (safe.overlaySkipped && safe.overlayReason === 'drift-detected') {
                setStatus('Print dialog opened (overlay disabled — snapshot changed)');
              } else {
                setStatus('Print dialog opened — choose Save as PDF');
              }
              return;
            }
            const reason = String(safe.reason || 'unknown');
            if (reason === 'no-snapshot')           { setStatus('No saved chat open'); return; }
            if (reason === 'reader-unavailable')    { setStatus('Reader not mounted'); return; }
            if (reason === 'print-unavailable')     { setStatus('Print unavailable in this environment'); return; }
            if (reason === 'print-in-progress')     { setStatus('Print already in progress'); return; }
            const errSuffix = safe.error ? ': ' + String(safe.error) : '';
            setStatus('Print failed: ' + reason + errSuffix);
          },
          function (err) {
            const msg = (err && (err.message || String(err))) || 'unknown error';
            setStatus('Print failed: ' + msg);
          }
        );
      },
    },

    'print-view': {
      isEnabled: function (ctx) {
        if (!ctx || ctx.chatType !== 'saved') return false;
        const bridge = getRibbonBridge();
        if (!bridge || typeof bridge.openPrintView !== 'function') return false;
        return true;
      },
      onClick: function (ctx, setStatus) {
        const bridge = getRibbonBridge();
        if (!bridge || typeof bridge.openPrintView !== 'function') {
          setStatus('Print bridge unavailable');
          return;
        }
        setStatus('Opening print dialog…');
        Promise.resolve(bridge.openPrintView()).then(
          function (result) {
            const safe = (result && typeof result === 'object') ? result : { ok: false, reason: 'unknown' };
            if (safe.ok === true) {
              if (safe.overlaySkipped && safe.overlayReason === 'drift-detected') {
                setStatus('Print dialog opened (overlay disabled — snapshot changed)');
              } else {
                setStatus('Print dialog opened');
              }
              return;
            }
            const reason = String(safe.reason || 'unknown');
            if (reason === 'no-snapshot')           { setStatus('No saved chat open'); return; }
            if (reason === 'reader-unavailable')    { setStatus('Reader not mounted'); return; }
            if (reason === 'print-unavailable')     { setStatus('Print unavailable in this environment'); return; }
            if (reason === 'print-in-progress')     { setStatus('Print already in progress'); return; }
            const errSuffix = safe.error ? ': ' + String(safe.error) : '';
            setStatus('Print failed: ' + reason + errSuffix);
          },
          function (err) {
            const msg = (err && (err.message || String(err))) || 'unknown error';
            setStatus('Print failed: ' + msg);
          }
        );
      },
    },

    /* Phase 3c-B — Export → Download → DOCX.
     * Async export of the current overlay-aware saved chat as a `.docx`
     * file via H2O.Studio.RibbonBridge.exportDocx(). The bridge composes
     * the Phase 3c-A pure DOCX writer (H2O.Studio.overlayDocxWriter)
     * output with the Phase 3a platform.files.exportBlob save path.
     *
     * Tauri binary safety: the Phase 3c-B platform.tauri.js update
     * detects non-text MIMEs and routes through plugin:fs|write_file
     * (binary). If write_file isn't allow-listed in capabilities,
     * the existing fallback chain catches the rejection and uses the
     * Chromium-style Blob+<a download> path. No new Tauri capability
     * was added — the bridge degrades gracefully.
     *
     * Enable rule: saved-reader only + bridge installed.
     *
     * Status strings:
     *   "Preparing DOCX…"                                — pending
     *   "DOCX saved: <filename>"                         — overlay applied OR raw (no drift)
     *   "DOCX saved (overlay skipped — snapshot changed)"
     *                                                     — drift fallback
     *   "Export cancelled"                               — user dismissed Tauri save dialog
     *   "No transcript content"                          — empty snapshot
     *   "No saved chat open"                             — bridge couldn't find snap
     *   "DOCX writer unavailable"                        — overlayDocxWriter missing or selfCheck not ok
     *   "Export bridge unavailable"                      — bridge method missing
     *   "Export failed: <reason>"                        — anything else */
    'export-docx': {
      isEnabled: function (ctx) {
        if (!ctx || ctx.chatType !== 'saved') return false;
        const bridge = getRibbonBridge();
        if (!bridge || typeof bridge.exportDocx !== 'function') return false;
        return true;
      },
      onClick: function (ctx, setStatus) {
        const bridge = getRibbonBridge();
        if (!bridge || typeof bridge.exportDocx !== 'function') {
          setStatus('Export bridge unavailable');
          return;
        }
        setStatus('Preparing DOCX…');
        Promise.resolve(bridge.exportDocx()).then(
          function (result) {
            const safe = (result && typeof result === 'object') ? result : { ok: false, reason: 'unknown' };
            if (safe.ok === true) {
              const filename = String(safe.filename || 'DOCX');
              if (safe.overlaySkipped && safe.overlayReason === 'drift-detected') {
                setStatus('DOCX saved (overlay skipped — snapshot changed)');
              } else {
                setStatus('DOCX saved: ' + filename);
              }
              return;
            }
            const reason = String(safe.reason || 'unknown');
            if (reason === 'cancelled') { setStatus('Export cancelled'); return; }
            if (reason === 'no-snapshot') { setStatus('No saved chat open'); return; }
            if (reason === 'no-content') { setStatus('No transcript content'); return; }
            if (reason === 'writer-unavailable') { setStatus('DOCX writer unavailable'); return; }
            const errSuffix = safe.error ? ': ' + String(safe.error) : '';
            setStatus('Export failed: ' + reason + errSuffix);
          },
          function (err) {
            const msg = (err && (err.message || String(err))) || 'unknown error';
            setStatus('Export failed: ' + msg);
          }
        );
      },
    },

    /* Metadata → Category.
     * Opens a compact ribbon popover and mounts the canonical
     * #categoryAssignWrap node inside it. The existing delegated handlers
     * on that node continue to own persistence and reclassify/restore. */
    'category': {
      isEnabled: function (ctx) {
        if (!ctx || ctx.chatType !== 'saved') return false;
        return metadataControlIsAvailable('category');
      },
      disabledTooltip: function () { return 'Category unavailable'; },
      onClick: function (ctx, setStatus, trigger) {
        toggleMetadataPopover('category', trigger, setStatus);
      },
    },
    'folder': {
      isEnabled: function (ctx) {
        if (!ctx || ctx.chatType !== 'saved') return false;
        return metadataControlIsAvailable('folder');
      },
      disabledTooltip: function () { return 'Folder unavailable'; },
      onClick: function (ctx, setStatus, trigger) {
        toggleMetadataPopover('folder', trigger, setStatus);
      },
    },
    /* Phase 1c — Metadata → Source link.
     * Copies the source URL of an indexed (linked) chat to the clipboard.
     * Uses Phase 1b's H2O.Studio.platform.clipboard.writeText contract.
     * Saved chats have no source URL field — disabled there. */
    'source-link': {
      isEnabled: function (ctx) {
        if (!ctx) return false;
        if (ctx.chatType !== 'indexed') return false;
        return !!(ctx.originalUrl && String(ctx.originalUrl).trim());
      },
      onClick: function (ctx, setStatus) {
        const href = String((ctx && ctx.originalUrl) || '').trim();
        if (!href) { setStatus('No source URL'); return; }
        const platform = getPlatform();
        const clip = platform && platform.clipboard;
        if (!clip || typeof clip.writeText !== 'function') {
          setStatus('Clipboard unavailable');
          return;
        }
        setStatus('Copying source URL…');
        Promise.resolve(clip.writeText(href)).then(
          function () { setStatus('Source URL copied'); },
          function (err) {
            const msg = (err && (err.message || String(err))) || 'unknown error';
            setStatus('Copy failed: ' + msg);
          }
        );
      },
    },
  };
  ACTION_HANDLERS['summarize'] = {
    isEnabled: summarizeIsEnabled,
    disabledTooltip: summarizeDisabledTooltip,
    onClick: function (ctx, setStatus) {
      const bridge = getRibbonBridge();
      if (!bridge || typeof bridge.getCleanTranscript !== 'function') {
        setStatus('Summary failed: transcript bridge unavailable');
        return;
      }
      const inference = getInference();
      const status = getInferenceStatus();
      if (!status.available || !inference || typeof inference.run !== 'function') {
        setStatus('AI provider unavailable');
        return;
      }

      removeSummaryModal();
      setStatus('Preparing summary...');
      Promise.resolve(bridge.getCleanTranscript({ includeOverlay: true })).then(
        function (transcriptResult) {
          const safe = (transcriptResult && typeof transcriptResult === 'object')
            ? transcriptResult
            : { text: '', overlayIncluded: false, overlaySkipped: false };
          const summaryInput = buildSummaryInput(safe.text, safe);
          if (!summaryInput.text.trim()) {
            setStatus('No transcript content');
            return;
          }
          const request = buildSummarizeRequest(ctx, summaryInput);
          aiSummaryActiveRequestId = request.requestId;
          setStatus('Summarizing...');
          Promise.resolve(inference.run(request)).then(
            function (result) {
              if (aiSummaryActiveRequestId !== request.requestId) return;
              if (result && typeof result === 'object' && result.ok === false) {
                removeSummaryModal();
                setStatus('Summary failed: ' + summaryFailureReason(result));
                return;
              }
              const summaryText = extractSummaryText(result);
              if (!summaryText) {
                removeSummaryModal();
                setStatus('Summary failed: empty-result');
                return;
              }
              try {
                if (showSummaryModal(summaryText, summaryInput, setStatus)) {
                  setStatus('Summary ready');
                }
              } catch (e) {
                removeSummaryModal();
                const msg = (e && (e.message || String(e))) || 'unknown error';
                setStatus('Summary failed: ' + msg);
              }
            },
            function (err) {
              if (aiSummaryActiveRequestId !== request.requestId) return;
              removeSummaryModal();
              const msg = (err && (err.message || String(err))) || 'unknown error';
              setStatus('Summary failed: ' + msg);
            }
          );
        },
        function (err) {
          removeSummaryModal();
          const msg = (err && (err.message || String(err))) || 'unknown error';
          setStatus('Summary failed: ' + msg);
        }
      );
    },
  };
  ACTION_HANDLERS['extract-tasks'] = {
    isEnabled: aiTranscriptActionIsEnabled,
    disabledTooltip: aiTranscriptDisabledTooltip,
    onClick: function (ctx, setStatus) {
      const bridge = getRibbonBridge();
      if (!bridge || typeof bridge.getCleanTranscript !== 'function') {
        setStatus('Task extraction failed: transcript bridge unavailable');
        return;
      }
      const inference = getInference();
      const status = getInferenceStatus();
      if (!status.available || !inference || typeof inference.run !== 'function') {
        setStatus('AI provider unavailable');
        return;
      }

      removeAiResultModal();
      setStatus('Preparing tasks...');
      Promise.resolve(bridge.getCleanTranscript({ includeOverlay: true })).then(
        function (transcriptResult) {
          const safe = (transcriptResult && typeof transcriptResult === 'object')
            ? transcriptResult
            : { text: '', overlayIncluded: false, overlaySkipped: false };
          const transcriptInput = buildAiTranscriptInput(safe.text, safe);
          if (!transcriptInput.text.trim()) {
            setStatus('No transcript content');
            return;
          }
          const request = buildExtractTasksRequest(ctx, transcriptInput);
          aiTaskActiveRequestId = request.requestId;
          setStatus('Extracting tasks...');
          Promise.resolve(inference.run(request)).then(
            function (result) {
              if (aiTaskActiveRequestId !== request.requestId) return;
              if (result && typeof result === 'object' && result.ok === false) {
                removeAiResultModal();
                setStatus('Task extraction failed: ' + aiFailureReason(result));
                return;
              }
              const taskText = extractAiResultText(result);
              if (!taskText) {
                removeAiResultModal();
                setStatus('Task extraction failed: empty-result');
                return;
              }
              try {
                if (showExtractTasksModal(taskText, transcriptInput, setStatus)) {
                  setStatus('Tasks ready');
                }
              } catch (e) {
                removeAiResultModal();
                const msg = (e && (e.message || String(e))) || 'unknown error';
                setStatus('Task extraction failed: ' + msg);
              }
            },
            function (err) {
              if (aiTaskActiveRequestId !== request.requestId) return;
              removeAiResultModal();
              const msg = (err && (err.message || String(err))) || 'unknown error';
              setStatus('Task extraction failed: ' + msg);
            }
          );
        },
        function (err) {
          removeAiResultModal();
          const msg = (err && (err.message || String(err))) || 'unknown error';
          setStatus('Task extraction failed: ' + msg);
        }
      );
    },
  };
  ACTION_HANDLERS['study-notes'] = {
    isEnabled: aiTranscriptActionIsEnabled,
    disabledTooltip: aiTranscriptDisabledTooltip,
    onClick: function (ctx, setStatus) {
      const bridge = getRibbonBridge();
      if (!bridge || typeof bridge.getCleanTranscript !== 'function') {
        setStatus('Study notes failed: transcript bridge unavailable');
        return;
      }
      const inference = getInference();
      const status = getInferenceStatus();
      if (!status.available || !inference || typeof inference.run !== 'function') {
        setStatus('AI provider unavailable');
        return;
      }

      removeAiResultModal();
      setStatus('Preparing study notes...');
      Promise.resolve(bridge.getCleanTranscript({ includeOverlay: true })).then(
        function (transcriptResult) {
          const safe = (transcriptResult && typeof transcriptResult === 'object')
            ? transcriptResult
            : { text: '', overlayIncluded: false, overlaySkipped: false };
          const transcriptInput = buildAiTranscriptInput(safe.text, safe);
          if (!transcriptInput.text.trim()) {
            setStatus('No transcript content');
            return;
          }
          const request = buildStudyNotesRequest(ctx, transcriptInput);
          aiStudyNotesActiveRequestId = request.requestId;
          setStatus('Creating study notes...');
          Promise.resolve(inference.run(request)).then(
            function (result) {
              if (aiStudyNotesActiveRequestId !== request.requestId) return;
              if (result && typeof result === 'object' && result.ok === false) {
                removeAiResultModal();
                setStatus('Study notes failed: ' + aiFailureReason(result));
                return;
              }
              const notesText = extractAiResultText(result);
              if (!notesText) {
                removeAiResultModal();
                setStatus('Study notes failed: empty-result');
                return;
              }
              try {
                if (showStudyNotesModal(notesText, transcriptInput, setStatus)) {
                  setStatus('Study notes ready');
                }
              } catch (e) {
                removeAiResultModal();
                const msg = (e && (e.message || String(e))) || 'unknown error';
                setStatus('Study notes failed: ' + msg);
              }
            },
            function (err) {
              if (aiStudyNotesActiveRequestId !== request.requestId) return;
              removeAiResultModal();
              const msg = (err && (err.message || String(err))) || 'unknown error';
              setStatus('Study notes failed: ' + msg);
            }
          );
        },
        function (err) {
          removeAiResultModal();
          const msg = (err && (err.message || String(err))) || 'unknown error';
          setStatus('Study notes failed: ' + msg);
        }
      );
    },
  };
  ACTION_HANDLERS['generate-tags'] = {
    isEnabled: aiTranscriptActionIsEnabled,
    disabledTooltip: aiTranscriptDisabledTooltip,
    onClick: function (ctx, setStatus) {
      const bridge = getRibbonBridge();
      if (!bridge || typeof bridge.getCleanTranscript !== 'function') {
        setStatus('Tag generation failed: transcript bridge unavailable');
        return;
      }
      const inference = getInference();
      const status = getInferenceStatus();
      if (!status.available || !inference || typeof inference.run !== 'function') {
        setStatus('AI provider unavailable');
        return;
      }

      removeAiResultModal();
      setStatus('Preparing tags...');
      Promise.resolve(bridge.getCleanTranscript({ includeOverlay: true })).then(
        function (transcriptResult) {
          const safe = (transcriptResult && typeof transcriptResult === 'object')
            ? transcriptResult
            : { text: '', overlayIncluded: false, overlaySkipped: false };
          const transcriptInput = buildAiTranscriptInput(safe.text, safe);
          if (!transcriptInput.text.trim()) {
            setStatus('No transcript content');
            return;
          }
          const request = buildGenerateTagsRequest(ctx, transcriptInput);
          aiTagsActiveRequestId = request.requestId;
          setStatus('Generating tags...');
          Promise.resolve(inference.run(request)).then(
            function (result) {
              if (aiTagsActiveRequestId !== request.requestId) return;
              if (result && typeof result === 'object' && result.ok === false) {
                removeAiResultModal();
                setStatus('Tag generation failed: ' + aiFailureReason(result));
                return;
              }
              const tagsText = extractAiResultText(result);
              if (!tagsText) {
                removeAiResultModal();
                setStatus('Tag generation failed: empty-result');
                return;
              }
              try {
                if (showGenerateTagsModal(tagsText, transcriptInput, setStatus)) {
                  setStatus('Tags ready');
                }
              } catch (e) {
                removeAiResultModal();
                const msg = (e && (e.message || String(e))) || 'unknown error';
                setStatus('Tag generation failed: ' + msg);
              }
            },
            function (err) {
              if (aiTagsActiveRequestId !== request.requestId) return;
              removeAiResultModal();
              const msg = (err && (err.message || String(err))) || 'unknown error';
              setStatus('Tag generation failed: ' + msg);
            }
          );
        },
        function (err) {
          removeAiResultModal();
          const msg = (err && (err.message || String(err))) || 'unknown error';
          setStatus('Tag generation failed: ' + msg);
        }
      );
    },
  };
  ACTION_HANDLERS['rewrite-selection'] = {
    isEnabled: rewriteSelectionIsEnabled,
    disabledTooltip: rewriteSelectionDisabledTooltip,
    onClick: function (ctx, setStatus) {
      if (!ctx || ctx.chatType !== 'saved' || !Number.isFinite(Number(ctx.selectedTurnIdx)) || Number(ctx.selectedTurnIdx) <= 0) {
        setStatus('Select a message to rewrite');
        return;
      }
      const inference = getInference();
      const status = getInferenceStatus();
      if (!status.available || !inference || typeof inference.run !== 'function') {
        setStatus('AI provider unavailable');
        return;
      }

      removeAiResultModal();
      setStatus('Preparing rewrite...');
      const selectionInput = buildRewriteSelectionInput(ctx);
      if (!selectionInput.ok) {
        if (selectionInput.reason === 'empty-selection') setStatus('No selected text');
        else setStatus('Select a message to rewrite');
        return;
      }
      const request = buildRewriteSelectionRequest(ctx, selectionInput);
      aiRewriteActiveRequestId = request.requestId;
      setStatus('Rewriting selected text...');
      Promise.resolve(inference.run(request)).then(
        function (result) {
          if (aiRewriteActiveRequestId !== request.requestId) return;
          if (result && typeof result === 'object' && result.ok === false) {
            removeAiResultModal();
            setStatus('Rewrite failed: ' + aiFailureReason(result));
            return;
          }
          const rewriteText = extractAiResultText(result);
          if (!rewriteText) {
            removeAiResultModal();
            setStatus('Rewrite failed: empty-result');
            return;
          }
          try {
            if (showRewriteModal(rewriteText, selectionInput, setStatus)) {
              setStatus('Rewrite ready');
            }
          } catch (e) {
            removeAiResultModal();
            const msg = (e && (e.message || String(e))) || 'unknown error';
            setStatus('Rewrite failed: ' + msg);
          }
        },
        function (err) {
          if (aiRewriteActiveRequestId !== request.requestId) return;
          removeAiResultModal();
          const msg = (err && (err.message || String(err))) || 'unknown error';
          setStatus('Rewrite failed: ' + msg);
        }
      );
    },
  };

  /* ── Phase 2b — message-level format actions ───────────────────────────
   * Seven actions wired against the edit-overlay subsystem:
   *   h1 / h2 / h3 — set/toggle/switch heading level on the selected message
   *   quote / code / callout — toggle the wrapper
   *   clean-spacing — toggle clean-spacing flag (CSS-driven normalisation)
   *
   * Enabled ONLY when:
   *   - ctx.chatType === 'saved'
   *   - a saved reader is mounted (signalled by snapshotId + selectedTurnIdx)
   *   - editOverlay store + overlay applier are both installed
   *
   * All handlers go through H2O.Studio.RibbonBridge.applyOverlayOp, which
   * checks drift, appends an op via the pure helper, upserts to the
   * store, and re-applies the overlay to the live reader DOM. Toggle
   * semantics are decided here at click time based on the current
   * computed message state (via RibbonBridge.getMessageStateForTurn). */

  function formatActionsIsEnabled(ctx) {
    if (!ctx || ctx.chatType !== 'saved') return false;
    if (!ctx.snapshotId) return false;
    if (!Number.isFinite(Number(ctx.selectedTurnIdx)) || Number(ctx.selectedTurnIdx) <= 0) return false;
    const bridge = getRibbonBridge();
    if (!bridge || typeof bridge.applyOverlayOp !== 'function') return false;
    const store = H2O && H2O.Studio && H2O.Studio.store && H2O.Studio.store.editOverlay;
    if (!store || typeof store.upsert !== 'function') return false;
    return true;
  }

  /* Helper to run an op spec via the bridge and route status feedback. */
  function runOverlayOp(opSpec, setStatus, statusLabels) {
    const bridge = getRibbonBridge();
    if (!bridge || typeof bridge.applyOverlayOp !== 'function') {
      setStatus('Overlay bridge unavailable');
      return;
    }
    setStatus(statusLabels.pending || 'Applying…');
    Promise.resolve(bridge.applyOverlayOp(opSpec)).then(
      function (result) {
        if (result && result.ok) {
          setStatus(statusLabels.success || 'Applied');
        } else {
          const reason = (result && result.reason) || 'unknown';
          if (reason === 'drift-detected') {
            setStatus('Snapshot has changed — overlay disabled until rebase');
          } else if (reason === 'no-snapshot') {
            setStatus('No saved chat open');
          } else {
            setStatus((statusLabels.fail || 'Failed') + ': ' + reason);
          }
        }
      },
      function (err) {
        const msg = (err && (err.message || String(err))) || 'unknown error';
        setStatus((statusLabels.fail || 'Failed') + ': ' + msg);
      }
    );
  }

  /* Look up current state synchronously by reading from the bridge.
   * The bridge returns a Promise; for toggle behaviour we need a
   * synchronous answer. Strategy: fire applyOverlayOp directly with a
   * `setLevel:N` op for headings (the reducer in the applier handles
   * the toggle/switch semantics — last op wins per message per type).
   * For quote/code/callout/clean-spacing, we pre-read via the bridge
   * helper (async) and decide the payload from current state. */
  function buildHeadingHandler(level) {
    return {
      isEnabled: formatActionsIsEnabled,
      onClick: function (ctx, setStatus) {
        const turnIdx = Number(ctx && ctx.selectedTurnIdx);
        if (!Number.isFinite(turnIdx) || turnIdx <= 0) { setStatus('Select a message first'); return; }
        /* Pre-read current state so we can toggle off when clicking the
         * same level twice; switch level when clicking a different level. */
        const bridge = getRibbonBridge();
        const readP = (bridge && typeof bridge.getMessageStateForTurn === 'function')
          ? Promise.resolve(bridge.getMessageStateForTurn(turnIdx))
          : Promise.resolve({ heading: null });
        readP.then(function (cur) {
          const curLevel = (cur && cur.heading && cur.heading.level) || null;
          const nextLevel = (curLevel === level) ? null : level;
          const opSpec = {
            type: 'heading',
            target: { kind: 'message', turnIdx: turnIdx, messageId: ctx.selectedMessageId || null },
            payload: { level: nextLevel },
            inverse: { level: curLevel },
          };
          runOverlayOp(opSpec, setStatus, {
            pending: nextLevel ? ('Applying H' + nextLevel + '…') : 'Removing heading…',
            success: nextLevel ? ('H' + nextLevel + ' applied') : 'Heading removed',
            fail: 'Heading failed',
          });
        }, function () { setStatus('Heading failed: state read'); });
      },
    };
  }

  function buildToggleHandler(kind, opType, payloadOn, labels) {
    return {
      isEnabled: formatActionsIsEnabled,
      onClick: function (ctx, setStatus) {
        const turnIdx = Number(ctx && ctx.selectedTurnIdx);
        if (!Number.isFinite(turnIdx) || turnIdx <= 0) { setStatus('Select a message first'); return; }
        const bridge = getRibbonBridge();
        const readP = (bridge && typeof bridge.getMessageStateForTurn === 'function')
          ? Promise.resolve(bridge.getMessageStateForTurn(turnIdx))
          : Promise.resolve({});
        readP.then(function (cur) {
          let isOn = false;
          if (kind === 'quote') isOn = !!(cur && cur.quote);
          else if (kind === 'code') isOn = !!(cur && cur.code);
          else if (kind === 'callout') isOn = !!(cur && cur.callout);
          else if (kind === 'clean-spacing') isOn = !!(cur && cur.cleanSpacing);
          /* Phase 4-1 — character formatting kinds. */
          else if (kind === 'bold') isOn = !!(cur && cur.bold);
          else if (kind === 'italic') isOn = !!(cur && cur.italic);
          else if (kind === 'underline') isOn = !!(cur && cur.underline);
          else if (kind === 'strikethrough') isOn = !!(cur && cur.strikethrough);
          /* Payload: toggle on/off */
          let nextPayload;
          if (kind === 'callout') {
            nextPayload = isOn ? { kind: null } : { kind: 'info' };
          } else {
            nextPayload = isOn ? { enabled: false } : payloadOn;
          }
          const opSpec = {
            type: opType,
            target: { kind: 'message', turnIdx: turnIdx, messageId: ctx.selectedMessageId || null },
            payload: nextPayload,
          };
          runOverlayOp(opSpec, setStatus, {
            pending: isOn ? labels.removingLabel : labels.applyingLabel,
            success: isOn ? labels.removedLabel : labels.appliedLabel,
            fail: labels.failLabel,
          });
        }, function () { setStatus(labels.failLabel + ': state read'); });
      },
    };
  }

  ACTION_HANDLERS['h1'] = buildHeadingHandler(1);
  ACTION_HANDLERS['h2'] = buildHeadingHandler(2);
  ACTION_HANDLERS['h3'] = buildHeadingHandler(3);
  ACTION_HANDLERS['quote'] = buildToggleHandler('quote', 'quote', { enabled: true }, {
    applyingLabel: 'Applying quote…', removingLabel: 'Removing quote…',
    appliedLabel: 'Quote applied', removedLabel: 'Quote removed',
    failLabel: 'Quote failed',
  });
  ACTION_HANDLERS['code'] = buildToggleHandler('code', 'code', { enabled: true }, {
    applyingLabel: 'Applying code block…', removingLabel: 'Removing code block…',
    appliedLabel: 'Code block applied', removedLabel: 'Code block removed',
    failLabel: 'Code block failed',
  });
  ACTION_HANDLERS['callout'] = buildToggleHandler('callout', 'callout', { kind: 'info' }, {
    applyingLabel: 'Applying callout…', removingLabel: 'Removing callout…',
    appliedLabel: 'Callout applied', removedLabel: 'Callout removed',
    failLabel: 'Callout failed',
  });
  ACTION_HANDLERS['clean-spacing'] = buildToggleHandler('clean-spacing', 'clean-spacing', { enabled: true }, {
    applyingLabel: 'Cleaning spacing…', removingLabel: 'Restoring spacing…',
    appliedLabel: 'Spacing cleaned', removedLabel: 'Spacing restored',
    failLabel: 'Clean spacing failed',
  });

  /* ── Phase 4-1 — Format → Font group handlers ──────────────────────────
   * Four toggles (B / I / U / S) reuse the buildToggleHandler pattern
   * established for quote / code / clean-spacing. Each operates on the
   * entire selected message body; the role label stays in its normal
   * style (matching the DOCX writer's separation of role-label rPr
   * from body-rPr). Clear formatting is NOT a toggle — clicking it
   * always submits a `clear-formatting` op which the reducer treats as
   * a reset marker, wiping all per-message decorations for the turn at
   * that point in op order. */
  /* ── Phase 5b-1 — inline-aware Bold / Italic ──────────────────────────
   * If the user has a valid held inline selection that belongs to the
   * currently-selected turn, the B / I buttons submit an `inline-format`
   * op over that range (toggle decided by current coverage). Otherwise
   * the existing Phase 4-1 message-level toggle behaviour is preserved
   * unchanged. Underline / Strikethrough stay message-level only in
   * 5b-1 (no inline U/S yet). */
  function buildFontHandler(kind, messageLabels) {
    const messageLevel = buildToggleHandler(kind, kind, { enabled: true }, messageLabels);
    const LABELS = { bold: 'Bold', italic: 'Italic', underline: 'Underline', strikethrough: 'Strikethrough' };
    const Label = LABELS[kind] || 'Bold';
    return {
      isEnabled: formatActionsIsEnabled,
      onClick: function (ctx, setStatus) {
        const turnIdx = Number(ctx && ctx.selectedTurnIdx);
        const held = getHeldInlineCapture();
        const pos = held && held.anchor && held.anchor.textPos;
        const inlineValid = !!(held && held.ok && held.anchor && pos
          && Number.isFinite(turnIdx) && turnIdx > 0
          && Number(held.selectedTurnIdx) === turnIdx
          && Number.isFinite(Number(pos.start)) && Number.isFinite(Number(pos.end))
          && Number(pos.end) > Number(pos.start));

        if (!inlineValid) {
          /* No valid inline selection → message-level behaviour unchanged. */
          messageLevel.onClick(ctx, setStatus);
          return;
        }

        const start = Number(pos.start);
        const end = Number(pos.end);
        const bridge = getRibbonBridge();
        const readP = (bridge && typeof bridge.getInlineStateForTurn === 'function')
          ? Promise.resolve(bridge.getInlineStateForTurn(turnIdx))
          : Promise.resolve({ bold: [], italic: [] });
        readP.then(function (inlineState) {
          const ov = getOverlayApi();
          const intervals = (inlineState && Array.isArray(inlineState[kind])) ? inlineState[kind] : [];
          let covered = false;
          if (ov && typeof ov.intervalsCover === 'function') {
            covered = ov.intervalsCover(intervals, start, end);
          }
          const enabled = !covered; /* toggle: covered → remove, else apply */
          const opSpec = {
            type: 'inline-format',
            target: {
              kind: 'inline',
              turnIdx: turnIdx,
              messageId: held.selectedMessageId || ctx.selectedMessageId || null,
              anchor: held.anchor,
            },
            payload: { style: kind, enabled: enabled },
            inverse: { style: kind, enabled: covered },
          };
          runOverlayOp(opSpec, setStatus, {
            pending: enabled ? ('Applying ' + Label.toLowerCase() + ' to selection…')
                             : ('Removing ' + Label.toLowerCase() + ' from selection…'),
            success: enabled ? (Label + ' applied to selection')
                             : (Label + ' removed from selection'),
            fail: Label + ' failed',
          });
        }, function () {
          /* Inline state read failed → fall back to message-level. */
          messageLevel.onClick(ctx, setStatus);
        });
      },
    };
  }
  ACTION_HANDLERS['bold'] = buildFontHandler('bold', {
    applyingLabel: 'Applying bold…', removingLabel: 'Removing bold…',
    appliedLabel: 'Bold applied', removedLabel: 'Bold removed',
    failLabel: 'Bold failed',
  });
  ACTION_HANDLERS['italic'] = buildFontHandler('italic', {
    applyingLabel: 'Applying italic…', removingLabel: 'Removing italic…',
    appliedLabel: 'Italic applied', removedLabel: 'Italic removed',
    failLabel: 'Italic failed',
  });
  /* Phase 5c-1 — Underline / Strikethrough become inline-aware exactly
   * like Bold / Italic: a valid held inline selection on the selected
   * turn submits an `inline-format` op over the range; otherwise the
   * existing Phase 4-1 message-level toggle behaviour is preserved. */
  ACTION_HANDLERS['underline'] = buildFontHandler('underline', {
    applyingLabel: 'Applying underline…', removingLabel: 'Removing underline…',
    appliedLabel: 'Underline applied', removedLabel: 'Underline removed',
    failLabel: 'Underline failed',
  });
  ACTION_HANDLERS['strikethrough'] = buildFontHandler('strikethrough', {
    applyingLabel: 'Applying strikethrough…', removingLabel: 'Removing strikethrough…',
    appliedLabel: 'Strikethrough applied', removedLabel: 'Strikethrough removed',
    failLabel: 'Strikethrough failed',
  });

  /* ── Phase 8e-1 — Subscript / Superscript (inline-only) ──────────────
   * Toggle the style over a held text selection via the existing
   * `inline-format` op (new styles 'subscript'/'superscript'; the reducer
   * enforces mutual exclusion). Unlike bold/italic there is NO message-
   * level fallback — whole-turn subscript is meaningless — so an invalid
   * selection just sets a status. `enabled` toggles off when the selection
   * is already fully covered (read via getInlineStateForTurn), so the
   * button reflects covered state through the toggle. */
  function buildSubSupHandler(style, label) {
    return {
      isEnabled: formatActionsIsEnabled,
      onClick: function (ctx, setStatus) {
        const turnIdx = Number(ctx && ctx.selectedTurnIdx);
        const held = getHeldInlineCapture();
        const pos = held && held.anchor && held.anchor.textPos;
        const inlineValid = !!(held && held.ok && held.anchor && pos
          && Number.isFinite(turnIdx) && turnIdx > 0
          && Number(held.selectedTurnIdx) === turnIdx
          && Number.isFinite(Number(pos.start)) && Number.isFinite(Number(pos.end))
          && Number(pos.end) > Number(pos.start));
        if (!inlineValid) { setStatus('Select text first'); return; }

        const start = Number(pos.start);
        const end = Number(pos.end);
        const bridge = getRibbonBridge();
        const readP = (bridge && typeof bridge.getInlineStateForTurn === 'function')
          ? Promise.resolve(bridge.getInlineStateForTurn(turnIdx))
          : Promise.resolve({});
        readP.then(function (inlineState) {
          const ov = getOverlayApi();
          const intervals = (inlineState && Array.isArray(inlineState[style])) ? inlineState[style] : [];
          let covered = false;
          if (ov && typeof ov.intervalsCover === 'function') {
            try { covered = ov.intervalsCover(intervals, start, end); } catch (_) { covered = false; }
          }
          const enabled = !covered; /* toggle: covered → remove, else apply */
          const opSpec = {
            type: 'inline-format',
            target: {
              kind: 'inline',
              turnIdx: turnIdx,
              messageId: held.selectedMessageId || ctx.selectedMessageId || null,
              anchor: held.anchor,
            },
            payload: { style: style, enabled: enabled },
            inverse: { style: style, enabled: covered },
          };
          runOverlayOp(opSpec, setStatus, {
            pending: enabled ? ('Applying ' + label.toLowerCase() + ' to selection…')
                             : ('Removing ' + label.toLowerCase() + ' from selection…'),
            success: enabled ? (label + ' applied to selection')
                             : (label + ' removed from selection'),
            fail: label + ' failed',
          });
        }, function () { setStatus(label + ' failed: state read'); });
      },
    };
  }
  ACTION_HANDLERS['subscript']   = buildSubSupHandler('subscript',   'Subscript');
  ACTION_HANDLERS['superscript'] = buildSubSupHandler('superscript', 'Superscript');

  /* Phase 8f-2b — Copy the selected message with RICH HTML + Markdown
   * fallback. Prefers a two-flavor ClipboardItem (text/html via getTurnHtml
   * + text/plain via getTurnClean Markdown) when the runtime supports
   * ClipboardItem + navigator.clipboard.write (browser); otherwise falls
   * back to the Phase 8f-1 platform.clipboard.writeText(Markdown) path,
   * which also covers Tauri WKWebView. Read-only: no readText, no overlay
   * op, no snapshot mutation. Saved chats only; never throws. */
  ACTION_HANDLERS['copy-message'] = {
    isEnabled: function (ctx) {
      if (!ctx || ctx.chatType !== 'saved') return false;
      const turnIdx = Number(ctx.selectedTurnIdx);
      if (!Number.isFinite(turnIdx) || turnIdx < 1) return false;
      const bridge = getRibbonBridge();
      if (!bridge || typeof bridge.getTurnClean !== 'function') return false;
      const platform = getPlatform();
      const clip = platform && platform.clipboard;
      if (!clip || typeof clip.writeText !== 'function') return false;
      return true;
    },
    onClick: function (ctx, setStatus) {
      const turnIdx = Number(ctx && ctx.selectedTurnIdx);
      if (!Number.isFinite(turnIdx) || turnIdx < 1) { setStatus('No message selected'); return; }
      const bridge = getRibbonBridge();
      if (!bridge || typeof bridge.getTurnClean !== 'function') { setStatus('Clipboard unavailable'); return; }
      const platform = getPlatform();
      const clip = platform && platform.clipboard;
      if (!clip || typeof clip.writeText !== 'function') { setStatus('Clipboard unavailable'); return; }
      setStatus('Copying…');

      /* Phase 8f-1 Markdown fallback (also the Tauri path): writeText only. */
      function writeMarkdown(markdown) {
        Promise.resolve(clip.writeText(markdown)).then(
          function () { setStatus('Copied as Markdown'); },
          function () { setStatus('Clipboard unavailable'); }
        );
      }

      Promise.resolve(bridge.getTurnClean(turnIdx, { includeOverlay: true })).then(
        function (mdResult) {
          const md = String((mdResult && typeof mdResult === 'object' ? mdResult.text : '') || '');
          if (!md.trim()) { setStatus('Nothing to copy'); return; }

          /* Rich clipboard requires the HTML bridge + global ClipboardItem +
           * navigator.clipboard.write. Absent on Tauri WKWebView → fall back. */
          const nav = (typeof window !== 'undefined') ? window.navigator : null;
          const richSupported = (typeof bridge.getTurnHtml === 'function')
            && (typeof window !== 'undefined')
            && (typeof window.ClipboardItem === 'function')
            && !!(nav && nav.clipboard && typeof nav.clipboard.write === 'function');
          if (!richSupported) { writeMarkdown(md); return; }

          Promise.resolve(bridge.getTurnHtml(turnIdx, { includeOverlay: true })).then(
            function (htmlResult) {
              const html = String((htmlResult && typeof htmlResult === 'object' ? htmlResult.html : '') || '');
              if (!html.trim()) { writeMarkdown(md); return; }
              let item = null;
              try {
                item = new window.ClipboardItem({
                  'text/html': new window.Blob([html], { type: 'text/html' }),
                  'text/plain': new window.Blob([md], { type: 'text/plain' }),
                });
              } catch (_) { writeMarkdown(md); return; }
              Promise.resolve(nav.clipboard.write([item])).then(
                function () { setStatus('Copied'); },
                function () { writeMarkdown(md); }   /* rich write rejected → Markdown */
              );
            },
            function () { writeMarkdown(md); }         /* getTurnHtml rejected → Markdown */
          );
        },
        function () { setStatus('Clipboard unavailable'); }
      );
    },
  };

  /* Phase 8g-1 / 8g-2a — Format Painter, single-use, mode auto-detected at
   * arm time:
   *   • MESSAGE-LEVEL (8g-1): click with NO held inline selection → capture the
   *     message's message-level formatting; the next target-message selection
   *     applies it (contextChanged subscriber), then disarms.
   *   • INLINE (8g-2a): click WITH a valid held inline selection on the selected
   *     turn → capture the inline STYLE SET (bold/…/textColor); a SECOND click
   *     applies it to the then-current held selection (target) via
   *     bridge.applyInlineFormatPaint — offsets are never transferred — then
   *     disarms. A held-selection-less second click on a message-armed painter
   *     cancels. Escape cancels. Never touches text / text-replace / highlights
   *     / content; inline replay uses existing inline-format ops only. Saved
   *     chats only. */
  ACTION_HANDLERS['format-painter'] = {
    isEnabled: function (ctx) {
      if (!ctx || ctx.chatType !== 'saved') return false;
      const turnIdx = Number(ctx.selectedTurnIdx);
      if (!Number.isFinite(turnIdx) || turnIdx < 1) return false;
      const bridge = getRibbonBridge();
      if (!bridge || typeof bridge.getMessageStateForTurn !== 'function' || typeof bridge.applyMessageFormatPaint !== 'function') return false;
      return true;
    },
    onClick: function (ctx, setStatus, actionBtn) {
      const bridge = getRibbonBridge();

      /* ── Armed: apply (inline) / lock (double-click) / cancel ──────────── */
      if (__formatPainterArmed) {
        const armed = __formatPainterArmed;
        /* A second click within the lock window promotes a one-shot arm to
         * sticky (Phase 8g-3a). Inline: only when there is no fresh target,
         * so a genuine apply-click is never hijacked. Message: always, since
         * a button click is never an apply in message mode. */
        const canPromote = !armed.sticky && (Date.now() - __formatPainterLastArmAt) <= FP_STICKY_DBLCLICK_MS;

        if (armed.mode === 'inline') {
          const held = getHeldInlineCapture();
          const hpos = held && held.anchor && held.anchor.textPos;
          const tTurn = held ? Number(held.selectedTurnIdx) : NaN;
          const tValid = !!(held && held.ok && hpos && Number.isFinite(tTurn) && tTurn > 0
            && Number.isFinite(Number(hpos.start)) && Number.isFinite(Number(hpos.end)) && Number(hpos.end) > Number(hpos.start));
          if (canPromote && !tValid) { armed.sticky = true; __formatPainterSetArmedUI(true); setStatus('Format Painter locked'); return; }
          if (!tValid) { setStatus('Select target text first'); return; } /* keep armed (incl. sticky) */
          if (!bridge || typeof bridge.applyInlineFormatPaint !== 'function') { __formatPainterDisarm(); setStatus('Format Painter unavailable'); return; }
          const targetAnchor = { textPos: { start: Number(hpos.start), end: Number(hpos.end) }, messageId: held.selectedMessageId || null };
          const wasSticky = !!armed.sticky, keepStyles = armed.styles, keepSrc = armed.sourceTurnIdx;
          setStatus('Applying inline formatting…');
          Promise.resolve(bridge.applyInlineFormatPaint(tTurn, targetAnchor, keepStyles)).then(
            function (r) {
              if (r && r.ok) {
                if (wasSticky) __formatPainterEngage({ mode: 'inline', styles: keepStyles, sourceTurnIdx: keepSrc, sticky: true }, setStatus, actionBtn, 'Inline formatting applied — select next target');
                else { __formatPainterDisarm(); setStatus('Inline formatting applied'); }
              } else { __formatPainterDisarm(); setStatus('Inline paint failed: ' + ((r && r.reason) || 'unknown')); }
            },
            function () { __formatPainterDisarm(); setStatus('Inline paint failed'); }
          );
          return;
        }

        /* Message mode — a button click never applies (contextChanged does).
         * Double-click locks; any other click cancels (incl. a single click
         * while sticky-armed). Preserves the pre-8g-3a "second click cancels". */
        if (canPromote) { armed.sticky = true; __formatPainterSetArmedUI(true); setStatus('Format Painter locked'); return; }
        __formatPainterDisarm();
        setStatus('Format Painter off');
        return;
      }

      /* ── Not armed: arm INLINE (held selection) or MESSAGE-LEVEL ───────── */
      const turnIdx = Number(ctx && ctx.selectedTurnIdx);
      if (!Number.isFinite(turnIdx) || turnIdx < 1) { setStatus('Select a message first'); return; }
      let editing = false;
      try { editing = !!document.querySelector('.wbTurn--editing'); } catch (_) { editing = false; }
      if (editing) { setStatus('Finish editing first'); return; }
      if (!bridge || typeof bridge.getMessageStateForTurn !== 'function' || typeof bridge.applyMessageFormatPaint !== 'function') {
        setStatus('Format Painter unavailable'); return;
      }

      /* Inline capture: a valid held inline selection on the selected turn. */
      const held = getHeldInlineCapture();
      const spos = held && held.anchor && held.anchor.textPos;
      const inlineValid = !!(held && held.ok && spos && Number(held.selectedTurnIdx) === turnIdx
        && Number.isFinite(Number(spos.start)) && Number.isFinite(Number(spos.end)) && Number(spos.end) > Number(spos.start));
      if (inlineValid && typeof bridge.getInlineStateForTurn === 'function' && typeof bridge.applyInlineFormatPaint === 'function') {
        const ss = Number(spos.start), se = Number(spos.end);
        setStatus('Capturing inline formatting…');
        Promise.resolve(bridge.getInlineStateForTurn(turnIdx)).then(
          function (inlineState) {
            const isSt = (inlineState && typeof inlineState === 'object') ? inlineState : {};
            const ov = getOverlayApi();
            const cover = function (list) { return !!(ov && typeof ov.intervalsCover === 'function' && Array.isArray(list) && ov.intervalsCover(list, ss, se)); };
            const colorKind = (function (segs) {
              if (!Array.isArray(segs)) return null;
              for (let i = 0; i < segs.length; i += 1) { const g = segs[i]; if (g && Number(g.start) <= ss && Number(g.end) >= se) return (g.kind == null ? null : String(g.kind)); }
              return null;
            })(isSt.textColor);
            const styles = {
              bold: cover(isSt.bold), italic: cover(isSt.italic), underline: cover(isSt.underline),
              strikethrough: cover(isSt.strikethrough), subscript: cover(isSt.subscript),
              superscript: cover(isSt.superscript), textColor: colorKind,
            };
            const any = styles.bold || styles.italic || styles.underline || styles.strikethrough || styles.subscript || styles.superscript || !!styles.textColor;
            if (!any) { setStatus('Nothing to paint'); return; }
            __formatPainterEngage({ mode: 'inline', styles: styles, sourceTurnIdx: turnIdx, sticky: false }, setStatus, actionBtn, 'Inline Format Painter: select target text, then click Format Painter');
          },
          function () { setStatus('Nothing to paint'); }
        );
        return;
      }

      /* Message-level capture (8g-1). */
      setStatus('Capturing formatting…');
      Promise.resolve(bridge.getMessageStateForTurn(turnIdx)).then(
        function (payload) {
          const p = (payload && typeof payload === 'object') ? payload : null;
          if (!p) { setStatus('Nothing to paint'); return; }
          __formatPainterEngage({ mode: 'message', payload: p, sourceTurnIdx: turnIdx, sticky: false }, setStatus, actionBtn, 'Format Painter: select a target message');
        },
        function () { setStatus('Nothing to paint'); }
      );
    },
  };

  /* Clear formatting — selection-aware (Phase 5c-1).
   *   - Valid held inline selection on the selected turn → submit a
   *     range-scoped `inline-format { style:'clear-inline' }` op, which
   *     the reducer subtracts from the four inline boolean sets over the
   *     selected range only. Message-level decorations are untouched.
   *   - No valid inline selection → existing whole-turn `clear-formatting`
   *     reset (Phase 4-1) which wipes all per-message decorations
   *     (including ALL inline intervals for the turn). */
  ACTION_HANDLERS['clear-formatting'] = {
    isEnabled: formatActionsIsEnabled,
    onClick: function (ctx, setStatus) {
      const turnIdx = Number(ctx && ctx.selectedTurnIdx);
      if (!Number.isFinite(turnIdx) || turnIdx <= 0) { setStatus('Select a message first'); return; }
      const held = getHeldInlineCapture();
      const pos = held && held.anchor && held.anchor.textPos;
      const inlineValid = !!(held && held.ok && held.anchor && pos
        && Number(held.selectedTurnIdx) === turnIdx
        && Number.isFinite(Number(pos.start)) && Number.isFinite(Number(pos.end))
        && Number(pos.end) > Number(pos.start));

      if (inlineValid) {
        const opSpec = {
          type: 'inline-format',
          target: {
            kind: 'inline',
            turnIdx: turnIdx,
            messageId: held.selectedMessageId || ctx.selectedMessageId || null,
            anchor: held.anchor,
          },
          payload: { style: 'clear-inline' },
        };
        runOverlayOp(opSpec, setStatus, {
          pending: 'Clearing inline formatting…',
          success: 'Inline formatting cleared',
          fail: 'Clear inline formatting failed',
        });
        return;
      }

      /* No inline selection → whole-turn message-level reset (unchanged). */
      const opSpec = {
        type: 'clear-formatting',
        target: { kind: 'message', turnIdx: turnIdx, messageId: ctx.selectedMessageId || null },
        payload: {},
      };
      runOverlayOp(opSpec, setStatus, {
        pending: 'Clearing formatting…',
        success: 'Formatting cleared',
        fail: 'Clear formatting failed',
      });
    },
  };

  /* ── Phase 4-2 — Text Color (overlay op `text-color`) ─────────────────
   * Five semantic colors + "None" (clear). Each ribbon action submits a
   * `text-color` op with the appropriate payload.kind. Same enable rule
   * as the Font group (saved-reader + selected turn). Reuses runOverlayOp
   * so drift detection + status feedback + undo/redo all work for free
   * via the Phase 2d active-set model. */
  function buildTextColorHandler(kind, label) {
    return {
      isEnabled: formatActionsIsEnabled,
      onClick: function (ctx, setStatus) {
        const turnIdx = Number(ctx && ctx.selectedTurnIdx);
        if (!Number.isFinite(turnIdx) || turnIdx <= 0) { setStatus('Select a message first'); return; }
        const isClear = (kind === null);

        /* Phase 5c-2 — inline-aware: a valid held inline selection on the
         * selected turn paints (or clears) the color over the RANGE via an
         * `inline-format` op; otherwise the existing Phase 4-2 message-level
         * text-color behaviour is preserved unchanged. Clicking a color
         * always paints (last-wins); None clears the color over the range. */
        const held = getHeldInlineCapture();
        const pos = held && held.anchor && held.anchor.textPos;
        const inlineValid = !!(held && held.ok && held.anchor && pos
          && Number(held.selectedTurnIdx) === turnIdx
          && Number.isFinite(Number(pos.start)) && Number.isFinite(Number(pos.end))
          && Number(pos.end) > Number(pos.start));

        if (inlineValid) {
          const opSpec = {
            type: 'inline-format',
            target: {
              kind: 'inline',
              turnIdx: turnIdx,
              messageId: held.selectedMessageId || ctx.selectedMessageId || null,
              anchor: held.anchor,
            },
            payload: { style: 'text-color', kind: kind },
          };
          runOverlayOp(opSpec, setStatus, {
            pending: isClear ? 'Clearing text color (selection)…' : ('Applying text color (' + label + ', selection)…'),
            success: isClear ? 'Text color cleared (selection)' : ('Text color: ' + label + ' (selection)'),
            fail: 'Text color failed',
          });
          return;
        }

        /* No inline selection → message-level behaviour unchanged. */
        const opSpec = {
          type: 'text-color',
          target: { kind: 'message', turnIdx: turnIdx, messageId: ctx.selectedMessageId || null },
          payload: { kind: kind },
        };
        runOverlayOp(opSpec, setStatus, {
          pending: isClear ? 'Clearing text color…' : ('Applying text color (' + label + ')…'),
          success: isClear ? 'Text color cleared' : ('Text color: ' + label),
          fail: 'Text color failed',
        });
      },
    };
  }
  ACTION_HANDLERS['text-color-red']    = buildTextColorHandler('red',    'red');
  ACTION_HANDLERS['text-color-green']  = buildTextColorHandler('green',  'green');
  ACTION_HANDLERS['text-color-blue']   = buildTextColorHandler('blue',   'blue');
  ACTION_HANDLERS['text-color-orange'] = buildTextColorHandler('orange', 'orange');
  ACTION_HANDLERS['text-color-gray']   = buildTextColorHandler('gray',   'gray');
  ACTION_HANDLERS['text-color-none']   = buildTextColorHandler(null,     'none');

  /* ── Phase 8d-1 — Font Family (message-level overlay op) ─────────────
   * Applies one of the 4 curated typeface tokens (or clears to theme
   * default) to the whole selected turn via the `font-family` overlay op.
   * Message-level only — no inline/range variant. Mirrors the message-
   * level branch of buildTextColorHandler; there is deliberately NO
   * inline-selection path here. `token === null` clears (Default). */
  function buildFontFamilyHandler(token, label) {
    return {
      isEnabled: formatActionsIsEnabled,
      onClick: function (ctx, setStatus) {
        const turnIdx = Number(ctx && ctx.selectedTurnIdx);
        if (!Number.isFinite(turnIdx) || turnIdx <= 0) { setStatus('Select a message first'); return; }
        const isClear = (token === null);
        const opSpec = {
          type: 'font-family',
          target: { kind: 'message', turnIdx: turnIdx, messageId: ctx.selectedMessageId || null },
          payload: { token: token },
        };
        runOverlayOp(opSpec, setStatus, {
          pending: isClear ? 'Clearing font…' : ('Applying font (' + label + ')…'),
          success: isClear ? 'Font: default' : ('Font: ' + label),
          fail: 'Font change failed',
        });
      },
    };
  }
  ACTION_HANDLERS['font-family-sans']     = buildFontFamilyHandler('sans',     'Sans');
  ACTION_HANDLERS['font-family-serif']    = buildFontFamilyHandler('serif',    'Serif');
  ACTION_HANDLERS['font-family-mono']     = buildFontFamilyHandler('mono',     'Mono');
  ACTION_HANDLERS['font-family-humanist'] = buildFontFamilyHandler('humanist', 'Humanist');
  ACTION_HANDLERS['font-family-default']  = buildFontFamilyHandler(null,       'Default');

  /* ── Phase 8d-2 — Font Size (message-level overlay op) ───────────────
   * Applies one of the 3 curated semantic size tokens (or clears to the
   * appearance default) to the whole selected turn via the `font-size`
   * overlay op. Message-level only — no inline/range variant. Mirrors the
   * font-family handler; `size === null` clears (Default/normal). */
  function buildFontSizeHandler(size, label) {
    return {
      isEnabled: formatActionsIsEnabled,
      onClick: function (ctx, setStatus) {
        const turnIdx = Number(ctx && ctx.selectedTurnIdx);
        if (!Number.isFinite(turnIdx) || turnIdx <= 0) { setStatus('Select a message first'); return; }
        const isClear = (size === null);
        const opSpec = {
          type: 'font-size',
          target: { kind: 'message', turnIdx: turnIdx, messageId: ctx.selectedMessageId || null },
          payload: { size: size },
        };
        runOverlayOp(opSpec, setStatus, {
          pending: isClear ? 'Clearing font size…' : ('Applying font size (' + label + ')…'),
          success: isClear ? 'Font size: default' : ('Font size: ' + label),
          fail: 'Font size change failed',
        });
      },
    };
  }
  ACTION_HANDLERS['font-size-small']   = buildFontSizeHandler('small',  'Small');
  ACTION_HANDLERS['font-size-default'] = buildFontSizeHandler(null,     'Default');
  ACTION_HANDLERS['font-size-large']   = buildFontSizeHandler('large',  'Large');
  ACTION_HANDLERS['font-size-xlarge']  = buildFontSizeHandler('xlarge', 'X-Large');

  /* ── Phase 4-3 — Paragraph controls (overlay ops list / align / indent) ─
   * Seven handlers operate on the entire selected turn:
   *   - Bullet / Numbered: list-mode toggles. Clicking the same kind a
   *     second time clears (submits payload.kind === null). Switching to
   *     the other kind replaces the current mode.
   *   - Left / Center / Right: align toggles. Same-button-twice clears.
   *   - Indent / Outdent: deltas. Read current state.indent, submit a
   *     payload.level that is current+1 / current-1, clamped 0..3. The
   *     reducer also clamps defensively.
   * All seven use formatActionsIsEnabled (saved-reader + selected turn). */
  function buildListHandler(kind, label) {
    return {
      isEnabled: formatActionsIsEnabled,
      onClick: function (ctx, setStatus) {
        const turnIdx = Number(ctx && ctx.selectedTurnIdx);
        if (!Number.isFinite(turnIdx) || turnIdx <= 0) { setStatus('Select a message first'); return; }
        const bridge = getRibbonBridge();
        const readP = (bridge && typeof bridge.getMessageStateForTurn === 'function')
          ? Promise.resolve(bridge.getMessageStateForTurn(turnIdx))
          : Promise.resolve({});
        readP.then(function (cur) {
          const curKind = (cur && cur.list && cur.list.kind) || null;
          const nextKind = (curKind === kind) ? null : kind;
          const isClear = (nextKind === null);
          const opSpec = {
            type: 'list',
            target: { kind: 'message', turnIdx: turnIdx, messageId: ctx.selectedMessageId || null },
            payload: { kind: nextKind },
            inverse: { kind: curKind },
          };
          runOverlayOp(opSpec, setStatus, {
            pending: isClear ? 'Removing list…' : ('Applying ' + label + ' list…'),
            success: isClear ? 'List removed' : (label.charAt(0).toUpperCase() + label.slice(1) + ' list applied'),
            fail: 'List failed',
          });
        }, function () { setStatus('List failed: state read'); });
      },
    };
  }
  ACTION_HANDLERS['list-bullet']   = buildListHandler('bullet',   'bullet');
  ACTION_HANDLERS['list-numbered'] = buildListHandler('numbered', 'numbered');

  function buildAlignHandler(value, label) {
    return {
      isEnabled: formatActionsIsEnabled,
      onClick: function (ctx, setStatus) {
        const turnIdx = Number(ctx && ctx.selectedTurnIdx);
        if (!Number.isFinite(turnIdx) || turnIdx <= 0) { setStatus('Select a message first'); return; }
        const bridge = getRibbonBridge();
        const readP = (bridge && typeof bridge.getMessageStateForTurn === 'function')
          ? Promise.resolve(bridge.getMessageStateForTurn(turnIdx))
          : Promise.resolve({});
        readP.then(function (cur) {
          const curAlign = (cur && cur.align) || null;
          const nextValue = (curAlign === value) ? null : value;
          const isClear = (nextValue === null);
          const opSpec = {
            type: 'align',
            target: { kind: 'message', turnIdx: turnIdx, messageId: ctx.selectedMessageId || null },
            payload: { value: nextValue },
            inverse: { value: curAlign },
          };
          runOverlayOp(opSpec, setStatus, {
            pending: isClear ? 'Clearing alignment…' : ('Aligning ' + label + '…'),
            success: isClear ? 'Alignment cleared' : ('Aligned ' + label),
            fail: 'Align failed',
          });
        }, function () { setStatus('Align failed: state read'); });
      },
    };
  }
  ACTION_HANDLERS['align-left']   = buildAlignHandler('left',   'left');
  ACTION_HANDLERS['align-center'] = buildAlignHandler('center', 'center');
  ACTION_HANDLERS['align-right']  = buildAlignHandler('right',  'right');

  /* Indent / Outdent are deltas. Each click reads the current indent
   * level, computes the new level (clamped 0..3), and submits an `indent`
   * op with the ABSOLUTE new level. The reducer also clamps so two
   * sources of truth converge on the same value. When already at the
   * boundary (indent 0 for Outdent, indent 3 for Indent), the handler
   * still submits the same-value op so undo/redo round-trips cleanly. */
  function buildIndentDeltaHandler(delta, opLabel, statusLabel) {
    return {
      isEnabled: formatActionsIsEnabled,
      onClick: function (ctx, setStatus) {
        const turnIdx = Number(ctx && ctx.selectedTurnIdx);
        if (!Number.isFinite(turnIdx) || turnIdx <= 0) { setStatus('Select a message first'); return; }
        const bridge = getRibbonBridge();
        const readP = (bridge && typeof bridge.getMessageStateForTurn === 'function')
          ? Promise.resolve(bridge.getMessageStateForTurn(turnIdx))
          : Promise.resolve({});
        readP.then(function (cur) {
          let curLevel = Number(cur && cur.indent);
          if (!isFinite(curLevel)) curLevel = 0;
          let nextLevel = curLevel + delta;
          if (nextLevel < 0) nextLevel = 0;
          if (nextLevel > 3) nextLevel = 3;
          if (nextLevel === curLevel) {
            /* Boundary case — surface a brief status so the user knows
             * the click registered but the level didn't change. */
            setStatus(delta > 0 ? 'Already at maximum indent' : 'Already at no indent');
            return;
          }
          const opSpec = {
            type: 'indent',
            target: { kind: 'message', turnIdx: turnIdx, messageId: ctx.selectedMessageId || null },
            payload: { level: nextLevel },
            inverse: { level: curLevel },
          };
          runOverlayOp(opSpec, setStatus, {
            pending: opLabel + '…',
            success: statusLabel + ' (level ' + nextLevel + ')',
            fail: opLabel + ' failed',
          });
        }, function () { setStatus(opLabel + ' failed: state read'); });
      },
    };
  }
  ACTION_HANDLERS['indent']  = buildIndentDeltaHandler(+1, 'Indenting',  'Indented');
  ACTION_HANDLERS['outdent'] = buildIndentDeltaHandler(-1, 'Outdenting', 'Outdented');

  /* ── Phase 4-4 — Annotate (overlay op `visual-tag`) ──────────────────
   * IMPORTANT: these are visual overlay annotations, NOT Library
   * metadata tags. The handlers below NEVER call
   * H2O.Studio.store.tags.* or H2O.Library.Tags.* — they submit
   * `visual-tag` overlay ops via runOverlayOp and the applier renders
   * them as a glyph row + colored left-edge stripe on the turn wrapper.
   *
   * Six toggles + one Clear:
   *   - Toggle reads current state.visualTags[kind] and submits the
   *     opposite enabled flag.
   *   - Clear iterates currently-active kinds and submits one op per
   *     active kind with enabled:false. Each becomes its own undoStack
   *     entry — undoing "Clear tags" restores tags one at a time
   *     (documented behaviour in the contract). */
  var VISUAL_TAG_LABELS = {
    todo: 'To Do', important: 'Important', question: 'Question',
    definition: 'Definition', warning: 'Warning', idea: 'Idea',
  };
  var VISUAL_TAG_KINDS = ['todo', 'important', 'question', 'definition', 'warning', 'idea'];

  function buildVisualTagHandler(kind) {
    var label = VISUAL_TAG_LABELS[kind];
    return {
      isEnabled: formatActionsIsEnabled,
      onClick: function (ctx, setStatus) {
        const turnIdx = Number(ctx && ctx.selectedTurnIdx);
        if (!Number.isFinite(turnIdx) || turnIdx <= 0) { setStatus('Select a message first'); return; }
        const bridge = getRibbonBridge();
        const readP = (bridge && typeof bridge.getMessageStateForTurn === 'function')
          ? Promise.resolve(bridge.getMessageStateForTurn(turnIdx))
          : Promise.resolve({});
        readP.then(function (cur) {
          const curOn = !!(cur && cur.visualTags && cur.visualTags[kind]);
          const opSpec = {
            type: 'visual-tag',
            target: { kind: 'message', turnIdx: turnIdx, messageId: ctx.selectedMessageId || null },
            payload: { kind: kind, enabled: !curOn },
            inverse: { kind: kind, enabled: curOn },
          };
          runOverlayOp(opSpec, setStatus, {
            pending: curOn ? ('Removing ' + label + ' tag…') : ('Applying ' + label + ' tag…'),
            success: curOn ? (label + ' tag removed') : (label + ' tag applied'),
            fail: label + ' tag failed',
          });
        }, function () { setStatus(label + ' tag failed: state read'); });
      },
    };
  }
  ACTION_HANDLERS['visual-tag-todo']       = buildVisualTagHandler('todo');
  ACTION_HANDLERS['visual-tag-important']  = buildVisualTagHandler('important');
  ACTION_HANDLERS['visual-tag-question']   = buildVisualTagHandler('question');
  ACTION_HANDLERS['visual-tag-definition'] = buildVisualTagHandler('definition');
  ACTION_HANDLERS['visual-tag-warning']    = buildVisualTagHandler('warning');
  ACTION_HANDLERS['visual-tag-idea']       = buildVisualTagHandler('idea');

  /* Clear tags — loop over currently-active kinds and submit one
   * disable op per kind. Each becomes its own undoStack entry. When no
   * tags are active, surface a friendly "No tags to remove" status. */
  ACTION_HANDLERS['visual-tag-clear'] = {
    isEnabled: formatActionsIsEnabled,
    onClick: function (ctx, setStatus) {
      const turnIdx = Number(ctx && ctx.selectedTurnIdx);
      if (!Number.isFinite(turnIdx) || turnIdx <= 0) { setStatus('Select a message first'); return; }
      const bridge = getRibbonBridge();
      const readP = (bridge && typeof bridge.getMessageStateForTurn === 'function')
        ? Promise.resolve(bridge.getMessageStateForTurn(turnIdx))
        : Promise.resolve({});
      readP.then(function (cur) {
        const vt = (cur && cur.visualTags) || {};
        const active = VISUAL_TAG_KINDS.filter(function (k) { return !!vt[k]; });
        if (active.length === 0) { setStatus('No tags to remove'); return; }
        setStatus('Removing tags…');
        /* Submit one op per active kind. Each goes through runOverlayOp
         * and contributes its own undoStack entry. We chain via Promise
         * to avoid racing the underlying bridge calls, and surface the
         * "All tags removed" status only after the final op resolves. */
        function submitNext(idx) {
          if (idx >= active.length) { setStatus('All tags removed'); return; }
          const k = active[idx];
          const opSpec = {
            type: 'visual-tag',
            target: { kind: 'message', turnIdx: turnIdx, messageId: ctx.selectedMessageId || null },
            payload: { kind: k, enabled: false },
            inverse: { kind: k, enabled: true },
          };
          /* We pass a no-op setStatus to runOverlayOp here so the
           * intermediate per-tag pending/success/fail strings don't
           * flash; we set the final summary status above + on success. */
          const noStatus = function () {};
          runOverlayOp(opSpec, noStatus, {
            pending: 'Removing ' + VISUAL_TAG_LABELS[k] + ' tag…',
            success: VISUAL_TAG_LABELS[k] + ' tag removed',
            fail: VISUAL_TAG_LABELS[k] + ' tag failed',
          });
          /* Sequencing: bridge dispatches are synchronous in the
           * happy path. We schedule the next via microtask so the
           * underlying overlay record is updated before the next read. */
          Promise.resolve().then(function () { submitNext(idx + 1); });
        }
        submitNext(0);
      }, function () { setStatus('Clear tags failed: state read'); });
    },
  };

  /* ── Phase 4-2 — Highlight (bridge to existing H2O.IHighlighter system) ─
   * IMPORTANT: the Ribbon does NOT own a parallel highlight store. All
   * actions in this group are control-surface bridges into the existing
   * H2O.IHighlighter engine + H2O.Studio.store.highlights canonical
   * persistence. No new schema, no new chrome.storage key, no parallel
   * overlay op for highlights.
   *
   * Selection model: highlights are inline span-anchored (XPath +
   * TextPosition + TextQuote per the existing engine). The Ribbon
   * exposes only operations that make sense at message-level OR are
   * global brush state:
   *
   *   1. Brush color picker (8 swatches) — global brush; calls
   *      H2O.IHighlighter.setCurrentColor(name). Doesn't require a
   *      selected turn (brush is global state).
   *
   *   2. Clear highlights on selected message — calls
   *      H2O.Studio.store.highlights.removeForAnswer(selectedMessageId).
   *      Requires saved-reader + selected turn.
   *
   *   3. Show/Hide highlights — calls
   *      H2O.IHighlighter.setEnabled(...). Global visibility toggle.
   *
   * We do NOT expose a "create highlight" button because that requires
   * inline text-range selection which the Ribbon doesn't have. Users
   * still create highlights via the existing S3H1a popup / keyboard
   * shortcut paths. */

  function getIHighlighter() {
    try { return (H2O && H2O.inline) || (H2O && H2O.H2OInline) || (typeof window !== 'undefined' && window.H2OInline) || null; }
    catch (_) { return null; }
  }

  function buildHighlightBrushHandler(colorName, label) {
    return {
      isEnabled: function () {
        const ih = getIHighlighter();
        return !!(ih && typeof ih.setCurrentColor === 'function');
      },
      onClick: function (_ctx, setStatus) {
        const ih = getIHighlighter();
        if (!ih || typeof ih.setCurrentColor !== 'function') {
          setStatus('Highlight bridge unavailable');
          return;
        }
        try {
          ih.setCurrentColor(colorName);
          setStatus('Brush: ' + label);
        } catch (e) {
          const msg = (e && (e.message || String(e))) || 'unknown error';
          setStatus('Brush failed: ' + msg);
        }
      },
    };
  }
  ACTION_HANDLERS['highlight-brush-blue']   = buildHighlightBrushHandler('blue',   'blue');
  ACTION_HANDLERS['highlight-brush-red']    = buildHighlightBrushHandler('red',    'red');
  ACTION_HANDLERS['highlight-brush-green']  = buildHighlightBrushHandler('green',  'green');
  ACTION_HANDLERS['highlight-brush-gold']   = buildHighlightBrushHandler('gold',   'gold');
  ACTION_HANDLERS['highlight-brush-sky']    = buildHighlightBrushHandler('sky',    'sky');
  ACTION_HANDLERS['highlight-brush-pink']   = buildHighlightBrushHandler('pink',   'pink');
  ACTION_HANDLERS['highlight-brush-purple'] = buildHighlightBrushHandler('purple', 'purple');
  ACTION_HANDLERS['highlight-brush-orange'] = buildHighlightBrushHandler('orange', 'orange');

  /* Clear all highlights on the selected assistant message. The
   * Ribbon's `selectedMessageId` matches the engine's `answerId`
   * (both come from the ChatGPT turn's `data-message-id`). */
  ACTION_HANDLERS['highlight-clear-message'] = {
    isEnabled: function (ctx) {
      if (!ctx || ctx.chatType !== 'saved') return false;
      if (!ctx.selectedMessageId) return false;
      const store = H2O && H2O.Studio && H2O.Studio.store && H2O.Studio.store.highlights;
      return !!(store && typeof store.removeForAnswer === 'function');
    },
    onClick: function (ctx, setStatus) {
      const store = H2O && H2O.Studio && H2O.Studio.store && H2O.Studio.store.highlights;
      if (!store || typeof store.removeForAnswer !== 'function') {
        setStatus('Highlight store unavailable');
        return;
      }
      const messageId = ctx && ctx.selectedMessageId;
      if (!messageId) {
        setStatus('Select a message first');
        return;
      }
      setStatus('Clearing highlights…');
      let priorCount = 0;
      try {
        if (typeof store.getForAnswer === 'function') {
          const items = store.getForAnswer(messageId);
          priorCount = Array.isArray(items) ? items.length : 0;
        }
      } catch (_) { /* swallow — count is informational */ }
      Promise.resolve(store.removeForAnswer(messageId)).then(
        function () {
          if (priorCount === 0) { setStatus('No highlights on this message'); return; }
          setStatus('Highlights cleared on this message');
        },
        function (err) {
          const msg = (err && (err.message || String(err))) || 'unknown error';
          setStatus('Clear highlights failed: ' + msg);
        }
      );
    },
  };

  /* Show / Hide all highlights — global visibility toggle. Label is
   * static ("Hide") in the catalogue; status text differentiates
   * "Highlights hidden" vs "Highlights shown" so the user knows what
   * happened. Reading current state at click time keeps the toggle
   * resilient if the engine state is changed elsewhere (popup, shortcut). */
  ACTION_HANDLERS['highlight-visibility'] = {
    isEnabled: function () {
      const ih = getIHighlighter();
      return !!(ih && typeof ih.setEnabled === 'function' && typeof ih.getEnabled === 'function');
    },
    onClick: function (_ctx, setStatus) {
      const ih = getIHighlighter();
      if (!ih || typeof ih.setEnabled !== 'function' || typeof ih.getEnabled !== 'function') {
        setStatus('Highlight bridge unavailable');
        return;
      }
      try {
        const wasOn = !!ih.getEnabled();
        ih.setEnabled(!wasOn);
        setStatus(wasOn ? 'Highlights hidden' : 'Highlights shown');
      } catch (e) {
        const msg = (e && (e.message || String(e))) || 'unknown error';
        setStatus('Visibility toggle failed: ' + msg);
      }
    },
  };

  /* ── Phase 2c-A — structure actions (sections + page dividers) ────────
   * Three actions wired against the edit-overlay subsystem's structure
   * pass:
   *   add-section   — inserts a section header BEFORE the selected
   *                   turn (defaults to top when no selection). Auto-
   *                   numbered title.
   *   split-section — same op as add-section; UX differs only in the
   *                   enable rule (requires selection AND the selected
   *                   turn to be inside an existing section). Phase 2d
   *                   will let users rename sections.
   *   page-divider  — inserts a soft horizontal rule before the selected
   *                   turn. Requires selection.
   *
   * Collapse-section + table-of-contents stay placeholders in 2c-A and
   * ship in 2c-B.
   *
   * All three go through RibbonBridge.applyOverlayOp (Phase 2b), which
   * checks drift, appends an op via the pure helper, upserts, and
   * re-applies the overlay (which now includes the structure pass). */

  function makeOverlayId(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function structureBaseEnabled(ctx) {
    if (!ctx || ctx.chatType !== 'saved') return false;
    if (!ctx.snapshotId) return false;
    const bridge = getRibbonBridge();
    if (!bridge || typeof bridge.applyOverlayOp !== 'function') return false;
    const store = H2O && H2O.Studio && H2O.Studio.store && H2O.Studio.store.editOverlay;
    if (!store || typeof store.upsert !== 'function') return false;
    return true;
  }

  /* Phase 7a — Edit mode toggle. Module-local boolean flipped by the
   * Edit Mode button at the start of the Format tab. The handler also
   * mirrors the state to data-edit-mode on the reader root .wbReader so
   * studio.css can paint the premium ring on the currently-selected
   * turn. Click-to-select reuses the existing reader handler at
   * studio.js:5099-5139 — no new selection model. This slice does NOT:
   * mount a textarea, dispatch a text-replace overlay op, mutate any
   * snapshot, change any export writer, or remove the legacy pencil
   * mounts at studio.js:2399 / 2459 — those are 7b / 7d / 7e
   * respectively. */
  let editMode = false;
  ACTION_HANDLERS['edit-mode'] = {
    isEnabled: function (ctx) {
      return !!(ctx && ctx.chatType === 'saved');
    },
    onClick: function (_ctx, setStatus) {
      editMode = !editMode;
      try {
        const root = (typeof document !== 'undefined')
          ? document.querySelector('.wbReader')
          : null;
        if (root) {
          if (editMode) root.dataset.editMode = 'on';
          else delete root.dataset.editMode;
        }
      } catch (_) { /* swallow — CSS gate just won't fire */ }
      setStatus('Edit mode: ' + (editMode ? 'on' : 'off'));
    },
  };

  ACTION_HANDLERS['add-section'] = {
    /* Enabled whenever a saved reader is open. No selection required —
     * defaults to inserting at the top of the snapshot. */
    isEnabled: function (ctx) { return structureBaseEnabled(ctx); },
    onClick: function (ctx, setStatus) {
      const bridge = getRibbonBridge();
      const readP = (bridge && typeof bridge.getStructureState === 'function')
        ? Promise.resolve(bridge.getStructureState())
        : Promise.resolve({ sections: [] });
      readP.then(function (cur) {
        const sectionCount = (cur && Array.isArray(cur.sections)) ? cur.sections.length : 0;
        const title = 'Section ' + (sectionCount + 1);
        const sectionId = makeOverlayId('sec');
        const ti = Number(ctx && ctx.selectedTurnIdx);
        const afterTurnIdx = (Number.isFinite(ti) && ti > 0) ? (ti - 1) : 0;
        runOverlayOp({
          type: 'add-section',
          target: { kind: 'between-turns', afterTurnIdx: afterTurnIdx },
          payload: { sectionId: sectionId, title: title, afterTurnIdx: afterTurnIdx },
        }, setStatus, {
          pending: 'Adding section…',
          success: 'Section added',
          fail: 'Section failed',
        });
      }, function () { setStatus('Section failed: state read'); });
    },
  };

  ACTION_HANDLERS['split-section'] = {
    /* Enabled when saved reader + selection + at least one overlay op
     * exists. The "selected turn is inside an existing section" check
     * is async (computeStructureState is async via the bridge); we make
     * a fast best-effort sync check here using ctx.hasOverlay, and the
     * onClick performs the real containment check before dispatching. */
    isEnabled: function (ctx) {
      if (!structureBaseEnabled(ctx)) return false;
      const ti = Number(ctx && ctx.selectedTurnIdx);
      if (!Number.isFinite(ti) || ti <= 0) return false;
      if (!ctx.hasOverlay) return false;
      return true;
    },
    onClick: function (ctx, setStatus) {
      const ti = Number(ctx && ctx.selectedTurnIdx);
      if (!Number.isFinite(ti) || ti <= 0) { setStatus('Select a message first'); return; }
      const bridge = getRibbonBridge();
      const ov = H2O && H2O.Studio && H2O.Studio.overlay;
      const readP = (bridge && typeof bridge.getStructureState === 'function')
        ? Promise.resolve(bridge.getStructureState())
        : Promise.resolve({ sections: [] });
      readP.then(function (cur) {
        const containing = (ov && typeof ov.findSectionContaining === 'function')
          ? ov.findSectionContaining(cur, ti)
          : null;
        if (!containing) { setStatus('Select a turn inside an existing section to split'); return; }
        const sections = (cur && Array.isArray(cur.sections)) ? cur.sections : [];
        const title = 'Section ' + (sections.length + 1);
        const sectionId = makeOverlayId('sec');
        runOverlayOp({
          type: 'add-section',
          target: { kind: 'between-turns', afterTurnIdx: ti - 1 },
          payload: { sectionId: sectionId, title: title, afterTurnIdx: ti - 1 },
        }, setStatus, {
          pending: 'Splitting section…',
          success: 'Section split',
          fail: 'Split failed',
        });
      }, function () { setStatus('Split failed: state read'); });
    },
  };

  ACTION_HANDLERS['page-divider'] = {
    /* Enabled when saved reader + selection. No requirement to be
     * inside a section — divider is independent of sections. */
    isEnabled: function (ctx) {
      if (!structureBaseEnabled(ctx)) return false;
      const ti = Number(ctx && ctx.selectedTurnIdx);
      return Number.isFinite(ti) && ti > 0;
    },
    onClick: function (ctx, setStatus) {
      const ti = Number(ctx && ctx.selectedTurnIdx);
      if (!Number.isFinite(ti) || ti <= 0) { setStatus('Select a message first'); return; }
      const dividerId = makeOverlayId('div');
      runOverlayOp({
        type: 'page-divider',
        target: { kind: 'between-turns', afterTurnIdx: ti - 1 },
        payload: { dividerId: dividerId, afterTurnIdx: ti - 1 },
      }, setStatus, {
        pending: 'Adding divider…',
        success: 'Page divider added',
        fail: 'Divider failed',
      });
    },
  };

  /* ── Phase 2c-B — Collapse section + Table of contents ────────────────
   * Both actions go through RibbonBridge.applyOverlayOp (Phase 2b) with
   * structure op types that Phase 2c-A's reducer already accepts
   * (collapse-section + toc). The applier renders the visual outcome
   * via the structure pass — this layer only composes the op spec. */

  ACTION_HANDLERS['collapse-section'] = {
    /* Enabled when saved reader + selection + at least one overlay op
     * exists. The "selected turn is inside an existing section" check
     * runs in onClick because it requires the async structure-state
     * read; the sync gate uses hasOverlay for parity with split-section. */
    isEnabled: function (ctx) {
      if (!structureBaseEnabled(ctx)) return false;
      const ti = Number(ctx && ctx.selectedTurnIdx);
      if (!Number.isFinite(ti) || ti <= 0) return false;
      if (!ctx.hasOverlay) return false;
      return true;
    },
    onClick: function (ctx, setStatus) {
      const ti = Number(ctx && ctx.selectedTurnIdx);
      if (!Number.isFinite(ti) || ti <= 0) { setStatus('Select a message first'); return; }
      const bridge = getRibbonBridge();
      const ov = H2O && H2O.Studio && H2O.Studio.overlay;
      const readP = (bridge && typeof bridge.getStructureState === 'function')
        ? Promise.resolve(bridge.getStructureState())
        : Promise.resolve({ sections: [] });
      readP.then(function (cur) {
        const containing = (ov && typeof ov.findSectionContaining === 'function')
          ? ov.findSectionContaining(cur, ti)
          : null;
        if (!containing) { setStatus('Select a turn inside an existing section to collapse'); return; }
        const nextCollapsed = !containing.collapsed;
        runOverlayOp({
          type: 'collapse-section',
          target: { kind: 'section', sectionId: containing.sectionId },
          payload: { sectionId: containing.sectionId, collapsed: nextCollapsed },
        }, setStatus, {
          pending: nextCollapsed ? 'Collapsing section…' : 'Expanding section…',
          success: nextCollapsed ? 'Section collapsed' : 'Section expanded',
          fail: 'Collapse failed',
        });
      }, function () { setStatus('Collapse failed: state read'); });
    },
  };

  ACTION_HANDLERS['table-of-contents'] = {
    /* Enabled when saved reader is mounted AND any overlay exists (the
     * onClick path enforces the "at least one section" requirement
     * before dispatching the toc op — turns away with a clear status
     * when there are no sections to list). */
    isEnabled: function (ctx) {
      if (!structureBaseEnabled(ctx)) return false;
      if (!ctx.hasOverlay) return false;
      return true;
    },
    onClick: function (ctx, setStatus) {
      const bridge = getRibbonBridge();
      const readP = (bridge && typeof bridge.getStructureState === 'function')
        ? Promise.resolve(bridge.getStructureState())
        : Promise.resolve({ sections: [], toc: { position: null } });
      readP.then(function (cur) {
        const sections = (cur && Array.isArray(cur.sections)) ? cur.sections : [];
        const currentPos = (cur && cur.toc && cur.toc.position) || null;
        /* No sections + TOC currently off → refuse with a helpful status.
         * No sections + TOC currently on → still allow toggling off
         * (recovery from a stale state). */
        if (sections.length === 0 && !currentPos) {
          setStatus('Add at least one section first');
          return;
        }
        const nextPos = (currentPos === 'top') ? null : 'top';
        runOverlayOp({
          type: 'toc',
          target: { kind: 'snapshot' },
          payload: { position: nextPos },
        }, setStatus, {
          pending: nextPos ? 'Showing TOC…' : 'Hiding TOC…',
          success: nextPos ? 'Table of contents shown' : 'Table of contents hidden',
          fail: 'TOC failed',
        });
      }, function () { setStatus('TOC failed: state read'); });
    },
  };

  /* ── Phase 2d — Home → Undo / Redo ────────────────────────────────────
   * Wires the two Home tab History placeholders against the
   * RibbonBridge.undo / .redo methods. Both honour the reducer-filter
   * active-set model: undo moves an op id from undoStack → redoStack
   * without deleting it from overlay.ops; redo moves it back. The
   * applier's reducers skip ops whose id is not in undoStack, so the
   * visual effect appears/disappears immediately.
   *
   * Enable rules:
   *   - undo:  ctx.chatType === 'saved' AND ctx.snapshotId AND
   *            (ctx.undoCount || 0) > 0 AND bridge is installed.
   *   - redo:  same gate, with (ctx.redoCount || 0) > 0.
   *
   * Status strings:
   *   - "Undoing…" / "Undone: <label>" / "Nothing to undo"
   *   - "Redoing…" / "Redone: <label>" / "Nothing to redo"
   *   - "Snapshot has changed — overlay disabled until rebase"
   *     (shared drift string, mirrors runOverlayOp behaviour). */

  function historyBaseEnabled(ctx) {
    if (!ctx || ctx.chatType !== 'saved') return false;
    if (!ctx.snapshotId) return false;
    const bridge = getRibbonBridge();
    if (!bridge || typeof bridge.undo !== 'function' || typeof bridge.redo !== 'function') return false;
    const store = H2O && H2O.Studio && H2O.Studio.store && H2O.Studio.store.editOverlay;
    if (!store || typeof store.upsert !== 'function') return false;
    return true;
  }

  /* Phase 7b repair 10 — Back / Forward handlers wired to the
   * browser-native window.history API. Not invented behavior — the
   * Studio uses hash-based routing on top of window.history, so
   * standard back/forward navigation moves through the user's route
   * history (saved chats viewed, library pages, settings, etc.).
   * isEnabled returns true unconditionally; the browser silently
   * no-ops if there's nothing to go back/forward to. */
  ACTION_HANDLERS['back'] = {
    isEnabled: function () { return true; },
    onClick: function (_ctx, setStatus) {
      try {
        if (typeof window !== 'undefined' && window.history && typeof window.history.back === 'function') {
          window.history.back();
        }
      } catch (_) { /* swallow */ }
    },
  };
  ACTION_HANDLERS['forward'] = {
    isEnabled: function () { return true; },
    onClick: function (_ctx, setStatus) {
      try {
        if (typeof window !== 'undefined' && window.history && typeof window.history.forward === 'function') {
          window.history.forward();
        }
      } catch (_) { /* swallow */ }
    },
  };

  ACTION_HANDLERS['undo'] = {
    isEnabled: function (ctx) {
      if (!historyBaseEnabled(ctx)) return false;
      return Number(ctx && ctx.undoCount) > 0;
    },
    onClick: function (ctx, setStatus) {
      const bridge = getRibbonBridge();
      if (!bridge || typeof bridge.undo !== 'function') {
        setStatus('Undo bridge unavailable');
        return;
      }
      setStatus('Undoing…');
      Promise.resolve(bridge.undo()).then(
        function (result) {
          if (result && result.ok) {
            const label = (result.label && String(result.label).trim()) || '';
            setStatus(label ? ('Undone: ' + label) : 'Undone');
            return;
          }
          const reason = (result && result.reason) || 'unknown';
          if (reason === 'no-undo') { setStatus('Nothing to undo'); return; }
          if (reason === 'no-overlay') { setStatus('Nothing to undo'); return; }
          if (reason === 'drift-detected') {
            setStatus('Snapshot has changed — overlay disabled until rebase');
            return;
          }
          if (reason === 'no-snapshot') { setStatus('No saved chat open'); return; }
          setStatus('Undo failed: ' + reason);
        },
        function (err) {
          const msg = (err && (err.message || String(err))) || 'unknown error';
          setStatus('Undo failed: ' + msg);
        }
      );
    },
  };

  ACTION_HANDLERS['redo'] = {
    isEnabled: function (ctx) {
      if (!historyBaseEnabled(ctx)) return false;
      return Number(ctx && ctx.redoCount) > 0;
    },
    onClick: function (ctx, setStatus) {
      const bridge = getRibbonBridge();
      if (!bridge || typeof bridge.redo !== 'function') {
        setStatus('Redo bridge unavailable');
        return;
      }
      setStatus('Redoing…');
      Promise.resolve(bridge.redo()).then(
        function (result) {
          if (result && result.ok) {
            const label = (result.label && String(result.label).trim()) || '';
            setStatus(label ? ('Redone: ' + label) : 'Redone');
            return;
          }
          const reason = (result && result.reason) || 'unknown';
          if (reason === 'no-redo') { setStatus('Nothing to redo'); return; }
          if (reason === 'no-overlay') { setStatus('Nothing to redo'); return; }
          if (reason === 'drift-detected') {
            setStatus('Snapshot has changed — overlay disabled until rebase');
            return;
          }
          if (reason === 'no-snapshot') { setStatus('No saved chat open'); return; }
          setStatus('Redo failed: ' + reason);
        },
        function (err) {
          const msg = (err && (err.message || String(err))) || 'unknown error';
          setStatus('Redo failed: ' + msg);
        }
      );
    },
  };

  /* ── Registration of the default catalogue ────────────────────────── */
  function registerCatalogue(shell) {
    TAB_CATALOGUE.forEach(function (tab) {
      shell.registerTab(tab.id, { label: tab.label, chatTypes: tab.chatTypes.slice() });
      tab.groups.forEach(function (group) {
        shell.registerGroup(tab.id, group.id, { label: group.label });
        group.actions.forEach(function (action) {
          shell.registerAction(tab.id, group.id, action.id, {
            label: action.label,
            disabled: true,
            /* Phase 1c — per-action tooltip override. When a catalogue
             * entry specifies its own tooltip (e.g. "No public Tags/Labels
             * API yet"), use that instead of the generic placeholder. */
            tooltip: action.tooltip || 'Coming soon',
            phase: action.phase || '1a',
          });
        });
      });
    });
  }

  /* ── Tab filter for current chat type ─────────────────────────────── */
  function visibleTabsFor(chatType) {
    if (!chatType) return [];
    return TAB_CATALOGUE.filter(function (tab) {
      return tab.chatTypes.indexOf(chatType) !== -1;
    });
  }

  /* ── DOM building ─────────────────────────────────────────────────── */
  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'dataset' && attrs[k] && typeof attrs[k] === 'object') {
          Object.keys(attrs[k]).forEach(function (dk) { node.dataset[dk] = attrs[k][dk]; });
        } else if (k.indexOf('aria-') === 0 || k === 'role' || k === 'tabindex' || k === 'type' || k === 'id' || k === 'title' || k === 'hidden') {
          if (k === 'hidden') { if (attrs[k]) node.hidden = true; }
          else node.setAttribute(k, String(attrs[k]));
        } else {
          node.setAttribute(k, String(attrs[k]));
        }
      });
    }
    if (text != null) node.textContent = String(text);
    return node;
  }

  function buildTabStrip(visibleTabs, activeTabId, collapsed) {
    const strip = el('div', { class: 'wbRibbonBar' });

    const tablist = el('div', { class: 'wbRibbonTabs', role: 'tablist', 'aria-label': 'Studio ribbon tabs' });
    visibleTabs.forEach(function (tab) {
      const isActive = (tab.id === activeTabId);
      const tabBtn = el('button', {
        type: 'button',
        class: 'wbRibbonTab' + (isActive ? ' is-active' : ''),
        role: 'tab',
        id: 'wbRibbonTab-' + tab.id,
        'aria-selected': isActive ? 'true' : 'false',
        'aria-controls': 'wbRibbonPanel-' + tab.id,
        tabindex: isActive ? '0' : '-1',
        'data-tab-id': tab.id,
      }, tab.label);
      tablist.appendChild(tabBtn);
    });

    strip.appendChild(tablist);

    /* Phase 1b — non-invasive status label between tab strip and collapse
     * chevron. role="status" + aria-live="polite" so screen readers
     * announce action results. Hidden via CSS :empty when no message. */
    const statusEl = el('div', {
      class: 'wbRibbonStatus',
      role: 'status',
      'aria-live': 'polite',
      'data-testid': 'wbRibbonStatus',
    });
    strip.appendChild(statusEl);

    /* Phase 7b repair 10 — Right-side toolbar group.
     *
     * Required visual order (per the user's screenshots):
     *   status · "..." · Back · Forward · Undo · Redo · ↓
     *
     * The "..." three-dots is the Appearance Panel trigger, mounted
     * at runtime by appearance/appearance-panel.studio.js into a slot
     * with attribute [data-role="appearance-menu-actions"]. If the
     * slot doesn't exist when that module runs, it CREATES one and
     * inserts it just before the collapse chevron — which would land
     * AFTER our Back/Forward/Undo/Redo and give the wrong order.
     *
     * We PRE-CREATE the slot here (empty) so the appearance panel
     * finds it via querySelector and just appends its trigger to it.
     * That guarantees the "..." sits BEFORE our Back/Forward/Undo/Redo
     * in the DOM, matching the spec order.
     *
     * Back / Forward use window.history.back() / forward() — browser-
     * native, not invented. The handlers live near the other
     * ACTION_HANDLERS in this module. */
    strip.appendChild(el('div', {
      class: 'wbRibbonMenuActions',
      'data-role': 'appearance-menu-actions',
      'aria-label': 'Ribbon menu actions',
    }));
    strip.appendChild(el('button', {
      type: 'button',
      class: 'wbRibbonAction wbRibbonNavBtn',
      'data-action-id': 'back',
      'aria-label': 'Back',
      title: 'Back',
    }, '←'));
    strip.appendChild(el('button', {
      type: 'button',
      class: 'wbRibbonAction wbRibbonNavBtn',
      'data-action-id': 'forward',
      'aria-label': 'Forward',
      title: 'Forward',
    }, '→'));
    /* Phase 7b repair 11 — Undo / Redo SVG icons. The unicode glyphs
     * (↶ / ↷) rendered as small text-style ugly glyphs at the row's
     * font-size; replaced with proper inline SVG that mirrors the
     * reference image — thin-stroke curved arrows with rounded caps,
     * 18px square, currentColor for theme harmony. The SVG is
     * injected via innerHTML after creation since the el() helper
     * here only accepts a text child. */
    const undoBtn = el('button', {
      type: 'button',
      class: 'wbRibbonAction wbRibbonQuickBtn',
      'data-action-id': 'undo',
      'aria-label': 'Undo',
      title: 'Undo',
    });
    undoBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" '
        + 'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" '
        + 'stroke-linejoin="round" aria-hidden="true" focusable="false">'
      + '<path d="M3 7v6h6"/>'
      + '<path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>'
      + '</svg>';
    strip.appendChild(undoBtn);

    const redoBtn = el('button', {
      type: 'button',
      class: 'wbRibbonAction wbRibbonQuickBtn',
      'data-action-id': 'redo',
      'aria-label': 'Redo',
      title: 'Redo',
    });
    redoBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" '
        + 'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" '
        + 'stroke-linejoin="round" aria-hidden="true" focusable="false">'
      + '<path d="M21 7v6h-6"/>'
      + '<path d="M3 17a9 9 0 0 1 15-6.7L21 13"/>'
      + '</svg>';
    strip.appendChild(redoBtn);

    const collapseBtn = el('button', {
      type: 'button',
      class: 'wbRibbonCollapse',
      'aria-label': collapsed ? 'Expand ribbon' : 'Collapse ribbon',
      'aria-expanded': collapsed ? 'false' : 'true',
      title: collapsed ? 'Expand ribbon' : 'Collapse ribbon',
      'data-action': 'toggle-collapsed',
    });
    /* Chevron — purely decorative; the aria-label drives screen readers. */
    collapseBtn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="14" height="14">'
      + '<path d="M3 6l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    strip.appendChild(collapseBtn);

    return strip;
  }

  /* Phase 8b — OneNote-style iconification of already-wired Format-tab
   * actions. Keyed by action.id: if an entry exists here, the button
   * render below replaces its text label with the SVG icon (label
   * stays as aria-label + title for a11y + tooltip). All icons are
   * original 16×16 viewBox with 1.6px currentColor strokes and
   * rounded caps/joins — matches the visual language of the existing
   * Undo/Redo/collapse chevron icons shipped in Phase 7b repair 11.
   *
   * DELIBERATELY NOT ICONIFIED:
   *  - edit-mode (Phase 7a filled-blue pill stays as text)
   *  - h1/h2/h3 (labels ARE the meaningful glyph)
   *  - text-color-*, highlight-brush-* (Phase 6c compact color dots)
   *  - text-color-none, highlight-clear-message, highlight-visibility
   *    (semantic text pills)
   *  - visual-tag-* (Annotate group — semantic labels)
   *
   * No new action IDs. No handler changes. No behavior changes. */
  const ACTION_ICONS = {
    /* Clipboard group — Phase 8f-1. Classic two-sheet "copy" glyph. */
    'copy-message': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5H3A1.5 1.5 0 0 1 1.5 9V3A1.5 1.5 0 0 1 3 1.5h6A1.5 1.5 0 0 1 10.5 3v.5"/></svg>',
    /* Phase 8g-1 — Format Painter (paint-roller: head + arm + pad). */
    'format-painter': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="2" y="2.5" width="9" height="4" rx="1"/><path d="M11 4.5h1.5a1 1 0 0 1 1 1v1.3a1 1 0 0 1-1 1H7a1 1 0 0 0-1 1v0.7"/><rect x="4.5" y="10.5" width="3" height="3.5" rx="1"/></svg>',
    /* Font group */
    'bold': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 3v10"/><path d="M4 3h4a2.5 2.5 0 0 1 0 5H4"/><path d="M4 8h5a2.5 2.5 0 0 1 0 5H4"/></svg>',
    'italic': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6.5 3H11"/><path d="M5 13h4.5"/><path d="M9.5 3l-3 10"/></svg>',
    'underline': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 3v5a4 4 0 0 0 8 0V3"/><path d="M3 14h10"/></svg>',
    'strikethrough': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M11 5a3 3 0 0 0-3-2h-1a2.3 2.3 0 0 0 0 4.6h2A2.7 2.7 0 0 1 11 10.3v.2A2.5 2.5 0 0 1 8.5 13H7a3 3 0 0 1-3-2"/><path d="M2 8h12"/></svg>',
    /* Phase 8e-1 — Subscript (x with a low 2) and Superscript (x with a
     * high 2). The "x" strokes + a small numeral 2 rendered as text. */
    'subscript': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 3l5 7"/><path d="M7 3l-5 7"/><text x="9.5" y="15" fill="currentColor" stroke="none" font-family="Helvetica,Arial,sans-serif" font-size="6" font-weight="600">2</text></svg>',
    'superscript': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 6l5 7"/><path d="M7 6l-5 7"/><text x="9.5" y="7" fill="currentColor" stroke="none" font-family="Helvetica,Arial,sans-serif" font-size="6" font-weight="600">2</text></svg>',
    'clear-formatting': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 3h6"/><path d="M8 3v6"/><path d="M2 14l12-12"/></svg>',
    /* Paragraph group — lists */
    'list-bullet': '<svg viewBox="0 0 16 16" fill="currentColor" stroke="none" aria-hidden="true" focusable="false"><circle cx="3" cy="4" r="1"/><circle cx="3" cy="8" r="1"/><circle cx="3" cy="12" r="1"/><path stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" d="M6.5 4h7.5M6.5 8h7.5M6.5 12h7.5"/></svg>',
    'list-numbered': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6.5 4h7.5"/><path d="M6.5 8h7.5"/><path d="M6.5 12h7.5"/><text x="1" y="5" fill="currentColor" stroke="none" font-family="Helvetica,Arial,sans-serif" font-size="4.5" font-weight="600">1</text><text x="1" y="9" fill="currentColor" stroke="none" font-family="Helvetica,Arial,sans-serif" font-size="4.5" font-weight="600">2</text><text x="1" y="13" fill="currentColor" stroke="none" font-family="Helvetica,Arial,sans-serif" font-size="4.5" font-weight="600">3</text></svg>',
    /* Paragraph group — alignment */
    'align-left': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 3h12"/><path d="M2 7h8"/><path d="M2 11h12"/><path d="M2 15h8"/></svg>',
    'align-center': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 3h12"/><path d="M4 7h8"/><path d="M2 11h12"/><path d="M4 15h8"/></svg>',
    'align-right': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 3h12"/><path d="M6 7h8"/><path d="M2 11h12"/><path d="M6 15h8"/></svg>',
    /* Paragraph group — indentation */
    'indent': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 3h12"/><path d="M6 7h8"/><path d="M6 11h8"/><path d="M2 15h12"/><path d="M2 7l3 2-3 2"/></svg>',
    'outdent': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 3h12"/><path d="M6 7h8"/><path d="M6 11h8"/><path d="M2 15h12"/><path d="M5 7l-3 2 3 2"/></svg>',
    /* Blocks group */
    'quote': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 4a2 2 0 0 1 2 2v1a3 3 0 0 1-3 3"/><path d="M9 4a2 2 0 0 1 2 2v1a3 3 0 0 1-3 3"/><path d="M3 4h2"/><path d="M9 4h2"/></svg>',
    'code': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 4L2 8l3 4"/><path d="M11 4l3 4-3 4"/></svg>',
    'callout': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6"/><path d="M8 7v4"/><circle cx="8" cy="5" r=".6" fill="currentColor" stroke="none"/></svg>',
    /* Cleanup group */
    'clean-spacing': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 2h10"/><path d="M3 14h10"/><path d="M8 5v6"/><path d="M6 7l2-2 2 2"/><path d="M6 9l2 2 2-2"/></svg>',
  };

  /* Phase 8c-1 — OneNote-style split-button primitive.
   *
   * Some Format-tab groups (Text Color for now; Highlight and Alignment
   * follow in 8c-2/8c-3) are palettes rather than icon rows. Rendering
   * every palette entry as a full 28x28 icon button drowns the ribbon
   * and diverges from the OneNote reference. Instead, when a group id
   * appears in SPLIT_BUTTONS the render pass collapses the palette
   * into ONE composite button: a main half that re-invokes the last-
   * picked palette entry and a chevron half that opens a popover of
   * every entry.
   *
   * Intentionally minimal — no new action ids, no new overlay op
   * types, no new ACTION_HANDLERS entries. Both halves dispatch
   * through the existing catalogue actions via data-action-id and
   * the ribbon's existing delegated click handler. Popover open/
   * close is local DOM state, and last-picked-per-group persists
   * across re-renders in a module-level map.
   */
  const TEXT_COLOR_SWATCH_HEX = {
    'text-color-red':    '#C53030',
    'text-color-green':  '#2F855A',
    'text-color-blue':   '#2C5282',
    'text-color-orange': '#C05621',
    'text-color-gray':   '#4A5568',
  };
  /* Phase 8c-2 — Highlight brush palette. Mirrors the eight
   * H2O.IHighlighter brush hexes already declared in studio.css
   * (.wbRibbonAction[data-action-id="highlight-brush-*"]::before).
   * Kept in sync by copy, same as TEXT_COLOR_SWATCH_HEX. */
  const HIGHLIGHT_SWATCH_HEX = {
    'highlight-brush-blue':   '#3B82F6',
    'highlight-brush-red':    '#FF4C4C',
    'highlight-brush-green':  '#22C55E',
    'highlight-brush-gold':   '#FFD54F',
    'highlight-brush-sky':    '#7DD3FC',
    'highlight-brush-pink':   '#F472B6',
    'highlight-brush-purple': '#A855F7',
    'highlight-brush-orange': '#FF914D',
  };
  const CHEVRON_ICON = '<svg viewBox="0 0 10 6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M1 1.5l4 3 4-3"/></svg>';
  const TEXT_COLOR_GLYPH_ICON = '<svg viewBox="0 0 16 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 11L7.5 3l3.5 8"/><path d="M5 8h5"/></svg>';
  /* Highlighter-marker glyph. The colored underline below the tip is
   * the shared .wbRibbonSplitBtn__swatch (current brush color), so the
   * icon itself is a neutral marker outline. */
  const HIGHLIGHT_GLYPH_ICON = '<svg viewBox="0 0 16 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9.5 2.2l4.3 4.3-5.6 5.6-3.4.5.5-3.4z"/><path d="M8 3.7l4.3 4.3"/></svg>';
  /* Phase 8d-1/8d-2 — short token per label-dropdown action id. The
   * split-button primitive reads cfg.tokenById to render the main preview
   * + each popover row in the picked token (via cfg.previewAttr:
   * data-font / data-size). '' = the "Default"/clear row (no preview
   * attr). Declared before SPLIT_BUTTONS so the configs can reference
   * them directly. */
  const FONT_FAMILY_TOKEN = {
    'font-family-sans':     'sans',
    'font-family-serif':    'serif',
    'font-family-mono':     'mono',
    'font-family-humanist': 'humanist',
    'font-family-default':  '',
  };
  const FONT_SIZE_TOKEN = {
    'font-size-small':   'small',
    'font-size-default': '',
    'font-size-large':   'large',
    'font-size-xlarge':  'xlarge',
  };
  const SPLIT_BUTTONS = {
    'text-color': {
      kind: 'text-color',
      mainAriaLabel: 'Apply text color',
      chevronAriaLabel: 'Choose text color',
      defaultActionId: 'text-color-red',
      glyphIcon: TEXT_COLOR_GLYPH_ICON,
      hexById: TEXT_COLOR_SWATCH_HEX,
      swatchIdPrefix: 'text-color-',
      /* Phase 8c-4 — `text-color-none` clears color. It has no hex, so it
       * is not a swatch; without this it rendered as a blank popover cell.
       * Listed here so the popover draws a visible "no color" slashed
       * swatch for it (still dispatches the existing text-color-none). */
      noColorIds: ['text-color-none'],
    },
    /* Phase 8c-2 — Highlight. Reuses the shared primitive. `hexById`
     * covers the 8 brush swatches; `commandIds` are the two non-swatch
     * actions (Clear / Hide) rendered as full-width command rows.
     * `currentColorFromEngine` seeds the main button from the live
     * H2O.IHighlighter brush color so the split button always reflects
     * the real global brush (Phase 6e-1 parity). */
    'highlight': {
      kind: 'highlight',
      mainAriaLabel: 'Apply highlight brush',
      chevronAriaLabel: 'Choose highlight',
      defaultActionId: 'highlight-brush-blue',
      glyphIcon: HIGHLIGHT_GLYPH_ICON,
      hexById: HIGHLIGHT_SWATCH_HEX,
      swatchIdPrefix: 'highlight-brush-',
      commandIds: ['highlight-clear-message', 'highlight-visibility'],
      currentColorFromEngine: true,
    },
    /* Phase 8c-3 — Alignment. Unlike Text Color / Highlight (whole-group
     * palettes), alignment is a SUB-GROUP of the Paragraph group: only
     * the three align actions collapse into the split button, while
     * list-bullet / list-numbered / indent / outdent keep rendering as
     * individual icon buttons. `groupId` says which group it lives in and
     * `actionIds` names the covered subset. `iconFromActionIcons` reuses
     * the Phase 8b ACTION_ICONS glyphs for the main button (reflecting the
     * last-picked alignment) and the popover rows; `showItemLabel` adds
     * the Left / Center / Right text beside each icon. No color swatch. */
    'align': {
      kind: 'align',
      groupId: 'paragraph',
      actionIds: ['align-left', 'align-center', 'align-right'],
      mainAriaLabel: 'Align',
      chevronAriaLabel: 'Choose alignment',
      defaultActionId: 'align-left',
      iconFromActionIcons: true,
      showItemLabel: true,
    },
    /* Phase 8d-1 — Font Family. A sub-group split inside the Font group
     * (like Alignment inside Paragraph): the 5 font-family actions collapse
     * into one dropdown; B/I/U/S/Clear keep rendering as icon buttons.
     * `labelItems` renders text-label radio rows (Sans / Serif / … /
     * Default); `labelMain` renders a compact "Aa" preview in the current
     * token's font on the main button. No color swatch, no icon glyph. */
    'font-family': {
      kind: 'font-family',
      groupId: 'font',
      actionIds: ['font-family-sans', 'font-family-serif', 'font-family-mono',
        'font-family-humanist', 'font-family-default'],
      mainAriaLabel: 'Font',
      chevronAriaLabel: 'Choose font',
      defaultActionId: 'font-family-sans',
      labelItems: true,
      labelMain: true,
      tokenById: FONT_FAMILY_TOKEN,
      previewText: 'Aa',
      previewAttr: 'data-font',
    },
    /* Phase 8d-2 — Font Size. A second sub-group split inside the Font
     * group. Same labelItems/labelMain primitive as Font Family, but the
     * preview is a size step, not a typeface: `previewAttr: 'data-size'`
     * scales the main "A" and each popover row by the picked size token. */
    'font-size': {
      kind: 'font-size',
      groupId: 'font',
      actionIds: ['font-size-small', 'font-size-default', 'font-size-large', 'font-size-xlarge'],
      mainAriaLabel: 'Font size',
      chevronAriaLabel: 'Choose size',
      defaultActionId: 'font-size-default',
      labelItems: true,
      labelMain: true,
      tokenById: FONT_SIZE_TOKEN,
      previewText: 'A',
      previewAttr: 'data-size',
    },
  };
  const __splitBtnLastPicked = {
    'text-color': 'text-color-red',
    'highlight': 'highlight-brush-blue',
    'align': 'align-left',
    'font-family': 'font-family-sans',
    'font-size': 'font-size-default',
  };
  let __openSplitPopover = null;
  /* Phase 8c-2 — module ref to the live ribbon shell, stashed by
   * render(). Lets the split-button popover dispatch actions with a
   * FRESH context (matching the delegated handler's freshness) and
   * defensively re-render after a brush change, without threading the
   * shell through every buildPanels/__buildSplitButton call. */
  let __ribbonShell = null;
  /* Phase 8g-1 / 8g-2a — Format Painter armed state (single-use). Either
   * { mode:'message', payload, sourceTurnIdx } (message-level, applies on the
   * next target-message contextChanged) or { mode:'inline', styles,
   * sourceTurnIdx } (inline style set, applies to the target held selection on
   * the next button click). Module-scoped; never persisted. */
  let __formatPainterArmed = null;
  let __formatPainterEsc = null;     /* document keydown handler while armed */
  let __formatPainterLastArmAt = 0;  /* ms of the last engage — dbl-click lock detect (8g-3a) */
  const FP_STICKY_DBLCLICK_MS = 350; /* Phase 8g-3a — a second arm-click within this window locks */
  function __formatPainterSetArmedUI(on) {
    try {
      const btn = document.querySelector('.wbRibbonAction[data-action-id="format-painter"]');
      if (btn) { if (on) btn.setAttribute('aria-pressed', 'true'); else btn.removeAttribute('aria-pressed'); }
    } catch (_) { /* swallow */ }
  }
  function __formatPainterDisarm() {
    __formatPainterArmed = null;
    if (__formatPainterEsc) {
      try { document.removeEventListener('keydown', __formatPainterEsc, true); } catch (_) {}
      __formatPainterEsc = null;
    }
    __formatPainterSetArmedUI(false);
  }
  /* Arm the painter: store state, install Escape-cancel + armed button UI, set
   * the arm status. Shared by the message-level and inline capture paths, and
   * by sticky re-arm (Phase 8g-3a). Idempotent: removes any prior Escape
   * listener first so a sticky re-arm never leaks handlers. The armed object
   * carries an optional `sticky` flag. aria-pressed is set on the LIVE button
   * (re-queried) so re-arm after a mid-apply re-render still reflects. */
  function __formatPainterEngage(armed, setStatus, actionBtn, armStatus) {
    __formatPainterArmed = armed;
    __formatPainterLastArmAt = Date.now();
    if (__formatPainterEsc) {
      try { document.removeEventListener('keydown', __formatPainterEsc, true); } catch (_) {}
      __formatPainterEsc = null;
    }
    __formatPainterEsc = function (ev) {
      if (ev && ev.key === 'Escape' && __formatPainterArmed) {
        __formatPainterDisarm();
        try { setStatus('Format Painter off'); } catch (_) {}
      }
    };
    try { document.addEventListener('keydown', __formatPainterEsc, true); } catch (_) {}
    if (actionBtn) { try { actionBtn.setAttribute('aria-pressed', 'true'); } catch (_) {} }
    __formatPainterSetArmedUI(true);
    try { setStatus(armStatus); } catch (_) {}
  }

  function __closeSplitPopover(reason) {
    if (!__openSplitPopover) return;
    const rec = __openSplitPopover;
    __openSplitPopover = null;
    try { document.removeEventListener('mousedown', rec.onDocMouseDown, true); } catch (_) {}
    try { document.removeEventListener('keydown', rec.onDocKeydown, true); } catch (_) {}
    if (rec.node && rec.node.parentNode) rec.node.parentNode.removeChild(rec.node);
    if (rec.trigger) {
      try { rec.trigger.setAttribute('aria-expanded', 'false'); } catch (_) {}
      try { rec.trigger.removeAttribute('aria-controls'); } catch (_) {}
    }
    /* Phase 8d-0 — return focus to the chevron for keyboard-driven closes
     * (Escape / Tab / keyboard item select). Outside-click passes no reason,
     * so focus is left wherever the user clicked. If the original chevron was
     * detached by a dispatch re-render (highlight brush), re-query the live
     * one by kind inside the ribbon container. */
    if (reason === 'escape' || reason === 'tab' || reason === 'select') {
      let target = rec.trigger;
      try {
        if ((!target || !target.isConnected) && rec.container && rec.kind) {
          target = rec.container.querySelector('.wbRibbonSplitBtn__chevron--' + rec.kind);
        }
      } catch (_) { /* keep original target */ }
      if (target) { try { target.focus(); } catch (_) {} }
    }
  }

  /* Phase 8c-2 — dispatch a split-button action through the SAME path
   * the delegated ribbon handler uses (ACTION_HANDLERS[id].onClick).
   * Needed because the split button's main half is not a .wbRibbonAction
   * and the popover is mounted on document.body — both live outside the
   * container-scoped click delegation, so they can't rely on it.
   *
   * `setStatus` is derived by walking up from the trigger to the ribbon
   * container (the ancestor that hosts .wbRibbonStatus); context comes
   * fresh from the stashed shell so selection-sensitive actions (e.g.
   * highlight-clear-message) see the current selection, not a stale
   * render-time snapshot. Brush changes trigger a defensive re-render
   * mirroring the delegated handler's Phase 6e-1 behavior. */
  function __dispatchSplitAction(actionId, triggerEl) {
    const handler = actionId && ACTION_HANDLERS[actionId];
    if (!handler || typeof handler.onClick !== 'function') return;
    let root = triggerEl;
    while (root && !(root.querySelector && root.querySelector('.wbRibbonStatus'))) {
      root = root.parentElement;
    }
    const setStatus = makeSetStatus(root || document.body);
    let ctx = null;
    try { ctx = (__ribbonShell && typeof __ribbonShell.getContext === 'function') ? __ribbonShell.getContext() : null; }
    catch (_) { ctx = null; }
    try { handler.onClick(ctx, setStatus, triggerEl); }
    catch (e) {
      const msg = (e && (e.message || String(e))) || 'unknown error';
      setStatus('Action failed: ' + msg);
    }
    if (root && __ribbonShell && typeof actionId === 'string' && actionId.indexOf('highlight-brush-') === 0) {
      try { render(root, __ribbonShell); } catch (_) { /* swallow — subscription re-render normally covers this */ }
    }
  }

  /* Resolve the action id the split button's main half currently
   * represents. Highlight seeds from the live IHighlighter brush color
   * (Phase 6e-1 parity) so the button mirrors global brush state; other
   * kinds use the sticky last-picked value. Falls back to the config
   * default when neither is available in the group. */
  function __resolveSplitCurrentId(cfg, actions) {
    if (cfg.currentColorFromEngine) {
      try {
        const ih = getIHighlighter();
        const cur = (ih && typeof ih.getCurrentColor === 'function')
          ? String(ih.getCurrentColor() || '').trim().toLowerCase()
          : '';
        if (cur) {
          const candidate = (cfg.swatchIdPrefix || '') + cur;
          if (actions[candidate]) return candidate;
        }
      } catch (_) { /* fall through to last-picked */ }
    }
    const picked = __splitBtnLastPicked[cfg.kind];
    if (picked && actions[picked]) return picked;
    return cfg.defaultActionId;
  }

  /* Phase 8c-3 — resolve which split-button configs apply to a group.
   * A config targets the group whose id equals cfg.groupId (sub-group
   * configs like Alignment) or, for whole-group palettes (Text Color /
   * Highlight), cfg.kind. Returns:
   *   whole   — the whole-group config (collapses every action) or null
   *   anchor  — { firstActionId -> cfg } marking where each sub-group
   *             split button renders (in place of its first action)
   *   covered — { actionId -> true } for every action a sub-group split
   *             button absorbs (so the per-action pass skips them)
   * Whole-group and sub-group are mutually exclusive per group in
   * practice, but both are reported independently for safety. */
  function __splitConfigsForGroup(groupId) {
    let whole = null;
    const anchor = {};
    const covered = {};
    Object.keys(SPLIT_BUTTONS).forEach(function (key) {
      const cfg = SPLIT_BUTTONS[key];
      const cfgGroup = cfg.groupId || cfg.kind;
      if (cfgGroup !== groupId) return;
      if (!cfg.actionIds || !cfg.actionIds.length) { whole = cfg; return; }
      cfg.actionIds.forEach(function (id, i) {
        covered[id] = true;
        if (i === 0) anchor[id] = cfg;
      });
    });
    return { whole: whole, anchor: anchor, covered: covered };
  }

  /* Phase 8d-0 — enabled popover items in DOM (== visual) order; the single
   * source of nav ordering for every split kind (swatch grid, icon list,
   * command rows). Disabled items (e.g. Clear with no selection) are skipped. */
  function __splitPopoverItems(pop) {
    if (!pop || typeof pop.querySelectorAll !== 'function') return [];
    return Array.prototype.slice.call(
      pop.querySelectorAll('.wbRibbonPopover__item:not([disabled])')
    );
  }

  /* Phase 8d-0 — roving-tabindex focus move: the focused item becomes
   * tabindex 0, all others tabindex -1; index wraps around. No-op on an
   * empty list. */
  function __focusSplitItem(items, idx) {
    if (!items || !items.length) return;
    const n = items.length;
    let i = idx % n;
    if (i < 0) i += n;
    for (let k = 0; k < n; k += 1) {
      try { items[k].setAttribute('tabindex', k === i ? '0' : '-1'); } catch (_) {}
    }
    try { items[i].focus(); } catch (_) {}
  }

  function __openSplitPopoverFor(cfg, actions, ctx, triggerEl, onPick) {
    __closeSplitPopover();
    /* Phase 8d-0 — ribbon container (the .wbRibbonStatus host) captured up
     * front so focus can return to the chevron after close, re-queried by
     * kind if a dispatch re-render replaces it. */
    let __popoverContainer = triggerEl;
    while (__popoverContainer && !(__popoverContainer.querySelector
        && __popoverContainer.querySelector('.wbRibbonStatus'))) {
      __popoverContainer = __popoverContainer.parentElement;
    }
    /* Prefer a fresh context so per-item enabled/disabled state reflects
     * the current selection at open time (Phase 8c-2). */
    try { if (__ribbonShell && typeof __ribbonShell.getContext === 'function') ctx = __ribbonShell.getContext(); }
    catch (_) { /* keep passed-in ctx */ }
    /* Phase 8c-2 — current brush color, used to mark the active swatch
     * (Phase 6e-1 parity) inside the popover for highlight groups. */
    let currentSwatchColor = '';
    if (cfg.currentColorFromEngine) {
      try {
        const ih = getIHighlighter();
        currentSwatchColor = (ih && typeof ih.getCurrentColor === 'function')
          ? String(ih.getCurrentColor() || '').trim().toLowerCase()
          : '';
      } catch (_) { currentSwatchColor = ''; }
    }
    /* Phase 8c-3 — last-picked action id for icon kinds (Alignment), used
     * to mark that row as pressed inside the popover. */
    let currentIconId = '';
    if (cfg.iconFromActionIcons) {
      try { currentIconId = __resolveSplitCurrentId(cfg, actions); } catch (_) { currentIconId = ''; }
    }
    /* Phase 8d-1 — current action id for label kinds (Font Family), used to
     * mark that text-label row as checked inside the popover. */
    let currentLabelId = '';
    if (cfg.labelItems) {
      try { currentLabelId = __resolveSplitCurrentId(cfg, actions); } catch (_) { currentLabelId = ''; }
    }
    const pop = el('div', {
      class: 'wbRibbonPopover wbRibbonPopover--' + cfg.kind,
      role: 'menu',
      'aria-label': cfg.chevronAriaLabel || 'Choose',
    });
    Object.keys(actions).forEach(function (aid) {
      const action = actions[aid];
      const isSwatch = !!(cfg.hexById && cfg.hexById[action.id]);
      const isCommand = !!(cfg.commandIds && cfg.commandIds.indexOf(action.id) !== -1);
      const isIcon = !!(cfg.iconFromActionIcons && !isSwatch && !isCommand);
      /* Phase 8c-4 — "no color" / clear item (text-color-none): swatch-
       * sized cell with a CSS slash so it isn't a blank cell. */
      const isNoColor = !!(cfg.noColorIds && cfg.noColorIds.indexOf(action.id) !== -1);
      /* Phase 8d-1 — text-label pick-one row (Font Family) for kinds that
       * are neither swatch nor icon nor command. */
      const isLabel = !!(cfg.labelItems && !isSwatch && !isCommand && !isIcon && !isNoColor);
      /* Phase 8d-0 — pick-one items (swatch / icon / none / label) are
       * radios; command rows (Clear / Hide) stay plain menu items. */
      const isRadio = isSwatch || isIcon || isNoColor || isLabel;
      /* Per-item enablement — mirrors the render pass so selection-
       * sensitive actions (e.g. highlight-clear-message) grey out when
       * unavailable. Swatch brushes are global-state and stay enabled
       * whenever the engine is present. */
      let itemEnabled = true;
      const itemHandler = ACTION_HANDLERS[action.id];
      if (itemHandler && typeof itemHandler.isEnabled === 'function') {
        try { itemEnabled = !!itemHandler.isEnabled(ctx); } catch (_) { itemEnabled = false; }
      }
      const item = el('button', {
        type: 'button',
        class: 'wbRibbonPopover__item wbRibbonPopover__item--' + cfg.kind
          + (isCommand ? ' wbRibbonPopover__item--command' : '')
          + (isSwatch ? ' wbRibbonPopover__item--swatch' : '')
          + (isIcon ? ' wbRibbonPopover__item--icon' : '')
          + (isNoColor ? ' wbRibbonPopover__item--noColor' : '')
          + (isLabel ? ' wbRibbonPopover__item--label' : ''),
        role: isRadio ? 'menuitemradio' : 'menuitem',
        /* Phase 8d-0 — roving tabindex: all items start non-tabbable; the
         * open path promotes exactly one to tabindex 0 and moves it with
         * the arrow keys. */
        tabindex: '-1',
        'data-action-id': action.id,
        title: action.label,
        'aria-label': action.label,
        'aria-disabled': itemEnabled ? 'false' : 'true',
      });
      /* Phase 8d-0 — radios carry aria-checked (default false; the current
       * pick sets true below, alongside aria-pressed which the shipped CSS
       * selectors still key on). */
      if (isRadio) { try { item.setAttribute('aria-checked', 'false'); } catch (_) {} }
      if (isSwatch) {
        const suffix = action.id.slice((cfg.swatchIdPrefix || '').length);
        item.setAttribute('data-swatch-color', suffix);
        item.style.setProperty('--wbRibbonPopoverItemColor', cfg.hexById[action.id]);
        if (currentSwatchColor && currentSwatchColor === suffix) {
          item.setAttribute('aria-pressed', 'true');
          item.setAttribute('aria-checked', 'true');
        }
      }
      if (isCommand) {
        item.appendChild(document.createTextNode(action.label));
      }
      if (isIcon) {
        const glyph = ACTION_ICONS[action.id];
        if (glyph) {
          const iconSpan = el('span', { class: 'wbRibbonPopover__itemIcon' });
          iconSpan.innerHTML = glyph;
          item.appendChild(iconSpan);
        }
        if (cfg.showItemLabel) {
          item.appendChild(document.createTextNode(action.label));
        }
        if (currentIconId && currentIconId === action.id) {
          item.setAttribute('aria-pressed', 'true');
          item.setAttribute('aria-checked', 'true');
        }
      }
      if (isLabel) {
        /* Phase 8d-1/8d-2 — text-label row; the label IS the visible
         * content. cfg.tokenById + cfg.previewAttr preview each row in the
         * picked token: Font Family (data-font) renders "Serif" in serif;
         * Font Size (data-size) renders "Large" at the large size. */
        const labelTok = cfg.tokenById && cfg.tokenById[action.id];
        if (labelTok && cfg.previewAttr) { item.setAttribute(cfg.previewAttr, labelTok); }
        item.appendChild(document.createTextNode(action.label));
        if (currentLabelId && currentLabelId === action.id) {
          item.setAttribute('aria-pressed', 'true');
          item.setAttribute('aria-checked', 'true');
        }
      }
      if (!itemEnabled) {
        item.setAttribute('disabled', 'disabled');
      }
      item.addEventListener('click', function () {
        if (!itemEnabled) return;
        if (isSwatch || isIcon || isLabel) {
          __splitBtnLastPicked[cfg.kind] = action.id;
        }
        /* Close first so a brush-triggered re-render doesn't race the
         * live popover node, then dispatch through the real handler.
         * Phase 8d-0 — 'select' returns focus to the chevron; if a brush
         * re-render then detaches it, re-focus the rebuilt one below. */
        __closeSplitPopover('select');
        __dispatchSplitAction(action.id, triggerEl);
        if (isSwatch || isIcon || isLabel) { try { if (typeof onPick === 'function') onPick(action); } catch (_) {} }
        if (triggerEl && !triggerEl.isConnected && __popoverContainer) {
          const __fresh = __popoverContainer.querySelector('.wbRibbonSplitBtn__chevron--' + cfg.kind);
          if (__fresh) { try { __fresh.focus(); } catch (_) {} }
        }
      });
      pop.appendChild(item);
    });
    document.body.appendChild(pop);
    const r = triggerEl.getBoundingClientRect();
    pop.style.top  = (window.scrollY + r.bottom + 4) + 'px';
    pop.style.left = (window.scrollX + r.left) + 'px';

    /* Phase 8d-0 — link the trigger to the menu for assistive tech. */
    try { pop.id = 'wbRibbonSplitPopover-' + cfg.kind; } catch (_) {}
    try { triggerEl.setAttribute('aria-controls', pop.id); } catch (_) {}

    const onDocMouseDown = function (ev) {
      if (pop.contains(ev.target) || triggerEl.contains(ev.target)) return;
      /* Outside click: close without stealing focus (no reason). */
      __closeSplitPopover();
    };
    const onDocKeydown = function (ev) {
      /* Escape routes through the close-reason path (focus → chevron). */
      if (ev.key === 'Escape') { __closeSplitPopover('escape'); }
    };
    /* Phase 8d-0 — menu keyboard navigation. Bound to the popover node so it
     * dies with the node on close (no duplicate-listener risk, no manual
     * removal). Enter / Space fall through to native <button> activation,
     * which fires the existing per-item click handler. */
    const onPopKeydown = function (ev) {
      const items = __splitPopoverItems(pop);
      if (!items.length) return;
      const cur = items.indexOf(document.activeElement);
      const key = ev.key;
      if (key === 'ArrowDown' || key === 'ArrowRight') {
        ev.preventDefault();
        __focusSplitItem(items, cur < 0 ? 0 : cur + 1);
      } else if (key === 'ArrowUp' || key === 'ArrowLeft') {
        ev.preventDefault();
        __focusSplitItem(items, cur < 0 ? items.length - 1 : cur - 1);
      } else if (key === 'Home') {
        ev.preventDefault();
        __focusSplitItem(items, 0);
      } else if (key === 'End') {
        ev.preventDefault();
        __focusSplitItem(items, items.length - 1);
      } else if (key === 'Tab') {
        /* Menu pattern: Tab exits the menu. Close and return to the
         * chevron rather than leaking into the end-of-body tab order
         * (the popover is mounted on document.body). */
        ev.preventDefault();
        __closeSplitPopover('tab');
      }
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown',  onDocKeydown,  true);
    pop.addEventListener('keydown', onPopKeydown);
    __openSplitPopover = {
      node: pop, trigger: triggerEl, kind: cfg.kind, container: __popoverContainer,
      onDocMouseDown: onDocMouseDown, onDocKeydown: onDocKeydown,
    };
    try { triggerEl.setAttribute('aria-expanded', 'true'); } catch (_) {}

    /* Phase 8d-0 — move focus into the menu (WAI-ARIA menu pattern): the
     * currently-checked pick if one is marked, else the first enabled item.
     * Roving tabindex is applied by __focusSplitItem. */
    const __navItems = __splitPopoverItems(pop);
    let __startIdx = 0;
    for (let __k = 0; __k < __navItems.length; __k += 1) {
      if (__navItems[__k].getAttribute('aria-checked') === 'true'
          || __navItems[__k].getAttribute('aria-pressed') === 'true') { __startIdx = __k; break; }
    }
    __focusSplitItem(__navItems, __startIdx);
  }

  function __buildSplitButton(cfg, actions, ctx) {
    const currentId = __resolveSplitCurrentId(cfg, actions);
    const currentAction = actions[currentId] || null;
    const anyAid = currentAction ? currentAction.id : Object.keys(actions)[0];
    const anyHandler = anyAid && ACTION_HANDLERS[anyAid];
    let enabled = false;
    if (anyHandler && typeof anyHandler.isEnabled === 'function') {
      try { enabled = !!anyHandler.isEnabled(ctx); } catch (_) { enabled = false; }
    }
    const wrap = el('div', { class: 'wbRibbonSplitBtn wbRibbonSplitBtn--' + cfg.kind });
    const main = el('button', {
      type: 'button',
      class: 'wbRibbonSplitBtn__main wbRibbonSplitBtn__main--' + cfg.kind,
      'data-action-id': currentAction ? currentAction.id : '',
      'aria-label': cfg.mainAriaLabel || (currentAction ? currentAction.label : ''),
      'aria-disabled': enabled ? 'false' : 'true',
      title: (cfg.mainAriaLabel || 'Apply') + (currentAction ? (' — ' + currentAction.label) : ''),
    });
    if (!enabled) main.setAttribute('disabled', 'disabled');
    /* Phase 8c-3 — icon kinds (Alignment) show the current action's 8b
     * glyph so the main button mirrors the last-picked alignment; Phase
     * 8d-1/8d-2 label-main kinds show a compact preview (cfg.previewText)
     * rendered in the current token via cfg.previewAttr — Font Family shows
     * "Aa" in the picked typeface (data-font); Font Size shows "A" at the
     * picked size (data-size); other kinds show their static config glyph. */
    if (cfg.labelMain) {
      const mainTok = cfg.tokenById && cfg.tokenById[currentId];
      if (cfg.previewAttr) {
        if (mainTok) { main.setAttribute(cfg.previewAttr, mainTok); }
        else { main.removeAttribute(cfg.previewAttr); }
      }
      main.textContent = cfg.previewText || '';
    } else if (cfg.iconFromActionIcons) {
      main.innerHTML = (currentAction && ACTION_ICONS[currentAction.id]) || cfg.glyphIcon || '';
    } else {
      main.innerHTML = cfg.glyphIcon || '';
    }
    if (cfg.hexById) {
      const swatch = el('span', { class: 'wbRibbonSplitBtn__swatch' });
      if (cfg.hexById[currentId]) {
        swatch.style.background = cfg.hexById[currentId];
      }
      main.appendChild(swatch);
    }
    /* Phase 8c-2 — main half applies the current action (e.g. the live
     * highlight brush). Dispatched directly because the main button is
     * not a .wbRibbonAction and so is outside the container delegation. */
    main.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (!enabled) return;
      const targetId = main.getAttribute('data-action-id');
      if (targetId) __dispatchSplitAction(targetId, main);
    });
    const chev = el('button', {
      type: 'button',
      class: 'wbRibbonSplitBtn__chevron wbRibbonSplitBtn__chevron--' + cfg.kind,
      'aria-label': cfg.chevronAriaLabel || 'Open',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'aria-disabled': enabled ? 'false' : 'true',
    });
    if (!enabled) chev.setAttribute('disabled', 'disabled');
    chev.innerHTML = CHEVRON_ICON;
    chev.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (!enabled) return;
      if (__openSplitPopover && __openSplitPopover.trigger === chev) {
        __closeSplitPopover();
        return;
      }
      __openSplitPopoverFor(cfg, actions, ctx, chev, function (picked) {
        try {
          main.setAttribute('data-action-id', picked.id);
          main.setAttribute('title', (cfg.mainAriaLabel || 'Apply') + ' — ' + picked.label);
          if (cfg.hexById) {
            const sw = main.querySelector('.wbRibbonSplitBtn__swatch');
            if (sw && cfg.hexById[picked.id]) {
              sw.style.background = cfg.hexById[picked.id];
            }
          }
          if (cfg.iconFromActionIcons && ACTION_ICONS[picked.id]) {
            main.innerHTML = ACTION_ICONS[picked.id];
          }
          if (cfg.labelMain) {
            const pickTok = cfg.tokenById && cfg.tokenById[picked.id];
            if (cfg.previewAttr) {
              if (pickTok) { main.setAttribute(cfg.previewAttr, pickTok); }
              else { main.removeAttribute(cfg.previewAttr); }
            }
            main.textContent = cfg.previewText || '';
          }
        } catch (_) {}
      });
    });
    wrap.appendChild(main);
    wrap.appendChild(chev);
    return wrap;
  }

  function buildPanels(shell, visibleTabs, activeTabId) {
    const panels = el('div', { class: 'wbRibbonPanels' });
    /* Phase 1b — context-aware enabled/disabled decision per action. */
    const ctx = shell.getContext();
    visibleTabs.forEach(function (tab) {
      const isActive = (tab.id === activeTabId);
      const panel = el('div', {
        class: 'wbRibbonPanel',
        role: 'tabpanel',
        id: 'wbRibbonPanel-' + tab.id,
        'aria-labelledby': 'wbRibbonTab-' + tab.id,
        tabindex: '0',
        'data-tab-id': tab.id,
        hidden: !isActive,
      });

      const groups = shell.groupsForTab(tab.id);
      Object.keys(groups).forEach(function (gid, idx, arr) {
        const group = groups[gid];
        const groupEl = el('div', { class: 'wbRibbonGroup', 'data-group-id': group.id });
        const actionsRow = el('div', { class: 'wbRibbonGroupActions' });
        const actions = shell.actionsForGroup(tab.id, group.id);
        /* Phase 8c — Split-button render. Whole-group palettes (Text
         * Color, Highlight) collapse the entire group into one split
         * button. Sub-group configs (Alignment, inside Paragraph) render
         * their split button in place of their first covered action and
         * leave the group's other actions to render individually. */
        const __splits = __splitConfigsForGroup(group.id);
        if (__splits.whole) {
          actionsRow.appendChild(__buildSplitButton(__splits.whole, actions, ctx));
        }
        Object.keys(actions).forEach(function (aid) {
          const action = actions[aid];
          if (__splits.whole) return;
          if (__splits.anchor[aid]) {
            const __subCfg = __splits.anchor[aid];
            const __subset = {};
            __subCfg.actionIds.forEach(function (id) {
              if (actions[id]) __subset[id] = actions[id];
            });
            actionsRow.appendChild(__buildSplitButton(__subCfg, __subset, ctx));
            return;
          }
          if (__splits.covered[aid]) return;
          if (tab.id === 'home' && action.id === 'refresh-reader') {
            const refreshButton = prepareRefreshButton(getRefreshButton());
            if (refreshButton) {
              actionsRow.appendChild(refreshButton);
            } else {
              actionsRow.appendChild(el('button', {
                type: 'button',
                class: 'wbRibbonAction wbRibbonRefreshAction',
                disabled: 'disabled',
                'aria-disabled': 'true',
                title: 'Refresh unavailable',
              }, action.label));
            }
            return;
          }
          if (tab.id === 'metadata' && action.id === 'system-status') {
            const parts = getSystemStatusParts();
            const pill = el('span', {
              class: 'wbRibbonAction wbRibbonMetadataAction wbRibbonMetadataStatusAction',
              role: 'status',
              'aria-live': 'polite',
              'data-ribbon-metadata-status': 'system',
              hidden: !parts.visible,
            });
            setMetadataButtonContent(pill, parts.label, parts.detail);
            actionsRow.appendChild(pill);
            return;
          }
          if (tab.id === 'metadata' && (action.id === 'category' || action.id === 'folder')) {
            const available = metadataControlIsAvailable(action.id);
            const attrs = {
              type: 'button',
              class: 'wbRibbonAction wbRibbonMetadataAction wbRibbonMetadataAction--' + action.id,
              'data-action-id': action.id,
              'aria-haspopup': 'dialog',
              'aria-expanded': metadataPopoverKind === action.id ? 'true' : 'false',
              'aria-disabled': available ? 'false' : 'true',
              title: available ? ('Edit ' + action.label.toLowerCase()) : (action.label + ' unavailable'),
            };
            if (!available) attrs.disabled = 'disabled';
            const btn = el('button', attrs);
            setMetadataButtonContent(
              btn,
              action.label,
              available
                ? (action.id === 'folder' ? getFolderDetail() : getCategoryDetail())
                : ''
            );
            actionsRow.appendChild(btn);
            return;
          }
          const handler = ACTION_HANDLERS[action.id];
          let enabled = false;
          if (handler && typeof handler.isEnabled === 'function') {
            try { enabled = !!handler.isEnabled(ctx); }
            catch (_) { enabled = false; }
          }
          let disabledTooltip = action.tooltip || '';
          if (!enabled && handler && typeof handler.disabledTooltip === 'function') {
            try { disabledTooltip = handler.disabledTooltip(ctx) || disabledTooltip; }
            catch (_) { /* keep catalogue tooltip */ }
          }
          /* Phase 6c — Text Color + Highlight swatches: CSS hides the visible
           * label (font-size:0) so we surface aria-label + a persistent title.
           * Phase 6e-1a clarifies highlight brush labels because the active
           * ring marks the next brush color, not selected-text formatting. */
          const isSwatchAction = typeof action.id === 'string' && (
            (action.id.indexOf('text-color-') === 0 && action.id !== 'text-color-none') ||
            action.id.indexOf('highlight-brush-') === 0
          );
          const isHighlightBrushAction = typeof action.id === 'string' &&
            action.id.indexOf('highlight-brush-') === 0;
          const swatchAccessibleLabel = isHighlightBrushAction
            ? ('Highlight brush: ' + action.label)
            : action.label;
          const attrs = {
            type: 'button',
            class: 'wbRibbonAction',
            'data-action-id': action.id,
            'aria-disabled': enabled ? 'false' : 'true',
          };
          if (isSwatchAction) {
            attrs['aria-label'] = swatchAccessibleLabel;
            /* Phase 6e-1 — Active state for Highlight brush only. Text
             * Color active state is deferred to 6e-2; mixed / inline
             * state to 6e-3. We mark the brush whose suffix matches
             * the current brush color (via the IHighlighter helper
             * that wraps H2O.Studio.store.highlights). Absence of
             * the attribute means "not pressed" — matches the
             * .wbSidebarNativeSwatch[aria-pressed="true"] idiom. */
            if (isHighlightBrushAction) {
              try {
                const ih = getIHighlighter();
                const cur = (ih && typeof ih.getCurrentColor === 'function')
                  ? String(ih.getCurrentColor() || '').trim().toLowerCase()
                  : '';
                if (cur && cur === action.id.slice('highlight-brush-'.length)) {
                  attrs['aria-pressed'] = 'true';
                }
              } catch (_) { /* leave unpressed */ }
            }
          }
          /* Phase 7a — Edit Mode toggle pressed state. Mirrors the 6e-1
           * aria-pressed idiom (absence of the attribute = "off"). The
           * Edit button is NOT a swatch action so this lives outside
           * the isSwatchAction branch. */
          if (action.id === 'edit-mode' && editMode) {
            attrs['aria-pressed'] = 'true';
          }
          /* Phase 8g-1 — Format Painter armed state reflects on re-render. */
          if (action.id === 'format-painter' && __formatPainterArmed) {
            attrs['aria-pressed'] = 'true';
          }
          if (enabled) {
            /* Drop the "Coming soon" placeholder tooltip when the action is
             * wired — except for Phase 6c swatches, where the label IS the
             * tooltip. */
            attrs.title = isSwatchAction ? swatchAccessibleLabel : '';
          } else {
            attrs.title = isHighlightBrushAction ? swatchAccessibleLabel : disabledTooltip;
            attrs.disabled = 'disabled';
          }
          const btn = el('button', attrs, action.label);
          /* Phase 8b — iconify existing wired Format-tab actions. Only
           * actions listed in ACTION_ICONS get the SVG treatment; all
           * others fall through unchanged (text pills for H1/H2/H3 /
           * Edit Mode / None / Clear / Hide / Annotate tags, compact
           * dots for 6c swatches). The action.label stays as the
           * accessible name (aria-label) + tooltip (title). No action
           * ID or handler is touched. */
          const iconSvg = ACTION_ICONS[action.id];
          if (iconSvg) {
            btn.classList.add('wbRibbonAction--icon');
            btn.setAttribute('aria-label', action.label);
            btn.setAttribute('title', action.label);
            btn.innerHTML = iconSvg;
          }
          actionsRow.appendChild(btn);
        });
        groupEl.appendChild(actionsRow);
        const groupLabel = el('div', { class: 'wbRibbonGroupLabel' }, group.label);
        groupEl.appendChild(groupLabel);
        panel.appendChild(groupEl);
        if (idx < arr.length - 1) {
          panel.appendChild(el('div', { class: 'wbRibbonSeparator', 'aria-hidden': 'true' }));
        }
      });

      panels.appendChild(panel);
    });
    return panels;
  }

  function syncTauriRibbonLayout(container, chatType, collapsed) {
    let root = null;
    let chrome = null;
    try {
      root = document.documentElement;
      if (!root || root.dataset.h2oRuntime !== 'tauri') return;
      chrome = document.getElementById('studioDesktopChrome');
    } catch (_) {
      return;
    }
    if (!chrome) return;

    const surface = chatType === 'library' ? 'library' : (chatType ? 'chat' : '');
    const hiddenByChrome =
      surface === 'library'
        ? chrome.getAttribute('data-library-ribbon-hidden') === 'true'
        : surface === 'chat'
          ? chrome.getAttribute('data-reader-ribbon-hidden') === 'true'
          : true;
    const expanded = !!(surface && !collapsed && !container.hidden && !hiddenByChrome);

    root.setAttribute('data-h2o-tauri-ribbon-surface', surface);
    root.setAttribute('data-h2o-tauri-ribbon-expanded', expanded ? 'true' : 'false');
    chrome.setAttribute('data-ribbon-surface', surface);
    chrome.setAttribute('data-ribbon-expanded', expanded ? 'true' : 'false');

    const writeHeight = function () {
      let height = 0;
      if (expanded) {
        const panels = container.querySelector('.wbRibbonPanels');
        const rect = panels && panels.getBoundingClientRect ? panels.getBoundingClientRect() : null;
        height = Math.max(0, Math.ceil((rect && rect.height) || 0));
      }
      const value = height + 'px';
      root.style.setProperty('--wb-tauri-ribbon-expanded-h', value);
      if (document.body && document.body.style) {
        document.body.style.setProperty('--wb-tauri-ribbon-expanded-h', value);
      }
      chrome.style.setProperty('--wb-tauri-ribbon-expanded-h', value);
    };

    writeHeight();
    try {
      const raf = window.requestAnimationFrame || function (fn) { return window.setTimeout(fn, 0); };
      raf(writeHeight);
    } catch (_) {}
  }

  /* ── Render orchestration ─────────────────────────────────────────── */
  function render(container, shell) {
    /* Phase 8c-2 — stash the live shell so split-button popovers can
     * dispatch with fresh context + re-render after a brush change. */
    __ribbonShell = shell;
    const ctx = shell.getContext();
    const contextChatType = (ctx && ctx.chatType) || null;
    const chatType = contextChatType;
    const collapsed = !!shell.getCollapsed();
    parkRefreshControl(container);
    parkMetadataControls(container);

    container.hidden = false;
    container.dataset.chatType = chatType || '';
    container.dataset.surface = chatType === 'library' ? 'library' : (chatType ? 'chat' : '');
    container.dataset.collapsed = collapsed ? 'true' : '';

    const visibleTabs = visibleTabsFor(chatType);
    if (!visibleTabs.length) {
      container.hidden = true;
      container.innerHTML = '';
      syncTauriRibbonLayout(container, null, true);
      return;
    }

    /* Resolve active tab: persisted -> first visible. */
    let activeTabId = shell.getActiveTab();
    const visibleIds = visibleTabs.map(function (t) { return t.id; });
    if (!activeTabId || visibleIds.indexOf(activeTabId) === -1) {
      activeTabId = visibleTabs[0].id;
      /* Update the shell so persistence reflects the resolved state. */
      shell.setActiveTab(activeTabId);
    }

    container.innerHTML = '';
    container.appendChild(buildTabStrip(visibleTabs, activeTabId, collapsed));
    if (!collapsed) {
      container.appendChild(buildPanels(shell, visibleTabs, activeTabId));
      if (activeTabId === 'metadata' && ctx && ctx.chatType === 'saved') {
        syncMetadataButtons(container);
      }
    }
    syncTauriRibbonLayout(container, chatType, collapsed);
  }

  function focusActiveTab(container) {
    const active = container.querySelector('.wbRibbonTab[aria-selected="true"]');
    if (active && typeof active.focus === 'function') {
      try { active.focus(); } catch (_) { /* swallow */ }
    }
  }

  /* ── Keyboard navigation on the tablist ───────────────────────────── */
  function bindKeyboard(container, shell) {
    container.addEventListener('keydown', function (ev) {
      const target = ev.target;
      if (!target || !target.classList || !target.classList.contains('wbRibbonTab')) return;

      const tabs = Array.prototype.slice.call(container.querySelectorAll('.wbRibbonTab'));
      const idx = tabs.indexOf(target);
      if (idx === -1) return;

      let nextIdx = -1;
      switch (ev.key) {
        case 'ArrowRight': nextIdx = (idx + 1) % tabs.length; break;
        case 'ArrowLeft':  nextIdx = (idx - 1 + tabs.length) % tabs.length; break;
        case 'Home':       nextIdx = 0; break;
        case 'End':        nextIdx = tabs.length - 1; break;
        default: return;
      }
      ev.preventDefault();
      const nextTab = tabs[nextIdx];
      const tabId = nextTab && nextTab.getAttribute('data-tab-id');
      if (tabId) {
        shell.setActiveTab(tabId);
        /* render() will rebuild; refocus the new tab after rebuild. */
      }
    });
  }

  /* ── Status feedback ──────────────────────────────────────────────────
   * In-ribbon status label between tab strip and collapse chevron. Phase
   * 1b uses this for Copy/Open action feedback because Studio does not
   * have a shared toast surface. Auto-clears after 2400ms unless
   * { persist: true }. Re-queries the element on each fire so a
   * mid-fade re-render (e.g. context change) does not crash the timer. */
  let statusFadeTimer = null;
  function makeSetStatus(container) {
    return function setStatus(text, opts) {
      const el = container.querySelector('.wbRibbonStatus');
      if (!el) return;
      el.textContent = String(text || '');
      if (statusFadeTimer) {
        try { clearTimeout(statusFadeTimer); } catch (_) { /* swallow */ }
        statusFadeTimer = null;
      }
      if (text && !(opts && opts.persist)) {
        statusFadeTimer = setTimeout(function () {
          try {
            const fresh = container.querySelector('.wbRibbonStatus');
            if (fresh) fresh.textContent = '';
          } catch (_) { /* swallow */ }
          statusFadeTimer = null;
        }, 2400);
      }
    };
  }

  /* ── Click handlers (tab switch + collapse toggle + wired actions) ─ */
  function bindClicks(container, shell) {
    const setStatus = makeSetStatus(container);
    container.addEventListener('click', function (ev) {
      const target = ev.target;
      if (!target || !target.closest) return;

      const popoverClose = target.closest('[data-metadata-popover-close]');
      if (popoverClose) {
        ev.preventDefault();
        parkMetadataControls(container);
        setStatus('Metadata options closed');
        return;
      }

      const collapseBtn = target.closest('[data-action="toggle-collapsed"]');
      if (collapseBtn) {
        ev.preventDefault();
        shell.setCollapsed(!shell.getCollapsed());
        return;
      }

      const tabBtn = target.closest('.wbRibbonTab');
      if (tabBtn) {
        const tabId = tabBtn.getAttribute('data-tab-id');
        if (tabId) {
          ev.preventDefault();
          shell.setActiveTab(tabId);
        }
        return;
      }

      /* Phase 1b — wired action handlers. The [disabled] attribute already
       * blocks clicks on placeholder actions at the browser level; we
       * defensively also check :not([disabled]) in the selector. */
      const actionBtn = target.closest('.wbRibbonAction:not([disabled])');
      if (actionBtn) {
        const actionId = actionBtn.getAttribute('data-action-id');
        const handler = actionId && ACTION_HANDLERS[actionId];
        if (handler && typeof handler.onClick === 'function') {
          ev.preventDefault();
          let ctx = null;
          try { ctx = shell.getContext(); } catch (_) { ctx = null; }
          try { handler.onClick(ctx, setStatus, actionBtn); }
          catch (e) {
            const msg = (e && (e.message || String(e))) || 'unknown error';
            setStatus('Action failed: ' + msg);
          }
          /* Phase 6e-1 — Highlight brush clicks change the active swatch.
           * The highlights-store subscription wired in init() normally
           * re-renders us synchronously via notifySubscribers; this
           * defensive call covers boot-race scenarios where the store
           * wasn't ready at subscribe time. render() is idempotent so
           * a double-render is harmless. */
          if (actionId.indexOf('highlight-brush-') === 0) {
            try { render(container, shell); } catch (_) { /* swallow */ }
          }
          safeEmit('evt:h2o:studio:ribbon:action-invoked', { action: actionId });
        }
        return;
      }
    });
    container.addEventListener('change', function (ev) {
      const target = ev.target;
      if (!target) return;
      if (target.id === 'categoryAssignSelect' || target.id === 'folderAssignSelect') {
        syncMetadataButtons(container);
        setTimeout(function () { syncMetadataButtons(container); }, 0);
      }
    });
  }

  /* ── Initialization ───────────────────────────────────────────────── */
  let initialized = false;
  function init() {
    if (initialized) return;
    const shell = getShell();
    if (!shell) return;
    const container = getContainer();
    if (!container) return;
    initialized = true;

    registerCatalogue(shell);

    bindKeyboard(container, shell);
    bindClicks(container, shell);

    /* Subscribe to shell events via the direct subscriber API. The global
     * H2O.events in the current Studio runtime exposes emit but not on, so
     * subscribing through that bus would silently no-op. shell.subscribe()
     * is the canonical channel for in-process listeners. */
    const evts = shell.events;
    if (typeof shell.subscribe === 'function') {
      shell.subscribe(function (evt) {
        const name = evt && evt.event;
        if (name === evts.contextChanged) {
          /* Phase 8g-1 — armed MESSAGE-LEVEL Format Painter applies to the next
           * target message (a turn different from the source), then disarms.
           * Inline-mode (8g-2a) ignores contextChanged — it applies on the next
           * button click to the held selection, so this path is message-only. */
          if (__formatPainterArmed && __formatPainterArmed.mode === 'message') {
            let nctx = null;
            try { nctx = shell.getContext(); } catch (_) { nctx = null; }
            const nTurn = nctx ? Number(nctx.selectedTurnIdx) : NaN;
            if (Number.isFinite(nTurn) && nTurn >= 1 && nTurn !== __formatPainterArmed.sourceTurnIdx) {
              const armed = __formatPainterArmed;
              /* Phase 8g-3a — capture sticky state + captured payload BEFORE the
               * upfront disarm, so a locked painter can re-arm on success and
               * keep painting the same formatting onto further target messages.
               * Failure/drift leaves it disarmed (no re-arm). */
              const wasSticky = !!armed.sticky, keepPayload = armed.payload, keepSrc = armed.sourceTurnIdx;
              __formatPainterDisarm();
              const fpStatus = makeSetStatus(container);
              const bridge = getRibbonBridge();
              if (bridge && typeof bridge.applyMessageFormatPaint === 'function') {
                fpStatus('Applying formatting…');
                Promise.resolve(bridge.applyMessageFormatPaint(nTurn, keepPayload)).then(
                  function (r) {
                    if (r && r.ok) {
                      if (wasSticky) __formatPainterEngage({ mode: 'message', payload: keepPayload, sourceTurnIdx: keepSrc, sticky: true }, fpStatus, null, r.reason === 'no-change' ? 'Formatting matched — select next target' : 'Formatting applied — select next target');
                      else fpStatus(r.reason === 'no-change' ? 'Formatting matched — no change' : 'Formatting applied');
                    } else fpStatus('Format paint failed: ' + ((r && r.reason) || 'unknown'));
                  },
                  function () { fpStatus('Format paint failed'); }
                );
              } else {
                fpStatus('Format Painter unavailable');
              }
            }
          }
          render(container, shell);
        } else if (name === evts.tabChanged) {
          render(container, shell);
          /* Move focus to the new active tab so arrow keys keep working. */
          focusActiveTab(container);
        } else if (name === evts.collapsedChanged) {
          render(container, shell);
        }
      });
    }

    /* Listen to prefs ready in case the shell hydrates active-tab/collapsed
     * asynchronously after the surface module renders. */
    try {
      const prefs = H2O.Studio && H2O.Studio.store && H2O.Studio.store.prefs;
      if (prefs && typeof prefs.subscribe === 'function') {
        prefs.subscribe(function (evt) {
          if (evt && evt.type === 'ready') render(container, shell);
        });
      }
    } catch (_) { /* swallow */ }

    /* Phase 6e-1 — Subscribe to the highlights store so the active brush
     * swatch ring follows external changes (S3H1a popup picker, keyboard
     * cycle, cross-tab). The store notifies synchronously after every
     * setCurrentColor / update / cross-tab event; we re-render
     * unconditionally — render() is cheap and idempotent. */
    try {
      const hs = H2O.Studio && H2O.Studio.store && H2O.Studio.store.highlights;
      if (hs && typeof hs.subscribe === 'function') {
        hs.subscribe(function (_evt) {
          try { render(container, shell); } catch (_) { /* swallow */ }
        });
      }
    } catch (_) { /* swallow */ }

    /* Initial paint. Until studio.js calls shell.setContext, the surface
     * renders the saved-chat ribbon as the desktop/list default. */
    render(container, shell);

    /* Mark the shell mounted (no-op in Phase 1a but emits 'ready'). */
    try { shell.mount(container); } catch (_) { /* swallow */ }
    safeEmit('evt:h2o:studio:ribbon:surface-ready', { phase: '1a' });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})(globalThis);
