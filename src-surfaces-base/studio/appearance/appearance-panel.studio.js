/* H2O Studio — Appearance Panel (top-right options menu)
 *
 * Owns the visible UI: a top-right trigger button mounted into the Tauri
 * desktop ribbon menu strip when present, otherwise into the .wbTop header,
 * and a popover panel (Theme / Typography / Reading / Options).
 *
 * Subscribes to H2O.Studio.appearance for state and calls .set() to update.
 * The panel is appended to document.body (matches the .wbCmdBar /
 * .wbSidebarNativeMenu / .ho-emoji-picker pattern) so it isn't constrained
 * by .wbStage's stacking context (isolation:isolate).
 *
 * Loads AFTER appearance-store.studio.js so it can call into the store.
 * Defers mounting until DOMContentLoaded.
 *
 * Contracts: src-surfaces-base/studio/STUDIO_DEVELOPMENT_RULES.md
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  if (H2O.Studio.appearance && H2O.Studio.appearance.__panelInstalled) return;
  if (!H2O.Studio.appearance || typeof H2O.Studio.appearance.subscribe !== 'function') {
    try { console.warn('[H2O.Studio.appearance.panel] store not installed; skipping panel'); } catch (_) {}
    return;
  }

  var store = H2O.Studio.appearance;
  var BOUNDS = store.bounds;

  /* ── DOM refs (filled in mount) ────────────────────────────────────── */
  var triggerBtn = null;
  var panelEl = null;
  var openState = false;
  var controlRefs = {};   /* logicalKey -> { update: fn(value) } */
  var unsubscribe = null;
  var rehomeObserver = null;
  var rehomePending = false;

  /* ── Tiny DOM helpers ──────────────────────────────────────────────── */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.indexOf('data-') === 0 || k === 'role' || k === 'aria-label' || k === 'aria-pressed' || k === 'aria-expanded' || k === 'aria-haspopup' || k === 'aria-modal' || k === 'aria-labelledby' || k === 'type' || k === 'title' || k === 'id' || k === 'hidden' || k === 'tabindex') {
          if (v === false || v == null) return;
          node.setAttribute(k, v === true ? '' : String(v));
        } else {
          node.setAttribute(k, String(v));
        }
      });
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null) return;
        if (typeof c === 'string') node.appendChild(document.createTextNode(c));
        else node.appendChild(c);
      });
    }
    return node;
  }

  /* ── Trigger button (mounted into desktop menu strip or .wbTop) ───── */
  var TRIGGER_SVG = '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">'
    + '<circle cx="5" cy="12" r="1.6"/>'
    + '<circle cx="12" cy="12" r="1.6"/>'
    + '<circle cx="19" cy="12" r="1.6"/>'
    + '</svg>';

  function makeRibbonTopSlot(bar) {
    if (!bar) return null;
    var slot = bar.querySelector('[data-role="appearance-menu-actions"]');
    if (slot) return slot;
    slot = el('div', {
      class: 'wbRibbonTopActions',
      'data-role': 'appearance-menu-actions',
      'aria-label': 'Ribbon menu actions',
    });
    var collapse = bar.querySelector('.wbRibbonCollapse');
    bar.insertBefore(slot, collapse || null);
    return slot;
  }

  function getVisibleRibbonBar() {
    var bars = document.querySelectorAll('.wbRibbon:not([hidden]) .wbRibbonBar');
    for (var i = 0; i < bars.length; i += 1) {
      if (bars[i] && bars[i].getClientRects && bars[i].getClientRects().length) {
        return bars[i];
      }
    }
    return bars[0] || null;
  }

  function isTauriReaderRoute() {
    return !!(
      document.documentElement &&
      document.documentElement.dataset &&
      document.documentElement.dataset.h2oRuntime === 'tauri' &&
      document.body &&
      document.body.dataset &&
      document.body.dataset.route === 'reader'
    );
  }

  function getTopbarTriggerSlot() {
    var topbar = document.querySelector('.wbTop');
    if (!topbar) return null;
    var slot = topbar.querySelector('.wbTopGroup--actions');
    if (!slot) {
      slot = el('div', { class: 'wbTopGroup wbTopGroup--actions' });
      topbar.appendChild(slot);
    }
    return slot;
  }

  function getTriggerSlot() {
    var librarySlot = document.querySelector('[data-role="library-ribbon-actions"]');
    var isLibraryRoute = document.body && document.body.dataset && document.body.dataset.route === 'library';
    if (librarySlot && isLibraryRoute) return librarySlot;

    if (isTauriReaderRoute()) {
      var readerTopbarSlot = getTopbarTriggerSlot();
      if (readerTopbarSlot) return readerTopbarSlot;
    }

    var ribbonBar = getVisibleRibbonBar();
    if (ribbonBar) return makeRibbonTopSlot(ribbonBar);

    if (librarySlot) return librarySlot;

    return getTopbarTriggerSlot();
  }

  function mountTrigger() {
    var slot = getTriggerSlot();
    if (!slot) return false;
    /* Idempotency: don't double-mount on re-render. */
    if (slot.querySelector('.wbAppearanceBtn')) {
      triggerBtn = slot.querySelector('.wbAppearanceBtn');
      return true;
    }
    if (!triggerBtn) triggerBtn = document.querySelector('.wbAppearanceBtn');
    if (!triggerBtn) {
      triggerBtn = el('button', {
        type: 'button',
        class: 'wbIconBtn wbIconBtn--topbar wbAppearanceBtn',
        'aria-label': 'Appearance and view options',
        title: 'Appearance',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        'aria-pressed': 'false',
        html: TRIGGER_SVG,
      });
      triggerBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        toggle();
      });
    }
    slot.appendChild(triggerBtn);
    if (openState) position();
    return true;
  }

  function scheduleTriggerRehome() {
    if (rehomePending) return;
    rehomePending = true;
    setTimeout(function () {
      rehomePending = false;
      mountTrigger();
    }, 0);
  }

  function installTriggerRehomeWatcher() {
    if (rehomeObserver || !document.body || typeof MutationObserver !== 'function') return;
    rehomeObserver = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        var r = records[i];
        if (r && r.type === 'attributes' && r.attributeName === 'data-route') {
          scheduleTriggerRehome();
          return;
        }
        if (!r || !r.addedNodes || !r.addedNodes.length) continue;
        for (var j = 0; j < r.addedNodes.length; j += 1) {
          var node = r.addedNodes[j];
          if (!node || node.nodeType !== 1) continue;
          if ((node.classList && (node.classList.contains('wbRibbonBar') || node.classList.contains('wbRibbon'))) ||
              (node.matches && node.matches('[data-role="library-ribbon-actions"]')) ||
              (node.querySelector && (node.querySelector('.wbRibbonBar') || node.querySelector('[data-role="library-ribbon-actions"]')))) {
            scheduleTriggerRehome();
            return;
          }
        }
      }
    });
    rehomeObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-route'] });
  }

  /* ── Panel construction ────────────────────────────────────────────── */
  function makeSegmented(opts) {
    /* opts: { logicalKey, label, options: [{ value, label }] } */
    var group = el('div', { class: 'wbAppearanceSegmented', role: 'group', 'aria-label': opts.label });
    var buttons = [];
    opts.options.forEach(function (option) {
      var btn = el('button', {
        type: 'button',
        class: 'wbAppearanceSegmentedBtn',
        'data-value': option.value,
        'aria-pressed': 'false',
      }, option.label);
      btn.addEventListener('click', function () { store.set(opts.logicalKey, option.value); });
      buttons.push(btn);
      group.appendChild(btn);
    });
    controlRefs[opts.logicalKey] = {
      update: function (value) {
        buttons.forEach(function (b) {
          var on = b.getAttribute('data-value') === String(value);
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      },
    };
    return group;
  }

  function makeStepper(opts) {
    /* opts: { logicalKey, label, format, bounds } */
    var bounds = opts.bounds;
    var minus = el('button', {
      type: 'button',
      class: 'wbAppearanceStepperBtn',
      'aria-label': opts.label + ' decrease',
      title: 'Decrease',
    }, '−');
    var plus = el('button', {
      type: 'button',
      class: 'wbAppearanceStepperBtn',
      'aria-label': opts.label + ' increase',
      title: 'Increase',
    }, '+');
    var valueEl = el('span', { class: 'wbAppearanceStepperValue', 'aria-live': 'polite' }, '');
    var group = el('div', { class: 'wbAppearanceStepper', role: 'group', 'aria-label': opts.label }, [minus, valueEl, plus]);
    function step(delta) {
      var current = Number(store.get(opts.logicalKey));
      var next = current + delta * bounds.step;
      store.set(opts.logicalKey, next);
    }
    minus.addEventListener('click', function () { step(-1); });
    plus.addEventListener('click', function () { step(1); });
    controlRefs[opts.logicalKey] = {
      update: function (value) {
        var n = Number(value);
        valueEl.textContent = opts.format ? opts.format(n) : String(n);
        minus.disabled = n <= bounds.min;
        plus.disabled = n >= bounds.max;
      },
    };
    return group;
  }

  function makeToggle(opts) {
    /* opts: { logicalKey, label, hint? } */
    var track = el('span', { class: 'wbAppearanceSwitchTrack', 'aria-hidden': 'true' }, el('span', { class: 'wbAppearanceSwitchThumb' }));
    var labelText = el('span', { class: 'wbAppearanceRowLabel' }, opts.label);
    var hintText = opts.hint ? el('span', { class: 'wbAppearanceRowHint' }, opts.hint) : null;
    var labelCol = el('span', { class: 'wbAppearanceRowText' }, hintText ? [labelText, hintText] : [labelText]);
    var btn = el('button', {
      type: 'button',
      class: 'wbAppearanceRow wbAppearanceRow--toggle',
      role: 'switch',
      'aria-checked': 'false',
    }, [labelCol, track]);
    btn.addEventListener('click', function () { store.set(opts.logicalKey, !store.get(opts.logicalKey)); });
    controlRefs[opts.logicalKey] = {
      update: function (value) {
        var on = !!value;
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
      },
    };
    return btn;
  }

  /* M04 P2 T4 (HDA decision D) — Presentation row. The options are the
   * Renderer's registered profiles, read from
   * H2O.Studio.Renderer.presentationProfile.list() HERE, at row construction
   * (the panel builds its controls lazily on first open; this module itself
   * installs before the Renderer registry scripts evaluate). Only profile.id
   * (value) and profile.displayName (label) are used; the panel registers,
   * validates and resolves nothing. When the registry is unexpectedly
   * unavailable the row is omitted and the rest of the panel is untouched. */
  function makePresentationRow() {
    var options = [];
    try {
      var registry = H2O.Studio.Renderer && H2O.Studio.Renderer.presentationProfile;
      var profiles = registry && typeof registry.list === 'function' ? registry.list() : null;
      for (var i = 0; profiles && i < profiles.length; i += 1) {
        var profile = profiles[i];
        if (!profile || typeof profile.id !== 'string' || !profile.id) continue;
        options.push({
          value: profile.id,
          label: typeof profile.displayName === 'string' && profile.displayName ? profile.displayName : profile.id,
        });
      }
    } catch (_) { options = []; }
    if (!options.length) return null;
    var segmented = makeSegmented({
      logicalKey: 'presentationProfile',
      label: 'Presentation',
      options: options,
    });
    return el('div', { class: 'wbAppearanceRow' }, [
      el('span', { class: 'wbAppearanceRowText' }, [
        el('span', { class: 'wbAppearanceRowLabel' }, 'Presentation'),
        el('span', { class: 'wbAppearanceRowHint' }, 'Reader presentation profile'),
      ]),
      segmented,
    ]);
  }

  function makeSection(title, body) {
    return el('section', { class: 'wbAppearanceSection' }, [
      el('h3', { class: 'wbAppearanceSectionTitle' }, title),
      el('div', { class: 'wbAppearanceSectionBody' }, body),
    ]);
  }

  function mountPanel() {
    if (panelEl) return;
    panelEl = el('div', {
      class: 'wbAppearancePanel',
      role: 'dialog',
      'aria-label': 'Appearance and view options',
      'aria-modal': 'false',
      hidden: true,
    });

    var header = el('header', { class: 'wbAppearanceHead' }, [
      el('div', { class: 'wbAppearanceTitle' }, 'Appearance'),
      el('button', {
        type: 'button',
        class: 'wbAppearanceClose',
        'aria-label': 'Close',
        title: 'Close',
      }, '×'),
    ]);
    header.querySelector('.wbAppearanceClose').addEventListener('click', close);

    /* THEME */
    var themeRow = makeSegmented({
      logicalKey: 'theme',
      label: 'Theme',
      options: [
        { value: 'light', label: 'Light' },
        { value: 'dark',  label: 'Dark'  },
        { value: 'sepia', label: 'Sepia' },
      ],
    });

    /* TYPOGRAPHY */
    var typographyRow = makeSegmented({
      logicalKey: 'typography',
      label: 'Typography',
      options: [
        { value: 'sans',  label: 'Sans'  },
        { value: 'serif', label: 'Serif' },
        { value: 'mono',  label: 'Mono'  },
      ],
    });

    /* READING — font size */
    var fontSizeStepper = makeStepper({
      logicalKey: 'fontSize',
      label: 'Font size',
      bounds: BOUNDS.fontSize,
      format: function (n) { return String(n) + 'px'; },
    });
    var fontSizeRow = el('div', { class: 'wbAppearanceRow wbAppearanceRow--stepper' }, [
      el('span', { class: 'wbAppearanceRowText' }, [
        el('span', { class: 'wbAppearanceRowLabel' }, 'Font size'),
        el('span', { class: 'wbAppearanceRowHint' }, 'Adjusts text size across Studio'),
      ]),
      fontSizeStepper,
    ]);

    /* READING — text width */
    var widthStepper = makeStepper({
      logicalKey: 'contentWidth',
      label: 'Text width',
      bounds: BOUNDS.contentWidth,
      format: function (n) { return String(n) + 'rem'; },
    });
    var widthRow = el('div', { class: 'wbAppearanceRow wbAppearanceRow--stepper' }, [
      el('span', { class: 'wbAppearanceRowText' }, [
        el('span', { class: 'wbAppearanceRowLabel' }, 'Text width'),
        el('span', { class: 'wbAppearanceRowHint' }, 'Reader column max width'),
      ]),
      widthStepper,
    ]);

    /* READING — presentation profile (M04 P2 T4; omitted when unavailable) */
    var presentationRow = makePresentationRow();
    var readingRows = presentationRow ? [fontSizeRow, widthRow, presentationRow] : [fontSizeRow, widthRow];

    /* OPTIONS */
    var foldersToggle = makeToggle({
      logicalKey: 'showFolders',
      label: 'Show folders tree',
      hint: 'Folders section in the sidebar',
    });
    var notesToggle = makeToggle({
      logicalKey: 'showNotes',
      label: 'Show Recents',
      hint: 'Recents section in the sidebar',
    });
    var plainToggle = makeToggle({
      logicalKey: 'plainText',
      label: 'Show plain text',
      hint: 'Drop highlight and wash colors in the reader',
    });

    var optionsChildren = [foldersToggle, notesToggle, plainToggle];

    /* Always on top — Tauri only. Hidden entirely on MV3/web so we don't
     * fake a system behavior the platform layer can't deliver. */
    if (store.alwaysOnTopAvailable()) {
      var aotToggle = makeToggle({
        logicalKey: 'alwaysOnTop',
        label: 'Always stay on top',
        hint: 'Keep the Studio window above other apps',
      });
      optionsChildren.push(aotToggle);
    }

    var body = el('div', { class: 'wbAppearanceBody' }, [
      makeSection('Theme', themeRow),
      makeSection('Typography', typographyRow),
      makeSection('Reading', readingRows),
      makeSection('Options', optionsChildren),
    ]);

    panelEl.appendChild(header);
    panelEl.appendChild(body);

    document.body.appendChild(panelEl);

    /* Sync controls to current state. */
    syncAll();

    /* Re-sync on store changes. */
    unsubscribe = store.subscribe(function (ev) {
      if (ev.type === 'ready' || ev.type === 'change') syncAll();
    });

    /* Close on outside click / Escape / window resize. */
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onDocKeyDown);
    window.addEventListener('resize', position);
  }

  function syncAll() {
    Object.keys(controlRefs).forEach(function (k) {
      try { controlRefs[k].update(store.get(k)); } catch (_) {}
    });
  }

  function onDocMouseDown(ev) {
    if (!openState) return;
    if (!panelEl || !triggerBtn) return;
    var target = ev.target;
    if (panelEl.contains(target) || triggerBtn.contains(target)) return;
    close();
  }

  function onDocKeyDown(ev) {
    if (!openState) return;
    if (ev.key === 'Escape') { ev.preventDefault(); close(); }
  }

  /* ── Position panel under the trigger ──────────────────────────────── */
  function position() {
    if (!panelEl || !triggerBtn) return;
    var rect = triggerBtn.getBoundingClientRect();
    var panelWidth = 320;
    var gap = 8;
    var right = Math.max(gap, window.innerWidth - rect.right);
    var top = Math.round(rect.bottom + gap);
    /* Clamp width and vertical fit. */
    panelEl.style.right = right + 'px';
    panelEl.style.top = top + 'px';
    panelEl.style.left = 'auto';
    panelEl.style.maxWidth = (window.innerWidth - 2 * gap) + 'px';
    panelEl.style.maxHeight = (window.innerHeight - top - gap) + 'px';
    panelEl.style.width = Math.min(panelWidth, window.innerWidth - 2 * gap) + 'px';
  }

  function open() {
    if (openState) return;
    if (!panelEl) mountPanel();
    if (!panelEl) return;
    openState = true;
    panelEl.removeAttribute('hidden');
    triggerBtn.setAttribute('aria-expanded', 'true');
    triggerBtn.setAttribute('aria-pressed', 'true');
    triggerBtn.classList.add('is-on');
    /* Re-sync each open in case the state changed via another path. */
    syncAll();
    position();
  }

  function close() {
    if (!openState) return;
    openState = false;
    if (panelEl) panelEl.setAttribute('hidden', '');
    if (triggerBtn) {
      triggerBtn.setAttribute('aria-expanded', 'false');
      triggerBtn.setAttribute('aria-pressed', 'false');
      triggerBtn.classList.remove('is-on');
    }
  }

  function toggle() { openState ? close() : open(); }

  /* ── Boot ──────────────────────────────────────────────────────────── */
  function bootMount() {
    installTriggerRehomeWatcher();
    if (mountTrigger()) return true;
    return false;
  }

  function whenReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  whenReady(function () {
    if (!bootMount()) {
      /* The .wbTop header may render later (e.g. dynamic shell). Retry on
       * the next animation frame for a brief window. */
      var tries = 0;
      var tickId = setInterval(function () {
        tries += 1;
        if (bootMount() || tries > 30) clearInterval(tickId);
      }, 100);
    }
  });

  H2O.Studio.appearance.__panelInstalled = true;
  H2O.Studio.appearance.panel = {
    open: open,
    close: close,
    toggle: toggle,
    isOpen: function () { return openState; },
  };
})(typeof window !== 'undefined' ? window : this);
