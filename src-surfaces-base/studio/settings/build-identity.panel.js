/* Desktop build identity projection for Settings.
 *
 * The running native binary is the sole authority. This shared Studio module
 * renders only when the Tauri adapter positively identifies Desktop, keeps no
 * persistent state, and never substitutes extension metadata for a Desktop
 * checkpoint.
 */
(function installDesktopBuildIdentityPanel(global) {
  'use strict';

  const COMMAND = 'h2o_studio_desktop_build_identity';
  const SCHEMA = 'h2o.studio.desktop-build-identity.v1';
  const UNSTAMPED = 'UNSTAMPED';
  let identityPromise = null;

  function isDesktop() {
    return global.H2O?.Studio?.platform?.env?.isTauri === true;
  }

  function resolveInvoke() {
    const internals = global.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === 'function') return internals.invoke.bind(internals);
    const tauri = global.__TAURI__;
    if (tauri?.core && typeof tauri.core.invoke === 'function') return tauri.core.invoke.bind(tauri.core);
    if (tauri && typeof tauri.invoke === 'function') return tauri.invoke.bind(tauri);
    return null;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function normalizeIdentity(raw) {
    if (!raw || raw.schema !== SCHEMA) throw new Error('desktop-build-identity-invalid');
    const identity = {
      schema: SCHEMA,
      checkpoint: String(raw.checkpoint || '').trim(),
      sourceCommit: String(raw.sourceCommit || '').trim().toLowerCase(),
      builtAt: String(raw.builtAt || '').trim(),
      appVersion: String(raw.appVersion || '').trim(),
      architecture: String(raw.architecture || '').trim(),
      governed: raw.governed === true,
      executableSha256: String(raw.executableSha256 || '').trim().toLowerCase(),
      executableSha256Error: String(raw.executableSha256Error || '').trim(),
    };
    identity.stamped = identity.governed
      && /^[A-Z][A-Z0-9]*(?:[._-][A-Z0-9]+)*$/.test(identity.checkpoint)
      && identity.checkpoint !== UNSTAMPED
      && /^[0-9a-f]{40}$/.test(identity.sourceCommit)
      && identity.builtAt !== ''
      && identity.appVersion !== ''
      && identity.architecture !== '';
    return Object.freeze(identity);
  }

  function load() {
    if (!isDesktop()) return Promise.resolve(null);
    if (identityPromise) return identityPromise;
    const invoke = resolveInvoke();
    if (!invoke) return Promise.reject(new Error('desktop-build-identity-runtime-unavailable'));
    const attempt = Promise.resolve(invoke(COMMAND)).then(normalizeIdentity);
    const cachedAttempt = attempt.catch((error) => {
      if (identityPromise === cachedAttempt) identityPromise = null;
      throw error;
    });
    identityPromise = cachedAttempt;
    return identityPromise;
  }

  function badgeHtml() {
    if (!isDesktop()) return '';
    return `
      <div class="wbSettingsBuildIdentityBadge isLoading" data-h2o-desktop-build-badge="1" role="status" aria-live="polite">
        <span data-h2o-build-badge-title="1">Build identity loading…</span>
        <span class="wbSettingsBuildIdentityBadgeMeta" data-h2o-build-badge-meta="1"></span>
      </div>
    `;
  }

  function aboutHtml(cardStyle = '') {
    if (!isDesktop()) return '';
    const row = (label, field) => `
      <div class="wbSettingsBuildIdentityLabel">${escapeHtml(label)}</div>
      <div class="wbSettingsBuildIdentityValue" data-h2o-build-field="${escapeHtml(field)}">(loading…)</div>
    `;
    return `
      <section class="wbSettingsCard wbSettingsBuildIdentityCard" data-h2o-desktop-build-identity="1" style="${escapeHtml(cardStyle)}">
        <div class="wbSettingsBuildIdentityCardTitle">Desktop Build Identity</div>
        <div class="wbSettingsBuildIdentityGrid">
          ${row('Build Checkpoint', 'checkpoint')}
          ${row('Source Commit', 'sourceCommit')}
          ${row('App Version', 'appVersion')}
          ${row('Build Timestamp', 'builtAt')}
          ${row('Architecture', 'architecture')}
          ${row('Executable SHA-256', 'executableSha256')}
        </div>
        <div class="wbSettingsBuildIdentityActions">
          <button type="button" class="wbSettingsShellLink" data-h2o-copy-build-identity="1" disabled>Copy build identity</button>
          <span data-h2o-build-copy-status="1" aria-live="polite"></span>
        </div>
      </section>
    `;
  }

  function copyText(identity) {
    return [
      `Build Checkpoint: ${identity.stamped ? identity.checkpoint : 'UNSTAMPED BUILD'}`,
      `Source Commit: ${identity.sourceCommit || 'unavailable'}`,
      `App Version: ${identity.appVersion || 'unavailable'}`,
      `Build Timestamp: ${identity.builtAt || 'unavailable'}`,
      `Architecture: ${identity.architecture || 'unavailable'}`,
      `Executable SHA-256: ${identity.executableSha256 || identity.executableSha256Error || 'unavailable'}`,
    ].join('\n');
  }

  function setText(root, selector, value) {
    for (const node of root.querySelectorAll(selector)) node.textContent = value;
  }

  function renderIdentity(root, identity) {
    const title = identity.stamped ? `🔴 BUILD ${identity.checkpoint}` : '🔴 UNSTAMPED BUILD';
    const shortCommit = identity.sourceCommit ? identity.sourceCommit.slice(0, 12) : 'commit unavailable';
    const meta = [shortCommit, identity.appVersion && `v${identity.appVersion}`, identity.architecture]
      .filter(Boolean)
      .join(' · ');
    for (const badge of root.querySelectorAll('[data-h2o-desktop-build-badge="1"]')) {
      badge.classList.remove('isLoading');
      badge.classList.toggle('isUnstamped', !identity.stamped);
    }
    setText(root, '[data-h2o-build-badge-title="1"]', title);
    setText(root, '[data-h2o-build-badge-meta="1"]', meta);
    const fields = {
      checkpoint: identity.stamped ? identity.checkpoint : 'UNSTAMPED BUILD',
      sourceCommit: identity.sourceCommit || 'unavailable',
      appVersion: identity.appVersion || 'unavailable',
      builtAt: identity.builtAt || 'unavailable',
      architecture: identity.architecture || 'unavailable',
      executableSha256: identity.executableSha256 || identity.executableSha256Error || 'unavailable',
    };
    for (const [field, value] of Object.entries(fields)) {
      setText(root, `[data-h2o-build-field="${field}"]`, value);
    }
    for (const button of root.querySelectorAll('[data-h2o-copy-build-identity="1"]')) {
      button.disabled = false;
      if (button.dataset.buildIdentityBound === '1') continue;
      button.dataset.buildIdentityBound = '1';
      button.addEventListener('click', async () => {
        const status = button.parentElement?.querySelector?.('[data-h2o-build-copy-status="1"]');
        try {
          await global.navigator.clipboard.writeText(copyText(identity));
          if (status) status.textContent = 'Copied.';
        } catch (_) {
          if (status) status.textContent = 'Copy failed.';
        }
      });
    }
  }

  function renderFailure(root) {
    for (const badge of root.querySelectorAll('[data-h2o-desktop-build-badge="1"]')) {
      badge.classList.remove('isLoading');
      badge.classList.add('isUnstamped');
    }
    setText(root, '[data-h2o-build-badge-title="1"]', '🔴 UNSTAMPED BUILD');
    setText(root, '[data-h2o-build-badge-meta="1"]', 'Native build identity unavailable');
    setText(root, '[data-h2o-build-field]', 'unavailable');
  }

  async function hydrate(root = global.document) {
    if (!isDesktop() || !root?.querySelectorAll) return null;
    try {
      const identity = await load();
      renderIdentity(root, identity);
      return identity;
    } catch (error) {
      renderFailure(root);
      return Object.freeze({ ok: false, errorCode: String(error?.message || error) });
    }
  }

  global.H2O = global.H2O || {};
  global.H2O.Studio = global.H2O.Studio || {};
  global.H2O.Studio.settingsBuildIdentity = Object.freeze({
    aboutHtml,
    badgeHtml,
    copyText,
    hydrate,
    load,
    normalizeIdentity,
  });
})(window);
