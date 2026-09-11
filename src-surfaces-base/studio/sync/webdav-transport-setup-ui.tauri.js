/* W3.1.5L Desktop WebDAV setup UI.
 *
 * Product-grade setup card for the W3 real-transport descriptor resolver.
 * The card collects operator-entered WebDAV setup values and sends them to
 * Rust for private out-of-repo descriptor-registry storage. It does not run a
 * probe, does not call WebDAV/cloud/relay/CAS, does not enqueue, does not
 * create outbox/ledger/store rows, and does not flip productSyncReady or
 * transportReady.
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.sync = H2O.Studio.sync || {};
  if (H2O.Studio.sync.__realTransportWebDavSetupUiInstalled) return;

  var API = H2O.Studio.sync.realTransportWebDavSetupUi =
    H2O.Studio.sync.realTransportWebDavSetupUi || {};

  var ID = {
    card: 'wbRealTransportWebDavSetupCard',
    form: 'wbRealTransportWebDavSetupForm',
    serverUrl: 'wbRealTransportWebDavServerUrl',
    rootPath: 'wbRealTransportWebDavRootPath',
    credentialIdentifier: 'wbRealTransportWebDavCredentialIdentifier',
    credentialSecret: 'wbRealTransportWebDavCredentialSecret',
    credentialReveal: 'wbRealTransportWebDavCredentialReveal',
    credentialReady: 'wbRealTransportWebDavCredentialReady',
    credentialMessage: 'wbRealTransportWebDavCredentialMessage',
    rememberCredential: 'wbRealTransportWebDavRememberCredential',
    forgetCredential: 'wbRealTransportWebDavForgetCredential',
    endpointLabel: 'wbRealTransportWebDavEndpointLabel',
    remoteRootLabel: 'wbRealTransportWebDavRemoteRootLabel',
    credentialLabel: 'wbRealTransportWebDavCredentialLabel',
    confirmNonProduction: 'wbRealTransportWebDavConfirmNonProduction',
    confirmReadOnly: 'wbRealTransportWebDavConfirmReadOnly',
    confirmNoSacrificialWrite: 'wbRealTransportWebDavConfirmNoSacrificialWrite',
    saveBtn: 'wbRealTransportWebDavPrepareBtn',
    statusBtn: 'wbRealTransportWebDavStatusBtn',
    statusBadge: 'wbRealTransportWebDavStatusBadge',
    statusSummary: 'wbRealTransportWebDavStatusSummary',
    registryPathSource: 'wbRealTransportWebDavRegistryPathSource',
    writeGradeRegistryEligible: 'wbRealTransportWebDavWriteGradeRegistryEligible',
    registryFileOwner: 'wbRealTransportWebDavRegistryFileOwner',
    registryFilePrivate: 'wbRealTransportWebDavRegistryFilePrivate',
    registryParentOwner: 'wbRealTransportWebDavRegistryParentOwner',
    registryParentPrivate: 'wbRealTransportWebDavRegistryParentPrivate',
    registryOwnerOk: 'wbRealTransportWebDavRegistryOwnerOk',
    registryPermissionOk: 'wbRealTransportWebDavRegistryPermissionOk',
    writeGradeRegistryHash: 'wbRealTransportWebDavWriteGradeRegistryHash',
    writeGradeHashBoundary: 'wbRealTransportWebDavWriteGradeHashBoundary',
    privateContentHashAvailable: 'wbRealTransportWebDavPrivateContentHashAvailable',
    registryHash: 'wbRealTransportWebDavRegistryHash',
    jsonParses: 'wbRealTransportWebDavJsonParses',
    privateFields: 'wbRealTransportWebDavPrivateFields',
    credentialMaterialPresent: 'wbRealTransportWebDavCredentialMaterialPresent',
    credentialInputReceivedThisSave: 'wbRealTransportWebDavCredentialInputReceivedThisSave',
    credentialMaterialUpdatedThisSave: 'wbRealTransportWebDavCredentialMaterialUpdatedThisSave',
    endpointReady: 'wbRealTransportWebDavEndpointReady',
    reachableCandidate: 'wbRealTransportWebDavReachableCandidate',
    networkAttempted: 'wbRealTransportWebDavNetworkAttempted',
    writesWebDav: 'wbRealTransportWebDavWritesWebDav',
    productSyncReady: 'wbRealTransportWebDavProductSyncReady',
    transportReady: 'wbRealTransportWebDavTransportReady',
    endpointRefHash: 'wbRealTransportWebDavEndpointRefHash',
    remoteRootRefHash: 'wbRealTransportWebDavRemoteRootRefHash',
    credentialRefHash: 'wbRealTransportWebDavCredentialRefHash',
    blockers: 'wbRealTransportWebDavBlockers',
    desktopOnly: 'wbRealTransportWebDavDesktopOnly',
  };

  var SUBTAB_ID = 'wbRealTransportWebDavSetupSubtab';
  var CARD_STYLE = 'display:flex;flex-direction:column;gap:14px;padding:16px;border:1px solid rgba(96,165,250,.22);border-radius:8px;background:rgba(96,165,250,.04);margin:0;max-width:720px';
  var MUTED_STYLE = 'opacity:.72;font-size:12px;line-height:1.45';
  var LABEL_STYLE = 'display:flex;align-items:center;gap:6px;font-size:12px;font-weight:650;opacity:.84';
  var INFO_STYLE = 'display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:999px;border:1px solid rgba(255,255,255,.22);font-size:10px;line-height:1;opacity:.74;cursor:help';
  var BTN_STYLE = 'padding:8px 14px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:inherit;font:inherit;text-decoration:none;display:inline-block';
  var INPUT_STYLE = 'width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.18);color:inherit;font:inherit;font-size:13px';
  var GRID_STYLE = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px';
  var STATUS_GRID_STYLE = 'display:grid;grid-template-columns:minmax(170px,220px) minmax(0,1fr);gap:6px 14px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;min-width:0';
  var STATUS_VALUE_STYLE = 'min-width:0;white-space:normal;overflow-wrap:break-word;word-break:normal';
  var HASH_VALUE_STYLE = 'min-width:0;white-space:normal;overflow-wrap:anywhere;word-break:normal';
  var DEFAULT_ENDPOINT_DESCRIPTOR_LABEL = 'Non-production WebDAV endpoint';
  var DEFAULT_REMOTE_ROOT_DESCRIPTOR_LABEL = 'Non-production WebDAV folder';
  var DEFAULT_CREDENTIAL_DESCRIPTOR_LABEL = 'Non-production WebDAV credential';

  var state = {
    mounted: false,
    inFlight: false,
    lastStatus: null,
    draftDirty: false,
    credentialVisible: false,
    credentialSecretRemembered: false,
    statusRequestedOnMount: false,
    draft: {
      serverUrl: '',
      rootPath: '',
      credentialIdentifier: '',
      credentialSecret: '',
      endpointLabel: DEFAULT_ENDPOINT_DESCRIPTOR_LABEL,
      remoteRootLabel: DEFAULT_REMOTE_ROOT_DESCRIPTOR_LABEL,
      credentialLabel: DEFAULT_CREDENTIAL_DESCRIPTOR_LABEL,
      rememberCredential: false,
      confirmNonProduction: false,
      confirmReadOnly: false,
      confirmNoSacrificialWrite: false,
    },
  };

  var FIELD_KEYS = {};
  FIELD_KEYS[ID.serverUrl] = 'serverUrl';
  FIELD_KEYS[ID.rootPath] = 'rootPath';
  FIELD_KEYS[ID.credentialIdentifier] = 'credentialIdentifier';
  FIELD_KEYS[ID.credentialSecret] = 'credentialSecret';
  FIELD_KEYS[ID.endpointLabel] = 'endpointLabel';
  FIELD_KEYS[ID.remoteRootLabel] = 'remoteRootLabel';
  FIELD_KEYS[ID.credentialLabel] = 'credentialLabel';

  var CHECK_KEYS = {};
  CHECK_KEYS[ID.confirmNonProduction] = 'confirmNonProduction';
  CHECK_KEYS[ID.confirmReadOnly] = 'confirmReadOnly';
  CHECK_KEYS[ID.confirmNoSacrificialWrite] = 'confirmNoSacrificialWrite';
  CHECK_KEYS[ID.rememberCredential] = 'rememberCredential';

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function detectTauri() {
    try {
      if (global.__TAURI_INTERNALS__ && typeof global.__TAURI_INTERNALS__.invoke === 'function') return true;
      if (global.__TAURI__ && global.__TAURI__.core && typeof global.__TAURI__.core.invoke === 'function') return true;
      if (global.__TAURI__ && typeof global.__TAURI__.invoke === 'function') return true;
    } catch (_) { /* ignore */ }
    try {
      return !!(global.H2O && global.H2O.Studio && global.H2O.Studio.platform &&
        global.H2O.Studio.platform.env && global.H2O.Studio.platform.env.isTauri === true);
    } catch (_) {
      return false;
    }
  }

  function getInvoke() {
    try {
      if (global.__TAURI_INTERNALS__ && typeof global.__TAURI_INTERNALS__.invoke === 'function') {
        return global.__TAURI_INTERNALS__.invoke.bind(global.__TAURI_INTERNALS__);
      }
    } catch (_) { /* ignore */ }
    try {
      var tauri = global.__TAURI__;
      if (tauri && tauri.core && typeof tauri.core.invoke === 'function') return tauri.core.invoke.bind(tauri.core);
      if (tauri && typeof tauri.invoke === 'function') return tauri.invoke.bind(tauri);
    } catch (_) { /* ignore */ }
    return null;
  }

  function value(id) {
    var el = document.getElementById(id);
    if (el) return String(el.value || '').trim();
    var key = FIELD_KEYS[id];
    return key ? String(state.draft[key] || '').trim() : '';
  }

  function checked(id) {
    var el = document.getElementById(id);
    if (el) return !!el.checked;
    var key = CHECK_KEYS[id];
    return key ? !!state.draft[key] : false;
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value == null || value === '' ? '-' : String(value);
  }

  function shortHash(value) {
    var text = String(value || '');
    if (!/^sha256:[a-f0-9]{64}$/.test(text)) return text;
    return text.slice(0, 15) + '…' + text.slice(-8);
  }

  function yesNo(value) {
    if (value === true) return 'yes';
    if (value === false) return 'no';
    return '-';
  }

  function prop(object, first, second) {
    if (!object || typeof object !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(object, first)) return object[first];
    if (second && Object.prototype.hasOwnProperty.call(object, second)) return object[second];
    return undefined;
  }

  function captureDraftFromDom() {
    Object.keys(FIELD_KEYS).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) state.draft[FIELD_KEYS[id]] = String(el.value || '');
    });
    Object.keys(CHECK_KEYS).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) state.draft[CHECK_KEYS[id]] = !!el.checked;
    });
  }

  function applyDraftToDom() {
    Object.keys(FIELD_KEYS).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = String(state.draft[FIELD_KEYS[id]] || '');
    });
    Object.keys(CHECK_KEYS).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.checked = !!state.draft[CHECK_KEYS[id]];
    });
  }

  function setCredentialInputType() {
    var secret = document.getElementById(ID.credentialSecret);
    if (secret) secret.type = state.credentialVisible ? 'text' : 'password';
    var revealBtn = document.getElementById(ID.credentialReveal);
    if (revealBtn) {
      revealBtn.textContent = state.credentialVisible ? 'Hide' : 'Show';
      revealBtn.title = state.credentialVisible ? 'Hide password / token' : 'Show password / token';
      revealBtn.setAttribute('aria-pressed', state.credentialVisible ? 'true' : 'false');
    }
  }

  function draftValue(key, fallback) {
    var value = state.draft[key];
    return value == null || value === '' ? (fallback || '') : String(value);
  }

  function looksReservedInvalid(value) {
    var normalized = String(value || '').toLowerCase();
    return normalized.indexOf('reserved-invalid-domain') !== -1 ||
      normalized.indexOf('private.invalid') !== -1 ||
      /\.invalid(?::|\/|$)/.test(normalized);
  }

  function validation() {
    var missing = [];
    var hasDraftCredential = !!value(ID.credentialSecret);
    var hasSavedCredential = savedCredentialPresent();
    var rememberCredential = checked(ID.rememberCredential);
    if (!value(ID.serverUrl)) missing.push('Server URL is required.');
    if (!value(ID.rootPath)) missing.push('Folder / remote root is required.');
    if (!value(ID.credentialIdentifier)) missing.push('Username is required.');
    if (!rememberCredential) missing.push('Enable Remember credential to prepare WebDAV settings.');
    if (rememberCredential && !hasDraftCredential && !hasSavedCredential) missing.push('Password/token is required.');
    if (looksReservedInvalid(value(ID.serverUrl))) missing.push('Endpoint still looks like a placeholder.');
    if (!checked(ID.confirmNonProduction)) missing.push('Confirm this is a non-production endpoint.');
    if (!checked(ID.confirmReadOnly)) missing.push('Confirm read-only method safety.');
    if (!checked(ID.confirmNoSacrificialWrite)) missing.push('Confirm sacrificial write is not approved.');
    return { ok: missing.length === 0, missing: missing };
  }

  function infoIconHtml(text) {
    return '<span style="' + INFO_STYLE + '" title="' + esc(text || '') + '" aria-label="' + esc(text || '') + '">i</span>';
  }

  function fieldHtml(id, label, type, autocomplete, placeholder, info, defaultValue) {
    return ''
      + '<label style="display:flex;flex-direction:column;gap:5px;font-size:12px">'
      +   '<span style="' + LABEL_STYLE + '">' + esc(label) + infoIconHtml(info) + '</span>'
      +   '<input id="' + id + '" type="' + type + '" autocomplete="' + esc(autocomplete || 'off') + '" spellcheck="false"'
      +     ' placeholder="' + esc(placeholder || '') + '" value="' + esc(defaultValue || '') + '" style="' + INPUT_STYLE + '" />'
      + '</label>';
  }

  function credentialFieldHtml() {
    return ''
      + '<label style="display:flex;flex-direction:column;gap:5px;font-size:12px">'
      +   '<span style="' + LABEL_STYLE + '">Password / token' + infoIconHtml('Use an app-specific WebDAV password or token. When Remember is enabled, Desktop restores it locally into this masked field. It is never synced or written to WebDAV.') + '</span>'
      +   '<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;min-width:0">'
      +     '<input id="' + ID.credentialSecret + '" type="' + (state.credentialVisible ? 'text' : 'password') + '" autocomplete="current-password" spellcheck="false"'
      +       ' placeholder="" value="' + esc(draftValue('credentialSecret')) + '" style="' + INPUT_STYLE + ';min-width:0" />'
      +     '<button id="' + ID.credentialReveal + '" type="button" aria-pressed="' + (state.credentialVisible ? 'true' : 'false') + '" title="' + (state.credentialVisible ? 'Hide password / token' : 'Show password / token') + '" style="' + BTN_STYLE + ';padding:7px 12px;white-space:nowrap">' + (state.credentialVisible ? 'Hide' : 'Show') + '</button>'
      +   '</div>'
      +   '<span id="' + ID.credentialReady + '" style="' + MUTED_STYLE + '">Token required</span>'
      + '</label>';
  }

  function descriptorLabelValue(id, fallback) {
    return value(id) || fallback;
  }

  function checkboxHtml(id, label, info) {
    return ''
      + '<label style="display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:1.4;cursor:pointer">'
      +   '<input id="' + id + '" type="checkbox" style="margin-top:2px"' + (checked(id) ? ' checked' : '') + ' />'
      +   '<span style="display:flex;align-items:center;gap:6px">' + esc(label) + infoIconHtml(info) + '</span>'
      + '</label>';
  }

  function statusRowHtml(label, id) {
    return '<span style="opacity:.62">' + esc(label) + '</span><span id="' + id + '" style="' + STATUS_VALUE_STYLE + '">-</span>';
  }

  function hashRowHtml(label, id) {
    return '<span style="opacity:.62">' + esc(label) + '</span><span id="' + id + '" style="' + HASH_VALUE_STYLE + '">-</span>';
  }

  function savedCredentialPresent() {
    return !!(state.lastStatus && state.lastStatus.credentialMaterialPresent === true);
  }

  function hydrateDraftFromStatus(result) {
    if (!result || typeof result !== 'object' || state.draftDirty) return;
    var changed = false;
    function hydrateField(key, value) {
      if (typeof value !== 'string' || !value) return;
      if (state.draft[key] !== value) {
        state.draft[key] = value;
        changed = true;
      }
    }
    hydrateField('serverUrl', result.savedServerUrl);
    hydrateField('rootPath', result.savedRootPath);
    hydrateField('credentialIdentifier', result.savedCredentialIdentifier);
    if (result.credentialMaterialPresent === true && state.draft.rememberCredential !== true) {
      state.draft.rememberCredential = true;
      changed = true;
    }
    if (result.ok === true && result.requiredPrivateFieldsPresent === true) {
      ['confirmNonProduction', 'confirmReadOnly', 'confirmNoSacrificialWrite'].forEach(function (key) {
        if (state.draft[key] !== true) {
          state.draft[key] = true;
          changed = true;
        }
      });
    }
    if (changed) applyDraftToDom();
  }

  function credentialStatusMessage(result) {
    if (!result || typeof result !== 'object') return '-';
    if (result.credentialInputReceivedThisSave === true && result.credentialMaterialUpdatedThisSave === true) {
      return 'Credential updated for this prepare.';
    }
    if (result.credentialInputReceivedThisSave === true && result.credentialMaterialUpdatedThisSave === false) {
      return 'Credential received. Same as existing saved credential.';
    }
    if (result.credentialMaterialPresent === true) {
      return 'Existing saved credential used.';
    }
    return 'Credential has not been prepared.';
  }

  function buildCardHtml() {
    var desktop = detectTauri();
    return ''
      + '<section id="' + ID.card + '" class="wbSettingsCard" style="' + CARD_STYLE + '" aria-label="WebDAV transport setup">'
      +   '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">'
      +     '<div>'
      +       '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.62;font-weight:700">WebDAV Transport</div>'
      +       '<div style="font-weight:650;font-size:16px">Endpoint setup</div>'
      +       '<div style="' + MUTED_STYLE + '">Prepare resolver storage only. No probe, sync, enqueue, or write runs.</div>'
      +     '</div>'
      +     '<span id="' + ID.statusBadge + '" style="font-weight:650;padding:3px 8px;border-radius:5px;background:rgba(255,255,255,.06);font-size:12px">Not prepared</span>'
      +   '</div>'
      +   '<div id="' + ID.desktopOnly + '" style="' + MUTED_STYLE + ';' + (desktop ? 'display:none' : '') + '">Desktop Studio is required. Browser and extension surfaces keep this setup disabled until a compatible native resolver is available.</div>'
      +   '<form id="' + ID.form + '" style="display:flex;flex-direction:column;gap:12px;' + (desktop ? '' : 'opacity:.55;pointer-events:none') + '">'
      +     '<div style="' + GRID_STYLE + '">'
      +       fieldHtml(ID.serverUrl, 'Server URL', 'url', 'off', 'WebDAV URL', 'Use the same URL and Folder as the native extension. For Koofr, URL is usually https://app.koofr.net/dav/Koofr.', draftValue('serverUrl'))
      +       fieldHtml(ID.rootPath, 'Folder / remote root', 'text', 'off', 'H2O-Test', 'Use the same folder as the native extension, e.g. H2O. Use a non-production test folder for W3.1. Folder can be H2O-Test for this W3.1 setup.', draftValue('rootPath'))
      +     '</div>'
      +     '<div style="display:grid;grid-template-columns:minmax(220px,1fr);gap:10px">'
      +       fieldHtml(ID.credentialIdentifier, 'Username', 'text', 'username', 'Username or credential identifier', 'Use the username or credential identifier from the native extension WebDAV setup.', draftValue('credentialIdentifier'))
      +       credentialFieldHtml()
      +     '</div>'
      +     '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:2px 0 0">'
      +       checkboxHtml(ID.rememberCredential, 'Remember credential on this device', 'Stores and restores this token locally in Desktop only. It is not synced or written to WebDAV.')
      +       '<button id="' + ID.forgetCredential + '" type="button" style="' + BTN_STYLE + ';opacity:.55;cursor:not-allowed;padding:6px 10px;font-size:12px" disabled title="Future phase: safely forget the saved local credential">Forget credential</button>'
      +     '</div>'
      +     '<details style="border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:10px;background:rgba(255,255,255,.025)">'
      +       '<summary style="cursor:pointer;font-weight:650;font-size:13px">Advanced descriptor labels</summary>'
      +       '<div style="' + MUTED_STYLE + ';margin:6px 0 10px">These labels are generated for the private Rust resolver. Most operators should leave them unchanged.</div>'
      +       '<div style="' + GRID_STYLE + '">'
      +         fieldHtml(ID.endpointLabel, 'Endpoint descriptor label', 'text', 'off', DEFAULT_ENDPOINT_DESCRIPTOR_LABEL, 'Non-secret endpoint descriptor label used to derive endpointRefHash.', draftValue('endpointLabel', DEFAULT_ENDPOINT_DESCRIPTOR_LABEL))
      +         fieldHtml(ID.remoteRootLabel, 'Folder descriptor label', 'text', 'off', DEFAULT_REMOTE_ROOT_DESCRIPTOR_LABEL, 'Non-secret folder descriptor label used to derive remoteRootRefHash.', draftValue('remoteRootLabel', DEFAULT_REMOTE_ROOT_DESCRIPTOR_LABEL))
      +         fieldHtml(ID.credentialLabel, 'Credential descriptor label', 'text', 'off', DEFAULT_CREDENTIAL_DESCRIPTOR_LABEL, 'Non-secret credential descriptor label used to derive credentialRefHash. This is not a password hash.', draftValue('credentialLabel', DEFAULT_CREDENTIAL_DESCRIPTOR_LABEL))
      +       '</div>'
      +     '</details>'
      +     '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px;padding:10px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:rgba(0,0,0,.10)">'
      +       checkboxHtml(ID.confirmNonProduction, 'Non-production endpoint', 'Confirm this endpoint is safe for setup and is not production-critical data.')
      +       checkboxHtml(ID.confirmReadOnly, 'Read-only checks safe', 'Confirms future OPTIONS, PROPFIND, HEAD, and GET checks are acceptable. This button does not run them.')
      +       checkboxHtml(ID.confirmNoSacrificialWrite, 'No write approval', 'Sacrificial write is not approved in this step.')
      +     '</div>'
      +     '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      +       '<button id="' + ID.saveBtn + '" type="submit" style="' + BTN_STYLE + '" disabled>Save / Prepare</button>'
      +       '<button id="' + ID.statusBtn + '" type="button" style="' + BTN_STYLE + '">Status</button>'
      +       '<button type="button" style="' + BTN_STYLE + ';opacity:.55;cursor:not-allowed" disabled title="Future phase: read-only remote-root probe">Read-only probe</button>'
      +       '<button type="button" style="' + BTN_STYLE + ';opacity:.55;cursor:not-allowed" disabled title="Future phase: separately approved write">Write approval</button>'
      +       '<span id="' + ID.statusSummary + '" style="' + MUTED_STYLE + '">Fill all fields and confirmations to prepare resolver storage.</span>'
      +     '</div>'
      +     '<div id="' + ID.credentialMessage + '" style="' + MUTED_STYLE + '">Credential input is required before Save / Prepare.</div>'
      +   '</form>'
      +   '<div style="display:flex;flex-direction:column;gap:12px;min-width:0">'
      +     '<div style="border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:10px;background:rgba(255,255,255,.025)">'
      +       '<div style="font-weight:650;font-size:13px;margin-bottom:8px">Redacted readiness</div>'
      +       '<div style="' + STATUS_GRID_STYLE + '">'
      +         statusRowHtml('writeGradeRegistryRefHash', ID.writeGradeRegistryHash)
      +         statusRowHtml('hash boundary', ID.writeGradeHashBoundary)
      +         statusRowHtml('private content hash available', ID.privateContentHashAvailable)
      +         statusRowHtml('registry path source', ID.registryPathSource)
      +         statusRowHtml('write-grade registry eligible', ID.writeGradeRegistryEligible)
      +         statusRowHtml('registry owner ok', ID.registryOwnerOk)
      +         statusRowHtml('registry permission ok', ID.registryPermissionOk)
      +         statusRowHtml('registry file owner', ID.registryFileOwner)
      +         statusRowHtml('registry file private', ID.registryFilePrivate)
      +         statusRowHtml('registry parent owner', ID.registryParentOwner)
      +         statusRowHtml('registry parent private', ID.registryParentPrivate)
      +         statusRowHtml('JSON parses', ID.jsonParses)
      +         statusRowHtml('private fields', ID.privateFields)
      +         statusRowHtml('credential material present', ID.credentialMaterialPresent)
      +         statusRowHtml('credential received this prepare', ID.credentialInputReceivedThisSave)
      +         statusRowHtml('credential updated this prepare', ID.credentialMaterialUpdatedThisSave)
      +         statusRowHtml('endpoint ready', ID.endpointReady)
      +         statusRowHtml('reachable candidate', ID.reachableCandidate)
      +         statusRowHtml('networkAttempted', ID.networkAttempted)
      +         statusRowHtml('writesWebDAV', ID.writesWebDav)
      +         statusRowHtml('productSyncReady', ID.productSyncReady)
      +         statusRowHtml('transportReady', ID.transportReady)
      +       '</div>'
      +     '</div>'
      +     '<details style="border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:10px;background:rgba(255,255,255,.025)">'
      +       '<summary style="cursor:pointer;font-weight:650;font-size:13px">Advanced hash status</summary>'
      +       '<div style="' + STATUS_GRID_STYLE + ';margin-top:8px">'
      +         hashRowHtml('endpointRefHash', ID.endpointRefHash)
      +         hashRowHtml('remoteRootRefHash', ID.remoteRootRefHash)
      +         hashRowHtml('credentialRefHash', ID.credentialRefHash)
      +         '<span style="opacity:.62">blockers</span><span id="' + ID.blockers + '" style="' + STATUS_VALUE_STYLE + '">-</span>'
      +       '</div>'
      +     '</details>'
      +   '</div>'
      + '</section>';
  }

  function renderStatus(result) {
    state.lastStatus = result || null;
    hydrateDraftFromStatus(result);
    var ok = !!(result && result.ok);
    var badge = document.getElementById(ID.statusBadge);
    if (badge) {
      badge.textContent = ok ? 'Prepared' : 'Blocked';
      badge.style.background = ok ? 'rgba(34,197,94,.18)' : 'rgba(248,113,113,.18)';
    }
    setText(ID.statusSummary, ok ? 'Resolver registry is prepared. No probe or write was run.' : 'Resolver setup is blocked. Review required fields and confirmations.');
    setText(ID.writeGradeRegistryHash, shortHash(result && result.writeGradeRegistryRefHash));
    setText(ID.writeGradeHashBoundary, result && result.writeGradeRegistryHashBoundary);
    setText(ID.privateContentHashAvailable, yesNo(result && result.privateContentHashAvailable));
    setText(ID.registryHash, yesNo(result && result.privateContentHashAvailable));
    setText(ID.registryPathSource, result && result.registryPathSource);
    setText(ID.writeGradeRegistryEligible, yesNo(result && result.writeGradeRegistryEligible));
    setText(ID.registryOwnerOk, yesNo(result && result.registryOwnerOk));
    setText(ID.registryPermissionOk, yesNo(result && result.registryPermissionOk));
    setText(ID.registryFileOwner, yesNo(result && result.registryFileOwnerCurrentUser));
    setText(ID.registryFilePrivate, yesNo(result && result.registryFilePrivatePermissions));
    setText(ID.registryParentOwner, yesNo(result && result.registryParentOwnerCurrentUser));
    setText(ID.registryParentPrivate, yesNo(result && result.registryParentPrivatePermissions));
    setText(ID.jsonParses, yesNo(result && result.jsonParses));
    setText(ID.privateFields, yesNo(result && result.requiredPrivateFieldsPresent));
    setText(ID.credentialMaterialPresent, yesNo(result && result.credentialMaterialPresent));
    setText(ID.credentialInputReceivedThisSave, yesNo(result && result.credentialInputReceivedThisSave));
    setText(ID.credentialMaterialUpdatedThisSave, yesNo(result && result.credentialMaterialUpdatedThisSave));
    setText(ID.credentialMessage, credentialStatusMessage(result));
    setText(ID.endpointReady, yesNo(result && result.endpointNoLongerReservedInvalidDomain));
    setText(ID.reachableCandidate, yesNo(result && result.reachableCandidate));
    setText(ID.networkAttempted, yesNo(result && result.networkAttempted));
    setText(ID.writesWebDav, yesNo(prop(result, 'writesWebdav', 'writesWebDAV')));
    setText(ID.productSyncReady, yesNo(result && result.productSyncReady));
    setText(ID.transportReady, yesNo(result && result.transportReady));
    setText(ID.endpointRefHash, result && result.endpointRefHash);
    setText(ID.remoteRootRefHash, result && result.remoteRootRefHash);
    setText(ID.credentialRefHash, result && result.credentialRefHash);
    var blockers = result && Array.isArray(result.blockers) ? result.blockers : [];
    setText(ID.blockers, blockers.length ? blockers.join(', ') : '-');
  }

  function renderValidation() {
    var validationResult = validation();
    var save = document.getElementById(ID.saveBtn);
    var credentialReady = document.getElementById(ID.credentialReady);
    var revealBtn = document.getElementById(ID.credentialReveal);
    var hasCredential = !!value(ID.credentialSecret);
    var hasSavedCredential = savedCredentialPresent();
    var rememberCredential = checked(ID.rememberCredential);
    if (credentialReady) {
      credentialReady.textContent = hasCredential
        ? (rememberCredential
          ? (state.credentialSecretRemembered ? 'Credential remembered on this device' : 'Credential ready to save')
          : 'Enable remember to prepare')
        : (hasSavedCredential && rememberCredential ? 'Using saved credential' : 'Token required');
      credentialReady.style.opacity = hasCredential || hasSavedCredential ? '1' : '.72';
    }
    if (revealBtn) {
      revealBtn.disabled = !hasCredential;
      revealBtn.style.opacity = hasCredential ? '1' : '.55';
      revealBtn.style.cursor = hasCredential ? 'pointer' : 'not-allowed';
      revealBtn.title = hasCredential
        ? (state.credentialVisible ? 'Hide password / token' : 'Show password / token')
        : 'No token is loaded or typed.';
    }
    if (save) {
      save.disabled = state.inFlight || !validationResult.ok || !detectTauri();
      save.style.opacity = save.disabled ? '.55' : '1';
      save.style.cursor = save.disabled ? 'not-allowed' : 'pointer';
    }
    if (hasCredential && rememberCredential) {
      setText(ID.credentialMessage, state.credentialSecretRemembered
        ? 'Credential remembered on this device.'
        : 'Credential ready to save.');
    } else if (hasCredential && !rememberCredential) {
      setText(ID.credentialMessage, 'Enable Remember credential to prepare.');
    } else if (!hasCredential && hasSavedCredential && rememberCredential) {
      setText(ID.credentialMessage, 'Using saved credential.');
    } else if (!hasCredential && hasSavedCredential && !rememberCredential) {
      setText(ID.credentialMessage, 'Enable Remember credential to use the saved credential.');
    } else if (state.lastStatus) {
      setText(ID.credentialMessage, credentialStatusMessage(state.lastStatus));
    } else {
      setText(ID.credentialMessage, 'Token required.');
    }
    if (state.draftDirty) {
      setText(ID.statusSummary, validationResult.ok
        ? 'Draft ready. Save / Prepare updates private resolver storage only.'
        : 'Missing: ' + (validationResult.missing.join(' ') || 'Fill all required fields and confirmations.'));
    } else if (!state.lastStatus) {
      setText(ID.statusSummary, validationResult.ok
        ? 'Ready to prepare resolver storage. No probe or write will run.'
        : 'Missing: ' + (validationResult.missing.join(' ') || 'Fill all required fields and confirmations.'));
    }
  }

  async function invokeHydrateForm(statusResult) {
    if (!detectTauri() || state.draftDirty) return false;
    var invoke = getInvoke();
    if (!invoke) return false;
    var shouldRemember = checked(ID.rememberCredential) ||
      !!(statusResult && statusResult.credentialMaterialPresent === true);
    if (!shouldRemember) return false;
    try {
      var result = await invoke('h2o_rt_webdav_setup_hydrate_form', {
        request: {
          rememberCredential: true,
          desktopLocalUi: true,
        },
      });
      if (!result || result.ok !== true || typeof result.rememberedCredentialSecret !== 'string' || !result.rememberedCredentialSecret) {
        return false;
      }
      state.draft.serverUrl = typeof result.savedServerUrl === 'string' ? result.savedServerUrl : state.draft.serverUrl;
      state.draft.rootPath = typeof result.savedRootPath === 'string' ? result.savedRootPath : state.draft.rootPath;
      state.draft.credentialIdentifier = typeof result.savedCredentialIdentifier === 'string' ? result.savedCredentialIdentifier : state.draft.credentialIdentifier;
      state.draft.credentialSecret = result.rememberedCredentialSecret;
      state.draft.rememberCredential = true;
      state.credentialSecretRemembered = true;
      state.credentialVisible = false;
      applyDraftToDom();
      setCredentialInputType();
      renderValidation();
      return true;
    } catch (_) {
      return false;
    }
  }

  async function invokeStatus() {
    var invoke = getInvoke();
    if (!invoke) {
      renderStatus({ ok: false, blockers: ['desktop-tauri-invoke-unavailable'] });
      return;
    }
    state.inFlight = true;
    renderValidation();
    try {
      var result = await invoke('h2o_rt_webdav_setup_status');
      renderStatus(result);
      await invokeHydrateForm(result);
    } catch (_) {
      renderStatus({ ok: false, blockers: ['real-transport-webdav-setup-status-command-failed'] });
    } finally {
      state.inFlight = false;
      renderValidation();
    }
  }

  async function invokePrepare() {
    var validationResult = validation();
    if (!validationResult.ok) {
      renderValidation();
      return;
    }
    var invoke = getInvoke();
    if (!invoke) {
      renderStatus({ ok: false, blockers: ['desktop-tauri-invoke-unavailable'] });
      return;
    }
    state.inFlight = true;
    renderValidation();
    var submittedCredentialSecret = value(ID.credentialSecret);
    var submittedRememberCredential = checked(ID.rememberCredential);
    try {
      var result = await invoke('h2o_rt_prepare_webdav_setup', {
        request: {
          serverUrl: value(ID.serverUrl),
          rootPath: value(ID.rootPath),
          credentialIdentifier: value(ID.credentialIdentifier),
          credentialSecret: submittedCredentialSecret,
          endpointDescriptorLabel: descriptorLabelValue(ID.endpointLabel, DEFAULT_ENDPOINT_DESCRIPTOR_LABEL),
          remoteRootDescriptorLabel: descriptorLabelValue(ID.remoteRootLabel, DEFAULT_REMOTE_ROOT_DESCRIPTOR_LABEL),
          credentialDescriptorLabel: descriptorLabelValue(ID.credentialLabel, DEFAULT_CREDENTIAL_DESCRIPTOR_LABEL),
          confirmNonProduction: checked(ID.confirmNonProduction),
          confirmReadOnlySafe: checked(ID.confirmReadOnly),
          confirmSacrificialWriteNotApproved: checked(ID.confirmNoSacrificialWrite),
        },
      });
      var secret = document.getElementById(ID.credentialSecret);
      if (submittedRememberCredential && submittedCredentialSecret) {
        state.draft.credentialSecret = submittedCredentialSecret;
        state.credentialSecretRemembered = true;
      } else {
        if (secret) secret.value = '';
        state.draft.credentialSecret = '';
        state.credentialSecretRemembered = false;
      }
      state.credentialVisible = false;
      state.draftDirty = false;
      renderStatus(result);
      applyDraftToDom();
      setCredentialInputType();
    } catch (_) {
      renderStatus({ ok: false, blockers: ['real-transport-webdav-setup-prepare-command-failed'] });
    } finally {
      state.inFlight = false;
      renderValidation();
    }
  }

  function wireCard() {
    applyDraftToDom();
    var form = document.getElementById(ID.form);
    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        captureDraftFromDom();
        invokePrepare();
      });
      form.addEventListener('input', function (event) {
        captureDraftFromDom();
        if (event && event.target && event.target.id === ID.credentialSecret) {
          state.credentialSecretRemembered = false;
        }
        state.draftDirty = true;
        renderValidation();
      });
      form.addEventListener('change', function (event) {
        captureDraftFromDom();
        if (event && event.target && event.target.id === ID.credentialSecret) {
          state.credentialSecretRemembered = false;
        }
        if (event && event.target && event.target.id === ID.rememberCredential && !event.target.checked) {
          state.draft.credentialSecret = '';
          state.credentialSecretRemembered = false;
          state.credentialVisible = false;
          applyDraftToDom();
          setCredentialInputType();
        }
        state.draftDirty = true;
        renderValidation();
      });
    }
    var statusBtn = document.getElementById(ID.statusBtn);
    if (statusBtn) {
      statusBtn.addEventListener('click', function (event) {
        event.preventDefault();
        invokeStatus();
      });
    }
    var revealBtn = document.getElementById(ID.credentialReveal);
    if (revealBtn) {
      revealBtn.addEventListener('click', function (event) {
        event.preventDefault();
        captureDraftFromDom();
        if (!value(ID.credentialSecret)) return;
        state.credentialVisible = !state.credentialVisible;
        setCredentialInputType();
      });
    }
    renderValidation();
  }

  var activeObserver = null;

  function isWebDavSettingsRoute() {
    return String(global.location && global.location.hash || '').toLowerCase() === '#/settings/sync/webdav';
  }

  function mountIntoHost(host) {
    if (!host) return false;
    var panel = document.getElementById(SUBTAB_ID);
    if (panel && panel.parentElement === host && document.getElementById(ID.card)) {
      captureDraftFromDom();
      if (state.lastStatus) {
        renderStatus(state.lastStatus);
        try { global.setTimeout(function () { invokeHydrateForm(state.lastStatus); }, 0); } catch (_) { /* hydrate is best effort */ }
      }
      renderValidation();
      return true;
    }
    if (!panel) {
      panel = document.createElement('div');
      panel.id = SUBTAB_ID;
    }
    captureDraftFromDom();
    panel.innerHTML = buildCardHtml();
    host.appendChild(panel);
    wireCard();
    state.mounted = true;
    if (state.lastStatus) {
      renderStatus(state.lastStatus);
      try { global.setTimeout(function () { invokeHydrateForm(state.lastStatus); }, 0); } catch (_) { /* hydrate is best effort */ }
    }
    if (detectTauri() && !state.lastStatus && !state.statusRequestedOnMount) {
      state.statusRequestedOnMount = true;
      try { global.setTimeout(invokeStatus, 0); } catch (_) { /* status is best effort */ }
    }
    return true;
  }

  function tryMount() {
    try {
      if (!isWebDavSettingsRoute()) return false;
      var host = document.querySelector('#wbSettingsEmbeddedToolHost');
      if (!host) return false;
      if (document.getElementById(ID.card)) return true;
      return mountIntoHost(host);
    } catch (_) {
      return false;
    }
  }

  function installObserver() {
    if (activeObserver || typeof global.MutationObserver !== 'function') return;
    try {
      activeObserver = new global.MutationObserver(function () {
        tryMount();
      });
      activeObserver.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch (_) { /* keep Settings route resilient */ }
  }

  function bootstrap() {
    tryMount();
    installObserver();
    try { global.addEventListener('hashchange', tryMount); } catch (_) { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }

  API.diagnose = function () {
    return {
      installed: true,
      mounted: !!document.getElementById(ID.card),
      desktopRuntime: detectTauri(),
      commandSurface: !!getInvoke(),
      networkAttempted: false,
      writesWebDAV: false,
      productSyncReady: false,
      transportReady: false,
    };
  };

  API.captureDraft = function () {
    captureDraftFromDom();
    return true;
  };

  API.openSettingsSubtab = function () {
    var host = document.querySelector('#wbSettingsEmbeddedToolHost');
    if (!host) return false;
    return mountIntoHost(host);
  };

  /* M2 read-only domain facts. This calls only the local descriptor-registry
   * status command; it never probes or contacts WebDAV. Raw URLs, paths and
   * credential fields are deliberately omitted from the returned snapshot. */
  API.getReadinessFacts = async function () {
    var invoke = getInvoke();
    if (!invoke) {
      return Object.freeze({
        descriptorValid: false,
        credentialsReady: false,
        reachabilityReady: false,
        reason: 'desktop-tauri-invoke-unavailable',
        operation: Object.freeze({ state: 'blocked', reason: 'desktop-tauri-invoke-unavailable' })
      });
    }
    try {
      var result = await invoke('h2o_rt_webdav_setup_status');
      state.lastStatus = result || null;
      var descriptorValid = !!(result && result.writeGradeRegistryEligible === true &&
        result.registryOwnerOk === true && result.registryPermissionOk === true &&
        result.jsonParses === true && result.requiredPrivateFieldsPresent === true &&
        result.endpointRefHash && result.remoteRootRefHash && result.credentialRefHash);
      var credentialsReady = !!(result && result.credentialMaterialPresent === true);
      var reachabilityReady = !!(result && result.realWebdavTransportAvailable === true &&
        result.transportReady === true);
      var blockers = result && Array.isArray(result.blockers) ? result.blockers : [];
      return Object.freeze({
        descriptorValid: descriptorValid,
        credentialsReady: credentialsReady,
        reachabilityReady: reachabilityReady,
        reason: !descriptorValid
          ? String(blockers[0] || (result && result.reason) || 'descriptor-not-ready')
          : (!credentialsReady ? 'credentials-not-ready'
            : (!reachabilityReady ? 'webdav-reachability-not-verified' : '')),
        operation: Object.freeze({ state: 'idle', reason: '' })
      });
    } catch (_) {
      return Object.freeze({
        descriptorValid: false,
        credentialsReady: false,
        reachabilityReady: false,
        reason: 'real-transport-webdav-setup-status-command-failed',
        operation: Object.freeze({ state: 'error', reason: 'status-command-failed' })
      });
    }
  };

  H2O.Studio.sync.__realTransportWebDavSetupUiInstalled = true;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
