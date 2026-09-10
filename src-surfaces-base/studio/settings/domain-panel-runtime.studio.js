// Sync Settings M3 — deterministic presentation-only panel lifecycle.
//
// This registry owns mounted DOM and listener cleanup only. Domain modules
// declare which existing APIs they read/call and which existing persistence
// owner remains authoritative; registration never reads or mutates Sync state.
(() => {
  "use strict";

  const W = typeof globalThis !== "undefined" ? globalThis : window;
  const H2O = W.H2O = W.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.settings = H2O.Studio.settings || {};
  if (H2O.Studio.settings.domainPanels) return;

  const definitions = new Map();
  const scriptPromises = new Map();
  let active = null;
  let generation = 0;

  const clean = (value) => String(value == null ? "" : value).trim();
  const escapeHtml = (value) => clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  const boolText = (value) => value === true ? "Yes" : value === false ? "No" : "Not checked";
  const valueText = (value, fallback = "Not available") => clean(value) || fallback;

  function statusRows(rows) {
    return `<dl class="wbSettingsDomainStatus" style="display:grid;grid-template-columns:minmax(128px,max-content) minmax(0,1fr);gap:7px 16px;margin:0;font-size:13px">${
      (Array.isArray(rows) ? rows : []).map(([label, value]) =>
        `<dt style="opacity:.66">${escapeHtml(label)}</dt><dd style="margin:0;overflow-wrap:anywhere">${escapeHtml(valueText(value))}</dd>`
      ).join("")}</dl>`;
  }

  function card(title, body, options = {}) {
    return `<section class="wbSettingsCard"${options.id ? ` id="${escapeHtml(options.id)}"` : ""}${options.data ? ` ${options.data}` : ""} style="display:flex;flex-direction:column;gap:10px;padding:16px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.02);overflow:visible"><h3 style="margin:0;font-size:14px">${escapeHtml(title)}</h3>${body}</section>`;
  }

  function action(id, label, options = {}) {
    const disabled = options.disabled ? " disabled" : "";
    const danger = options.danger ? "border-color:rgba(248,113,113,.38);background:rgba(239,68,68,.12);" : "";
    return `<button type="button" data-domain-action="${escapeHtml(id)}"${disabled} style="padding:8px 12px;border-radius:8px;cursor:pointer;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.055);color:inherit;font:inherit;${danger}">${escapeHtml(label)}</button>`;
  }

  function link(path, label) {
    return `<a href="${escapeHtml(path)}" style="display:inline-flex;padding:8px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.14);color:inherit;text-decoration:none">${escapeHtml(label)}</a>`;
  }

  function frame(host, spec) {
    if (!host || typeof document === "undefined") throw new Error("settings-domain-panel-host-unavailable");
    const root = document.createElement("section");
    root.id = spec.panelId;
    root.className = "wbSettingsDomainPanel";
    root.dataset.settingsDomainPanel = spec.routeId;
    root.style.cssText = "display:flex;flex-direction:column;gap:12px;min-width:0;min-height:0;overflow:visible";
    root.innerHTML = `${spec.intro ? `<p style="margin:0;opacity:.72;font-size:12px;line-height:1.5">${escapeHtml(spec.intro)}</p>` : ""}<div data-domain-panel-body="1" style="display:flex;flex-direction:column;gap:12px;min-width:0;overflow:visible">${spec.body || ""}</div>`;
    host.replaceChildren(root);
    return root;
  }

  function listen(root, type, handler) {
    root.addEventListener(type, handler);
    return () => root.removeEventListener(type, handler);
  }

  function setBody(root, html) {
    const body = root?.querySelector?.('[data-domain-panel-body="1"]');
    if (body) body.innerHTML = html;
    return body;
  }

  function loadScriptOnce(src, ready) {
    if (typeof ready === "function" && ready()) return Promise.resolve(true);
    const key = clean(src);
    if (!key || typeof document === "undefined") return Promise.reject(new Error("settings-domain-script-unavailable"));
    if (scriptPromises.has(key)) return scriptPromises.get(key);
    const promise = new Promise((resolve, reject) => {
      const finish = () => typeof ready !== "function" || ready()
        ? resolve(true)
        : reject(new Error("settings-domain-script-api-missing"));
      const fail = () => reject(new Error("settings-domain-script-load-failed"));
      const existing = Array.from(document.scripts || []).find((node) =>
        clean(node.getAttribute?.("src") || node.src).endsWith(key));
      if (existing) {
        if (typeof ready === "function" && ready()) { resolve(true); return; }
        /* A script element that has already finished loading will never fire
         * load or error again, so waiting on it strands this promise forever —
         * and every caller that awaits it, which is how a failed readiness
         * check turns a live control into a dead one. Only wait when the
         * element can still report; otherwise fail closed now. */
        if (existing.dataset?.h2oSettingsModuleSettled === "1") {
          reject(new Error("settings-domain-script-api-missing"));
          return;
        }
        const settle = () => { try { existing.dataset.h2oSettingsModuleSettled = "1"; } catch (_) { /* ignore */ } };
        existing.addEventListener("load", () => { settle(); finish(); }, { once: true });
        existing.addEventListener("error", () => { settle(); fail(); }, { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = key;
      script.async = false;
      script.dataset.h2oSettingsModuleSrc = key;
      const markSettled = () => { try { script.dataset.h2oSettingsModuleSettled = "1"; } catch (_) { /* ignore */ } };
      script.addEventListener("load", () => { markSettled(); finish(); }, { once: true });
      script.addEventListener("error", () => { markSettled(); fail(); }, { once: true });
      (document.head || document.documentElement).appendChild(script);
    });
    scriptPromises.set(key, promise);
    promise.catch(() => scriptPromises.delete(key));
    return promise;
  }

  function register(spec) {
    if (!spec || !clean(spec.routeId) || !clean(spec.panelId) || typeof spec.mount !== "function") {
      throw new Error("settings-domain-panel-definition-invalid");
    }
    if (definitions.has(spec.routeId)) throw new Error("settings-domain-panel-route-duplicate");
    const authority = Object.freeze({
      displaySources: Object.freeze([...(spec.authority?.displaySources || [])]),
      actionApis: Object.freeze([...(spec.authority?.actionApis || [])]),
      persistenceOwners: Object.freeze([...(spec.authority?.persistenceOwners || [])]),
      createsAuthority: false,
      automaticOnMount: false,
    });
    definitions.set(spec.routeId, Object.freeze({ ...spec, authority }));
    return true;
  }

  async function unmount(reason = "route-change") {
    generation += 1;
    const prior = active;
    active = null;
    if (!prior) return false;
    try { await prior.cleanup?.(reason); } catch (_) { /* cleanup is best-effort and scoped */ }
    try {
      if (prior.host?.dataset?.settingsDomainPanelActive === prior.routeId) {
        delete prior.host.dataset.settingsDomainPanelActive;
      }
    } catch (_) { /* ignore detached host */ }
    return true;
  }

  async function mount(routeId, host, context = {}) {
    const definition = definitions.get(clean(routeId));
    if (!definition) throw new Error("settings-domain-panel-route-unregistered");
    if (active?.routeId === definition.routeId && active.host === host &&
        host?.dataset?.settingsDomainPanelActive === definition.routeId) {
      return true;
    }
    await unmount("route-change");
    const token = ++generation;
    const result = await definition.mount(host, Object.freeze({ ...context, routeId: definition.routeId }));
    const cleanup = typeof result === "function" ? result : result?.cleanup;
    if (token !== generation) {
      try { await cleanup?.("superseded"); } catch (_) { /* scoped cleanup */ }
      return false;
    }
    active = { routeId: definition.routeId, host, cleanup };
    host.dataset.settingsDomainPanelActive = definition.routeId;
    return true;
  }

  H2O.Studio.settings.domainPanels = Object.freeze({
    schema: "h2o.studio.settings.domain-panels.v1",
    register,
    mount,
    unmount,
    get: (routeId) => definitions.get(clean(routeId)) || null,
    list: () => Object.freeze(Array.from(definitions.values())),
    activeRouteId: () => active?.routeId || null,
    loadScriptOnce,
    view: Object.freeze({ clean, escapeHtml, boolText, valueText, statusRows, card, action, link, frame, listen, setBody }),
  });
})();
