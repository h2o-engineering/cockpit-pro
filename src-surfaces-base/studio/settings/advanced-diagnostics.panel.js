// Sync Settings M4 — advanced, redacted diagnostics over existing authorities.
(() => {
  "use strict";
  const W = typeof globalThis !== "undefined" ? globalThis : window;
  const panels = W.H2O?.Studio?.settings?.domainPanels;
  if (!panels) return;
  const V = panels.view;

  const count = (value) => Array.isArray(value) ? value.length
    : Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const shortHash = (value) => {
    const clean = V.clean(value);
    return /^[0-9a-f]{64}$/i.test(clean) ? `${clean.slice(0, 12)}…` : "Not available";
  };

  function projectIdentity(diagnostic) {
    const value = diagnostic || {};
    const authority = value.authority || {};
    return Object.freeze({
      status: V.valueText(value.status, "unavailable"),
      desktop: authority.desktop === true,
      ready: authority.ready === true,
      canonical: authority.canonical === true,
      backend: V.valueText(authority.backend, "unavailable"),
      authorityStatus: V.valueText(authority.status, "unavailable"),
      fingerprintShort: shortHash(authority.sqliteFingerprintSha256Hex),
      copiesMatch: authority.copiesMatch === true,
      rows: Object.freeze([
        ["Identity", V.valueText(value.status, "unavailable")],
        ["Backend", V.valueText(authority.backend, "unavailable")],
        ["Authority", authority.ready === true && authority.canonical === true ? "Canonical" : "Not canonical"],
        ["Authority status", V.valueText(authority.status, "unavailable")],
        ["SQLite fingerprint", shortHash(authority.sqliteFingerprintSha256Hex)],
        ["Copies match", authority.copiesMatch === true ? "Yes" : "No / not applicable"],
      ]),
    });
  }

  function projectLineage(result) {
    const value = result || {};
    if (value.ok !== true) return Object.freeze({
      state: "blocked",
      currentRevisionId: null,
      previousRevisionId: null,
      pendingRevisionId: null,
      chain: Object.freeze([]),
      reason: V.valueText(value.errorCode, "Not read"),
    });
    return Object.freeze({
      state: V.valueText(value.state, "empty"),
      currentRevisionId: V.clean(value.currentRevisionId) || null,
      previousRevisionId: V.clean(value.previousRevisionId) || null,
      pendingRevisionId: V.clean(value.pendingRevisionId) || null,
      chain: Object.freeze(Array.isArray(value.chain) ? value.chain.map(V.clean).filter(Boolean) : []),
      reason: "None",
    });
  }

  function projectRelay(outbox, inbox, index) {
    const out = outbox || {};
    const input = inbox || {};
    const ledger = index || {};
    return Object.freeze({
      outbox: Number(out.counts?.rows) || count(out.rows),
      inbox: Number(input.counts?.rows) || count(input.rows),
      index: Number(ledger.counts?.total) || count(ledger.entries),
      blockers: count(out.blockers) + count(input.blockers) + count(ledger.blockers),
    });
  }

  function projectAutomaticReconcile(diagnostic) {
    const value = diagnostic || {};
    const result = value.lastResult || {};
    const lastReason = V.clean(value.lastReason);
    const verdict = V.clean(result.verdict);
    const errorCode = V.clean(result.errorCode);
    let summary = verdict || (lastReason ? "No result" : "Not run");
    if (errorCode) summary += ` — ${errorCode}`;
    if (lastReason) summary += ` — reason: ${lastReason}`;
    return Object.freeze({ lastReason, verdict, errorCode, summary });
  }

  function redactedCopyPayload(model) {
    const value = model || {};
    const identity = value.identity || {};
    const foundation = value.foundation || {};
    const local = value.localFolder || {};
    const browser = value.browserDelivery || {};
    const webdav = value.webdav || {};
    const relay = value.relay || {};
    const lineage = value.lineage || {};
    return Object.freeze({
      schema: "h2o.studio.sync.advanced-diagnostics.redacted.v1",
      platform: V.valueText(value.platform, "unknown"),
      foundation: Object.freeze({
        backend: V.valueText(foundation.persistentBackend?.backend, "unavailable"),
        backendReady: foundation.persistentBackend?.ready === true,
        canonicalAuthorityReady: foundation.canonicalAuthority?.ready === true &&
          foundation.canonicalAuthority?.canonical === true,
        canonicalAuthorityStatus: V.valueText(foundation.canonicalAuthority?.status, "unavailable"),
      }),
      identity: Object.freeze({
        status: V.valueText(identity.status, "unavailable"),
        backend: V.valueText(identity.backend, "unavailable"),
        canonical: identity.canonical === true,
        authorityStatus: V.valueText(identity.authorityStatus, "unavailable"),
        fingerprintShort: V.valueText(identity.fingerprintShort, "Not available"),
      }),
      localFolder: Object.freeze({
        configured: local.configured === true,
        authorized: local.authorized === true,
        reason: V.valueText(local.reason || local.authorizationStatus, "None"),
      }),
      browserDelivery: Object.freeze({
        connected: browser.connected === true,
        permission: V.valueText(browser.permission, "not checked"),
        ready: browser.ready === true,
        reason: V.valueText(browser.reason, "None"),
      }),
      webdav: Object.freeze({
        ready: webdav.ready === true,
        reason: V.valueText(webdav.reason, "None"),
        operation: V.valueText(webdav.operation?.state, "idle"),
      }),
      relay: Object.freeze({
        outbox: Number(relay.outbox) || 0,
        inbox: Number(relay.inbox) || 0,
        index: Number(relay.index) || 0,
        blockers: Number(relay.blockers) || 0,
      }),
      lineage: Object.freeze({
        state: V.valueText(lineage.state, "not-read"),
        currentRevisionId: lineage.currentRevisionId || null,
        previousRevisionId: lineage.previousRevisionId || null,
        pendingRevisionId: lineage.pendingRevisionId || null,
        chain: Object.freeze(Array.isArray(lineage.chain) ? [...lineage.chain] : []),
        reason: V.valueText(lineage.reason, "None"),
      }),
    });
  }

  /* P02 V7 governed format-gate ceremony.
   *
   * This surface is an INVOCATION path only. Both commands below are the
   * existing governed Rust authority: the resolver derives the destination and
   * the deterministic `h2o-object-sync` child, and the ceremony writer owns
   * campaign-token validation, operator authorization, P01 quiescence evidence,
   * the N.2 legacy baseline, collision checks, the atomic write and verify-only
   * replay. Nothing here re-implements, relaxes or second-guesses any of it:
   * the panel renders what Rust returns and refuses to construct a request the
   * resolver has not already authorized.
   */
  const P02_RESOLVE_COMMAND = "h2o_p02_resolve_repository_root";
  const P02_ACTIVATE_COMMAND = "h2o_p02_activate_format_gate";
  const P02_CHILD_NAME = "h2o-object-sync";
  const P02_AUTHORITY_FILE = "library.info.json";

  function resolveInvoke() {
    const internals = W.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === "function") return internals.invoke.bind(internals);
    const tauri = W.__TAURI__;
    if (tauri?.core && typeof tauri.core.invoke === "function") return tauri.core.invoke.bind(tauri.core);
    if (tauri && typeof tauri.invoke === "function") return tauri.invoke.bind(tauri);
    return null;
  }

  const leafOf = (value) => {
    const parts = V.clean(value).replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || "";
  };

  /* Projection only. The resolver stays the sole authority for the target: the
   * container identity is carried through verbatim so activation can echo it
   * back for the native equality check, and there is no editable alternative. */
  function projectP02Target(target) {
    if (!target) {
      return Object.freeze({
        resolved: false,
        containerPathSha256Hex: "",
        repositoryRootExists: false,
        authorityPresent: false,
        rows: Object.freeze([["Resolver", "Not run"]]),
      });
    }
    const leaf = V.clean(target.destinationFolderLeafName) || leafOf(target.containerPath);
    const authorityPresent = target.authorityPresent === true;
    const rootExists = target.repositoryRootExists === true;
    return Object.freeze({
      resolved: true,
      containerPathSha256Hex: V.clean(target.containerPathSha256Hex).toLowerCase(),
      repositoryRootExists: rootExists,
      authorityPresent,
      rows: Object.freeze([
        ["Resolver", "Derived by the native production resolver"],
        ["Configured folder", V.valueText(leaf, "unavailable")],
        ["Container identity", shortHash(target.containerPathSha256Hex)],
        ["Repository root", leaf ? `${leaf}/${P02_CHILD_NAME}` : P02_CHILD_NAME],
        ["Repository root exists", rootExists ? "Yes" : "No"],
        [P02_AUTHORITY_FILE, authorityPresent ? "Present" : "Absent"],
        ["Classification", authorityPresent
          ? "Format authority present"
          : (rootExists ? "Repository root without authority" : "P02 repository absent")],
      ]),
    });
  }

  function projectP02Receipt(receipt) {
    if (!receipt) {
      return Object.freeze({ present: false, verdict: "", replay: false, rows: Object.freeze([["Activation", "Not run"]]) });
    }
    const verdict = V.clean(receipt.verdict);
    const baseline = (Array.isArray(receipt.legacyBaseline) ? receipt.legacyBaseline : [])
      .map((item) => `${V.clean(item?.path)}: ${item?.present === true ? shortHash(item?.sha256) : "absent"}`)
      .join(" · ");
    const entries = Array.isArray(receipt.repositoryEntries) ? receipt.repositoryEntries.map(V.clean).filter(Boolean) : [];
    return Object.freeze({
      present: true,
      verdict,
      replay: verdict === "activation-verified-replay",
      rows: Object.freeze([
        ["Native verdict", V.valueText(verdict, "unavailable")],
        ["Outcome", verdict === "activation-verified-replay" ? "Verify-only replay — nothing was rewritten"
          : (verdict === "activation-created" ? "Format authority created" : "Unrecognised native verdict")],
        ["Authority digest", shortHash(receipt.authoritySha256Hex)],
        ["Authority bytes", Number.isSafeInteger(receipt.authorityByteLength) ? String(receipt.authorityByteLength) : "unavailable"],
        ["Repository entries", entries.length ? entries.join(", ") : "none"],
        ["V8 artifacts present", receipt.v8ArtifactsPresent === true ? "Yes" : "No"],
        ["N.2 legacy baseline", baseline || "none observed"],
      ]),
    });
  }

  /* Fail-closed request construction. Every rejection is a safe classification
   * with no operator-supplied material in it, and anything this cannot prove
   * locally is still left for the native command to refuse. */
  function buildActivateRequest(input) {
    const source = input || {};
    const target = source.target || null;
    const blocked = (blocker) => Object.freeze({ ok: false, blocker, request: null });
    if (!target || target.resolved !== true) return blocked("p02-resolve-required");
    const containerPathSha256Hex = V.clean(target.containerPathSha256Hex).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(containerPathSha256Hex)) return blocked("p02-resolver-container-identity-unavailable");
    const governedCampaign = V.clean(source.governedCampaign);
    if (!governedCampaign) return blocked("p02-governed-campaign-token-required");
    const operatorAuthorization = V.clean(source.operatorAuthorization);
    if (!operatorAuthorization) return blocked("p02-operator-authorization-required");
    if (source.p01WriterQuiesced !== true) return blocked("p02-p01-writer-quiescence-attestation-required");
    const activatedByWriterSyncPeerId = V.clean(source.activatedByWriterSyncPeerId);
    if (!activatedByWriterSyncPeerId) return blocked("p02-canonical-writer-identity-unavailable");
    const activatedAt = V.clean(source.activatedAt);
    if (!activatedAt) return blocked("p02-activation-timestamp-unavailable");
    /* Exactly the frozen request shape: the native struct denies unknown fields. */
    return Object.freeze({
      ok: true,
      blocker: "",
      request: Object.freeze({
        governedCampaign,
        operatorAuthorization,
        p01WriterQuiesced: true,
        activatedAt,
        activatedByWriterSyncPeerId,
        expectedContainerPathSha256Hex: containerPathSha256Hex,
      }),
    });
  }

  /* P02 V8 governed first-writer publication.
   *
   * The surface owns no protocol decision. Eligibility, selection binding,
   * revision bytes, ordering, recovery and the write window all belong to the
   * production chain reached through the V8-D adapter; this section only
   * sequences the operator ceremony and renders what the chain returns.
   *
   * Two rules shape everything below. Titles are presentation only: they let a
   * person tell candidates apart and never reach a selection key, a result
   * message or any governance evidence. And Arm performs no mutation at all -
   * only Confirm may invoke the governed Execute operation.
   */
  const P02_V8_MODULE_URL = "/sync/sync-first-publication-desktop-v2.tauri.mjs";

  function projectV8Candidates(prepared) {
    const value = prepared || {};
    const preparation = value.preparation || {};
    const list = Array.isArray(preparation.candidates) ? preparation.candidates : [];
    /* Read only what the enumeration actually publishes. An earlier version
     * counted `enumeration.objectIds`, which is internal to the enumerator and
     * is a Set, so it silently rendered 0 for every possible input. Both fields
     * below are public frozen arrays of the returned contract. */
    const enumeration = value.enumeration || {};
    const described = Array.isArray(enumeration.descriptors) ? enumeration.descriptors.length : 0;
    const blocked = Array.isArray(enumeration.blockedObjects) ? enumeration.blockedObjects.length : 0;
    return Object.freeze({
      ready: list.length > 0,
      candidates: Object.freeze(list.map((candidate) => Object.freeze({
        selectionKey: V.clean(candidate?.selectionKey),
        label: V.clean(candidate?.presentation?.label) || "(untitled)",
        shortObjectId: V.clean(candidate?.presentation?.shortObjectId),
      }))),
      rows: [
        ["Eligible candidates", String(list.length)],
        /* Every object the enumeration considered: those it could describe plus
         * those it refused to describe. */
        ["Objects examined", String(described + blocked)],
        ["Objects described", String(described)],
        ["Blocked objects", String(blocked)],
        /* C2 refuses to default; the operator must choose. */
        ["Default selection", "None \u2014 selection is explicit"],
      ],
    });
  }

  function projectV8Plan(planned) {
    const value = planned || {};
    const publication = value.publication || {};
    const repository = value.repository || {};
    const root = publication.previousRevisionId === null &&
      publication.previousRevisionBlobSha256 === null;
    return Object.freeze({
      ready: !!V.clean(publication.revisionId),
      rows: [
        ["Object domain", V.valueText(publication.objectDomain, "None")],
        ["Object key", shortHash(publication.objectKey)],
        ["Revision ID", V.valueText(publication.revisionId, "None")],
        ["Revision blob", shortHash(publication.revisionBlobSha256)],
        ["Payload", shortHash(publication.payloadSha256)],
        ["Ancestry", root ? "Root \u2014 first P02 revision of this object" : "Descendant"],
        ["Repository root", shortHash(repository.containerPathSha256Hex)],
        ["Format authority", repository.authorityPresent === true ? "Present" : "Absent"],
      ],
    });
  }

  function classification(label, description) {
    return `<p style="margin:0;font-size:11px;letter-spacing:.055em;text-transform:uppercase;color:#a5b4fc">${V.escapeHtml(label)}</p><p style="margin:0;opacity:.68;font-size:12px;line-height:1.45">${V.escapeHtml(description)}</p>`;
  }

  panels.register({
    routeId: "settings.sync-new.advanced",
    panelId: "h2o-settings-advanced-diagnostics-panel",
    authority: {
      displaySources: [
        "H2O.Studio.sync.getReadinessSnapshot",
        "H2O.Studio.sync.folder.getReadinessSnapshot",
        "H2O.Studio.identity.diagnose",
        "H2O.Desktop.SyncObjectDelivery.diagnose",
        "h2o_p02_resolve_repository_root (native V7 resolver, read-only)",
        "H2O.Studio.sync.item9Delivery.diagnose",
        "H2O.Studio.sync.objectAutoReconcile.diagnose",
        "H2O.Desktop.Sync.listRelayOutbox/listRelayInbox/listRelayIndex",
      ],
      actionApis: [
        "H2O.Desktop.Sync.round2aReady (read-only runtime inspection)",
        "H2O.Desktop.SyncObjectDelivery.readLineage",
        "legacy.sync.object-sync guarded fixture and recovery controls",
        "navigator.clipboard.writeText(redacted projection)",
        "h2o_p02_activate_format_gate (existing governed Rust V7 ceremony)",
        "createDesktopFirstPublication (V8-D adapter over the governed C2/C3a/C3b chain)",
      ],
      persistenceOwners: [
        "existing canonical peer identity authority",
        "existing Round 2A object and fixture stores",
        "existing Item 11 authorization and lineage ledger",
        "existing relay queues and index",
        "existing WebDAV descriptor and OS credential authorities",
        "existing native P02 V7 format authority (Rust ceremony writer only)",
        "existing governed P02 V8 publication authority (C3a lease, C3b composition, V8-B storage)",
      ],
    },
    test: Object.freeze({ projectIdentity, projectLineage, projectRelay, projectAutomaticReconcile, redactedCopyPayload, shortHash, projectP02Target, projectP02Receipt, buildActivateRequest, projectV8Candidates, projectV8Plan }),
    async mount(host) {
      const root = V.frame(host, {
        routeId: "settings.sync-new.advanced",
        panelId: "h2o-settings-advanced-diagnostics-panel",
        intro: "Internal diagnostics and acceptance entry points are quarantined here in the New architecture. Legacy keeps its complete historical controls.",
        body: V.card("Advanced Diagnostics", '<p style="margin:0;opacity:.7">Reading local redacted authorities…</p>'),
      });
      let disposed = false;
      let objectId = "";
      let lineage = projectLineage(null);
      let round2aStatus = "Not inspected";
      let message = "";
      let copyPayload = null;
      let p02Target = projectP02Target(null);
      let p02Receipt = projectP02Receipt(null);
      /* V8 ceremony state. The selection key is a public hash and may live in
       * panel state; operator tokens never do. */
      let p02v8Prepared = null;
      let p02v8Candidates = projectV8Candidates(null);
      let p02v8SelectionKey = "";
      let p02v8Planned = null;
      let p02v8Plan = projectV8Plan(null);
      let p02v8Runtime = null;

      /* Ceremony inputs are read from the DOM at invocation time and cleared
       * immediately: they are never held in module state, persisted, or logged. */
      const readCeremonyField = (selector) => V.clean(root.querySelector(selector)?.value);
      function clearCeremonyFields() {
        for (const selector of ['[data-p02-campaign="1"]', '[data-p02-operator="1"]']) {
          const node = root.querySelector(selector);
          if (node) node.value = "";
        }
        const quiesced = root.querySelector('[data-p02-quiesced="1"]');
        if (quiesced) quiesced.checked = false;
      }
      function clearV8CeremonyFields() {
        for (const selector of ['[data-p02v8-campaign="1"]', '[data-p02v8-operator="1"]']) {
          const node = root.querySelector(selector);
          if (node) node.value = "";
        }
        const quiesced = root.querySelector('[data-p02v8-quiesced="1"]');
        if (quiesced) quiesced.checked = false;
      }
      /* Built once, from real authorities only. Loading the adapter mutates
       * nothing; the first mutation possible anywhere in this section is the
       * Execute call behind Confirm. */
      async function ensureV8Runtime() {
        if (p02v8Runtime) return p02v8Runtime;
        const invoke = resolveInvoke();
        if (!invoke) throw new Error("p02-native-runtime-unavailable");
        const ready = W.H2O?.Desktop?.Sync?.round2aReady;
        if (ready && typeof ready.then === "function") await ready;
        const projection = W.H2O?.Desktop?.SyncObjectProjection;
        if (!projection || typeof projection.projectObject !== "function") {
          throw new Error("p02-projection-unavailable");
        }
        /* Reuse the canonicality-guarded writer id: a non-canonical Desktop
         * identity yields none, and the adapter then fails closed. */
        const syncPeerId = await canonicalWriterSyncPeerId();
        const module = await import(P02_V8_MODULE_URL);
        p02v8Runtime = module.createDesktopFirstPublication({
          invoke,
          projection,
          identity: { get: () => ({ syncPeerId }) },
          cryptoImplementation: W.crypto,
        });
        return p02v8Runtime;
      }
      function v8Evidence() {
        const evidence = W.H2O?.Desktop?.SyncObjectRuntime?.publicationEvidence;
        if (!evidence || typeof evidence.recordIntent !== "function") {
          throw new Error("p02-publication-evidence-unavailable");
        }
        return evidence;
      }
      /* Reuses the existing canonical peer identity authority; a non-canonical
       * Desktop identity yields no writer id, so the request fails closed. */
      async function canonicalWriterSyncPeerId() {
        const identity = W.H2O?.Studio?.identity;
        if (!identity || typeof identity.get !== "function") return "";
        try {
          if (typeof identity.whenReady === "function") await identity.whenReady();
        } catch (_) {
          return "";
        }
        const authority = typeof identity.authority === "function" ? identity.authority() : null;
        if (authority && authority.desktop === true && authority.canonical !== true) return "";
        return V.clean(identity.get()?.syncPeerId);
      }

      const isChrome = () => typeof W.H2O?.Studio?.sync?.folder?.connectFolder === "function";
      async function ensureDeliveryReader() {
        await panels.loadScriptOnce("./sync/browser-delivery-producer.tauri.js", () =>
          typeof W.H2O?.Desktop?.SyncObjectDelivery?.readLineage === "function");
        return W.H2O.Desktop.SyncObjectDelivery;
      }

      async function readLocalDiagnostics() {
        const sync = W.H2O?.Studio?.sync || {};
        const chrome = isChrome();
        const snapshot = chrome
          ? await sync.folder?.getReadinessSnapshot?.({ uiMounted: true })
          : await sync.getReadinessSnapshot?.({ uiMounted: true });
        let identityDiagnostic = {};
        try { identityDiagnostic = W.H2O?.Studio?.identity?.diagnose?.() || {}; }
        catch (_) { identityDiagnostic = {}; }
        const identity = projectIdentity(identityDiagnostic);
        let delivery = {};
        try {
          delivery = chrome ? (sync.item9Delivery?.diagnose?.() || {})
            : (W.H2O?.Desktop?.SyncObjectDelivery?.diagnose?.() || {});
        } catch (_) { delivery = {}; }
        let automaticReconcile = projectAutomaticReconcile(null);
        try {
          automaticReconcile = projectAutomaticReconcile(
            sync.objectAutoReconcile?.diagnose?.() || null
          );
        } catch (_) { automaticReconcile = projectAutomaticReconcile(null); }
        let relay = projectRelay(null, null, null);
        if (!chrome) {
          try {
            const desktopSync = W.H2O?.Desktop?.Sync || {};
            const [outbox, inbox, index] = await Promise.all([
              desktopSync.listRelayOutbox?.(),
              desktopSync.listRelayInbox?.(),
              desktopSync.listRelayIndex?.(),
            ]);
            relay = projectRelay(outbox, inbox, index);
          } catch (_) { relay = projectRelay(null, null, null); }
        }
        return Object.freeze({
          platform: chrome ? "Chrome Studio" : "Desktop Studio",
          foundation: snapshot?.foundation || {},
          localFolder: snapshot?.localFolder || {},
          browserDelivery: snapshot?.browserDelivery || {},
          webdav: snapshot?.webdav || {},
          identity,
          delivery,
          automaticReconcile,
          relay,
          lineage,
        });
      }

      async function render() {
        let model = null;
        let error = "";
        try { model = await readLocalDiagnostics(); }
        catch (value) { error = V.clean(value?.message || value) || "diagnostic authority unavailable"; }
        if (disposed) return;
        model = model || { platform: "Unavailable", foundation: {}, localFolder: {}, browserDelivery: {}, webdav: {}, identity: projectIdentity(null), delivery: {}, automaticReconcile: projectAutomaticReconcile(null), relay: projectRelay(), lineage };
        copyPayload = redactedCopyPayload(model);
        const foundation = model.foundation || {};
        const local = model.localFolder || {};
        const browser = model.browserDelivery || {};
        const webdav = model.webdav || {};
        const delivery = model.delivery || {};
        const automaticReconcile = model.automaticReconcile || projectAutomaticReconcile(null);
        const relay = model.relay || {};
        const lineageRows = [
          ["State", lineage.state],
          ["Current revision", V.valueText(lineage.currentRevisionId, "None")],
          ["Previous revision", V.valueText(lineage.previousRevisionId, "None")],
          ["Pending revision", V.valueText(lineage.pendingRevisionId, "None")],
          ["Chain", lineage.chain.length ? lineage.chain.join(" → ") : "No lineage read"],
          ["Blocked reason", lineage.reason],
        ];
        V.setBody(root,
          V.card("Read-only diagnostic summary", classification("Read-only diagnostic", "Local status reads only; no transport runs when this panel opens.") + V.statusRows([
            ["Platform", model.platform],
            ["Backend", V.valueText(foundation.persistentBackend?.backend, "unavailable")],
            ["Backend ready", foundation.persistentBackend?.ready === true ? "Yes" : "No"],
            ["Canonical authority", foundation.canonicalAuthority?.ready === true && foundation.canonicalAuthority?.canonical === true ? "Ready" : V.valueText(foundation.canonicalAuthority?.status, "Not ready")],
            ["Local folder", local.ready === true ? "Available" : V.valueText(local.reason || local.authorizationStatus, "Blocked")],
            ["Browser delivery", browser.ready === true ? "Available" : V.valueText(browser.reason, "Blocked")],
            ["WebDAV", webdav.ready === true ? "Available" : V.valueText(webdav.reason, "Blocked")],
            ["Delivery runtime", delivery.runtimeReady === true || delivery.installed === true ? "Loaded" : V.valueText(delivery.runtimeLoadState, "Not loaded")],
            ["Automatic reconcile", automaticReconcile.summary],
            ["Relay outbox / inbox / index", `${relay.outbox || 0} / ${relay.inbox || 0} / ${relay.index || 0}`],
          ]) + `<div style="display:flex;gap:8px;flex-wrap:wrap">${V.action("refresh", "Refresh local diagnostics")}${V.action("copy", "Copy Redacted Result")}</div>`) +
          V.card("Identity authority", classification("Read-only diagnostic", "The projection omits raw peer identity JSON and truncates the canonical fingerprint.") + V.statusRows(model.identity.rows)) +
          `<details class="wbSettingsCard" style="padding:16px;border:1px solid rgba(165,180,252,.24);border-radius:10px;background:rgba(99,102,241,.045);overflow:visible"><summary style="cursor:pointer;font-weight:650">Round 2A / Internal Acceptance</summary><div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">${classification("Internal acceptance fixture", "Runtime inspection is read-only. Fixture creation, Publish, Pull, and guarded recovery remain in the unchanged Legacy Object Sync surface.")}<div style="display:flex;gap:8px;flex-wrap:wrap">${V.action("round2a-runtime", "Inspect Round 2A runtime")}${V.link("#/settings/sync/object-sync", "Open Legacy Internal Controls")}</div>${V.statusRows([["Runtime", round2aStatus], ["Persistence", "Existing Round 2A authorities only"]])}</div></details>` +
          V.card("Browser Delivery lineage", classification("Read-only diagnostic", "Uses the same M3 native lineage reader and exposes semantic revision IDs only.") +
            (model.platform === "Desktop Studio" ? `<label style="display:grid;gap:5px;font-size:12px"><span style="opacity:.7">Object ID</span><input data-advanced-lineage-object-id="1" value="${V.escapeHtml(objectId)}" spellcheck="false" autocomplete="off" placeholder="stable object ID" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.18);color:inherit;font:inherit" /></label><div style="display:flex;gap:8px;flex-wrap:wrap">${V.action("lineage", "Read lineage")}${V.link("#/settings/sync-new/browser-delivery", "Open Browser Delivery")}</div>` : '<p style="margin:0;opacity:.7;font-size:12px">Native lineage projection is available on Desktop Studio.</p>') + V.statusRows(lineageRows)) +
          `<details class="wbSettingsCard" style="padding:16px;border:1px solid rgba(248,113,113,.28);border-radius:10px;background:rgba(239,68,68,.045);overflow:visible"><summary style="cursor:pointer;font-weight:650">P02 format gate (V7)</summary><div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">${classification("State-integrity ceremony", "The native resolver and the native V7 ceremony are the only authorities. This surface cannot choose a folder, cannot author the authority file, and exposes no first-writer publication.")}${
            model.platform === "Desktop Studio"
              ? `<div style="display:flex;gap:8px;flex-wrap:wrap">${V.action("p02-resolve", "Resolve / inspect")}</div>${V.statusRows(p02Target.rows)}<label style="display:grid;gap:5px;font-size:12px"><span style="opacity:.7">Governed campaign token</span><input data-p02-campaign="1" type="password" spellcheck="false" autocomplete="off" placeholder="supplied by the governed campaign" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.18);color:inherit;font:inherit" /></label><label style="display:grid;gap:5px;font-size:12px"><span style="opacity:.7">Operator authorization</span><input data-p02-operator="1" type="password" spellcheck="false" autocomplete="off" placeholder="supplied by the authorizing operator" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.18);color:inherit;font:inherit" /></label><label style="display:flex;gap:8px;align-items:flex-start;font-size:12px"><input data-p02-quiesced="1" type="checkbox" style="margin-top:2px" /><span style="opacity:.8">I attest the P01 writer is quiesced for this campaign. This attestation is passed to the native ceremony; it is not a substitute for the maintenance-suppression evidence.</span></label><div style="display:flex;gap:8px;flex-wrap:wrap">${V.action("p02-arm", "Activate V7 format gate", { disabled: p02Target.resolved !== true })}</div><div data-p02-confirm="1" hidden style="display:flex;flex-direction:column;gap:8px"><p style="margin:0;opacity:.8;font-size:12px;line-height:1.45">Confirm to run the native V7 ceremony against the resolved repository root. It creates ${V.escapeHtml(P02_AUTHORITY_FILE)} and nothing else.</p><div style="display:flex;gap:8px;flex-wrap:wrap">${V.action("p02-activate", "Confirm activation", { danger: true })}${V.action("p02-cancel", "Cancel")}</div></div>${V.statusRows(p02Receipt.rows)}`
              : '<p style="margin:0;opacity:.7;font-size:12px">The governed V7 ceremony is available on Desktop Studio only.</p>'
          }</div></details>` +
                    `<details class="wbSettingsCard" style="padding:16px;border:1px solid rgba(248,113,113,.28);border-radius:10px;background:rgba(239,68,68,.045);overflow:visible"><summary style="cursor:pointer;font-weight:650">P02 first writer publication (V8)</summary><div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">${classification("Governed first publication", "Publishes exactly one selected object as this writer’s first P02 revision. There is no default candidate, no automatic publication, and no batch. Arm changes nothing; only Confirm writes.")}${
          model.platform === "Desktop Studio"
            ? `<div style="display:flex;gap:8px;flex-wrap:wrap">${V.action("p02v8-prepare", "Prepare V8 candidates")}</div>${V.statusRows(p02v8Candidates.rows)}${p02v8Candidates.ready
              ? `<label style="display:grid;gap:5px;font-size:12px"><span style="opacity:.7">Candidate (explicit choice required)</span><select data-p02v8-candidate="1" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.18);color:inherit;font:inherit"><option value=""${p02v8SelectionKey ? "" : " selected"}>— Select a candidate —</option>${p02v8Candidates.candidates.map((candidate) => `<option value="${V.escapeHtml(candidate.selectionKey)}"${candidate.selectionKey === p02v8SelectionKey ? " selected" : ""}>${V.escapeHtml(candidate.label)} — ${V.escapeHtml(candidate.shortObjectId)}</option>`).join("")}</select></label><div style="display:flex;gap:8px;flex-wrap:wrap">${V.action("p02v8-plan", "Review publication plan", { disabled: !p02v8SelectionKey })}</div>`
              : ""}${p02v8Plan.ready ? V.statusRows(p02v8Plan.rows) : ""}${p02v8Plan.ready
              ? `<label style="display:grid;gap:5px;font-size:12px"><span style="opacity:.7">Governed campaign token</span><input data-p02v8-campaign="1" type="password" spellcheck="false" autocomplete="off" placeholder="supplied by the governed campaign" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.18);color:inherit;font:inherit" /></label><label style="display:grid;gap:5px;font-size:12px"><span style="opacity:.7">Operator authorization</span><input data-p02v8-operator="1" type="password" spellcheck="false" autocomplete="off" placeholder="supplied by the authorizing operator" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.18);color:inherit;font:inherit" /></label><label style="display:flex;gap:8px;align-items:flex-start;font-size:12px"><input data-p02v8-quiesced="1" type="checkbox" style="margin-top:2px" /><span style="opacity:.8">I attest the P01 writer is quiesced for this publication.</span></label><div style="display:flex;gap:8px;flex-wrap:wrap">${V.action("p02v8-arm", "Arm first publication")}</div><div data-p02v8-confirm="1" hidden style="display:flex;flex-direction:column;gap:8px"><p style="margin:0;opacity:.8;font-size:12px;line-height:1.45">Confirm publishes the reviewed revision to the resolved repository under a single governed lease. This is the only control in this section that writes.</p><div style="display:flex;gap:8px;flex-wrap:wrap">${V.action("p02v8-confirm", "Confirm first publication", { danger: true })}${V.action("p02v8-cancel", "Cancel")}</div></div>`
              : ""}`
            : '<p style="margin:0;opacity:.7;font-size:12px">The governed V8 first publication is available on Desktop Studio only.</p>'
        }</div></details>` +
                      `<details class="wbSettingsCard" style="padding:16px;border:1px solid rgba(248,113,113,.28);border-radius:10px;background:rgba(239,68,68,.045);overflow:visible"><summary style="cursor:pointer;font-weight:650">Recovery and destructive operations</summary><div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">${classification("Destructive / recovery", "No recovery operation is duplicated here. These links enter the existing verification and confirmation contracts.")}<div style="display:flex;gap:8px;flex-wrap:wrap">${V.link("#/settings/sync-new/archive-recovery", "Open Archive & Recovery")}${V.link("#/settings/sync/object-sync", "Open guarded identity recovery")}</div></div></details>` +
          V.card("Result", `<p data-domain-message="1" style="margin:0;opacity:.72;font-size:12px">${V.escapeHtml(error ? `Blocked: ${error}` : (message || "No internal action has been run."))}</p>`)
        );
      }

      const removeInput = V.listen(root, "input", (event) => {
        if (event.target?.matches?.('[data-advanced-lineage-object-id="1"]')) objectId = V.clean(event.target.value);
        if (event.target?.matches?.('[data-p02v8-candidate="1"]')) {
          /* Changing the candidate invalidates any reviewed plan: the operator
           * must review the new one before anything can be armed. */
          p02v8SelectionKey = V.clean(event.target.value);
          p02v8Planned = null;
          p02v8Plan = projectV8Plan(null);
          const planButton = root.querySelector('[data-domain-action="p02v8-plan"]');
          if (planButton) planButton.disabled = !p02v8SelectionKey;
        }
      });
      const removeClick = V.listen(root, "click", async (event) => {
        const button = event.target?.closest?.("[data-domain-action]");
        if (!button || !root.contains(button)) return;
        const action = V.clean(button.dataset.domainAction);
        if (!action) return;
        event.preventDefault();
        if (action === "p02v8-arm" || action === "p02v8-cancel") {
          /* Zero mutation, and deliberately DOM-local: re-rendering would
           * destroy the operator's tokens and force them into panel state. */
          const confirmRow = root.querySelector('[data-p02v8-confirm="1"]');
          const armButton = root.querySelector('[data-domain-action="p02v8-arm"]');
          if (confirmRow) confirmRow.hidden = action !== "p02v8-arm";
          if (armButton) armButton.disabled = action === "p02v8-arm";
          return;
        }
        if (action === "p02-arm" || action === "p02-cancel") {
          /* Deliberately DOM-local: re-rendering here would destroy the
           * operator's ceremony inputs and force them into module state. */
          const confirmRow = root.querySelector('[data-p02-confirm="1"]');
          const armButton = root.querySelector('[data-domain-action="p02-arm"]');
          if (confirmRow) confirmRow.hidden = action !== "p02-arm";
          if (armButton) armButton.disabled = action === "p02-arm";
          return;
        }
        button.disabled = true;
        try {
          if (action === "refresh") message = "Refreshed from existing local authorities.";
          else if (action === "copy") {
            const clipboard = W.navigator?.clipboard;
            if (!clipboard || typeof clipboard.writeText !== "function") throw new Error("clipboard-unavailable");
            await clipboard.writeText(JSON.stringify(copyPayload, null, 2));
            message = "Copied the redacted diagnostic projection.";
          } else if (action === "round2a-runtime") {
            const ready = W.H2O?.Desktop?.Sync?.round2aReady;
            if (!ready || typeof ready.then !== "function") throw new Error("round2a-runtime-unavailable");
            await ready;
            round2aStatus = "Loaded through the existing Round 2A authority";
            message = "Round 2A runtime inspected without an object or transport operation.";
          } else if (action === "lineage") {
            if (!objectId) throw new Error("object-id-required");
            const api = await ensureDeliveryReader();
            lineage = projectLineage(await api.readLineage(objectId));
            message = lineage.state === "blocked" ? `Blocked: ${lineage.reason}` : "Lineage read without mutation.";
          } else if (action === "p02-resolve") {
            const invoke = resolveInvoke();
            if (!invoke) throw new Error("p02-native-runtime-unavailable");
            p02Target = projectP02Target(await invoke(P02_RESOLVE_COMMAND));
            p02Receipt = projectP02Receipt(null);
            message = p02Target.authorityPresent
              ? "Resolved read-only. A P02 format authority is already present."
              : "Resolved read-only. The native resolver created nothing.";
          } else if (action === "p02-activate") {
            const invoke = resolveInvoke();
            if (!invoke) throw new Error("p02-native-runtime-unavailable");
            const built = buildActivateRequest({
              target: p02Target,
              governedCampaign: readCeremonyField('[data-p02-campaign="1"]'),
              operatorAuthorization: readCeremonyField('[data-p02-operator="1"]'),
              p01WriterQuiesced: root.querySelector('[data-p02-quiesced="1"]')?.checked === true,
              activatedByWriterSyncPeerId: await canonicalWriterSyncPeerId(),
              activatedAt: new Date().toISOString(),
            });
            if (!built.ok) throw new Error(built.blocker);
            let receipt = null;
            try {
              receipt = await invoke(P02_ACTIVATE_COMMAND, { request: built.request });
            } finally {
              /* Never leave operator material in the DOM, success or failure. */
              clearCeremonyFields();
            }
            p02Receipt = projectP02Receipt(receipt);
            p02Target = projectP02Target(await invoke(P02_RESOLVE_COMMAND));
            message = p02Receipt.replay
              ? "Native verify-only replay: the existing authority matched and nothing was rewritten."
              : "Native V7 ceremony completed.";
          } else if (action === "p02v8-prepare") {
            const runtime = await ensureV8Runtime();
            p02v8Prepared = await runtime.prepareCandidates();
            p02v8Candidates = projectV8Candidates(p02v8Prepared);
            /* Any previous choice and plan go with the old enumeration;
             * nothing carries across a re-prepare. */
            p02v8SelectionKey = "";
            p02v8Planned = null;
            p02v8Plan = projectV8Plan(null);
            message = p02v8Candidates.ready
              ? `Prepared ${p02v8Candidates.candidates.length} eligible candidate(s). Select one to review a plan.`
              : "No object is eligible for first publication.";
          } else if (action === "p02v8-plan") {
            if (!p02v8Prepared) throw new Error("p02-v8-candidates-not-prepared");
            if (!p02v8SelectionKey) throw new Error("p02-v8-candidate-not-selected");
            const runtime = await ensureV8Runtime();
            p02v8Planned = await runtime.preparePlan({
              prepared: p02v8Prepared,
              selectionKey: p02v8SelectionKey,
            });
            p02v8Plan = projectV8Plan(p02v8Planned);
            message = "Publication plan prepared and verified. Nothing has been written.";
          } else if (action === "p02v8-confirm") {
            if (!p02v8Prepared || !p02v8Planned) throw new Error("p02-v8-plan-not-reviewed");
            const runtime = await ensureV8Runtime();
            const authority = {
              governedCampaign: readCeremonyField('[data-p02v8-campaign="1"]'),
              operatorAuthorization: readCeremonyField('[data-p02v8-operator="1"]'),
              p01WriterQuiesced: root.querySelector('[data-p02v8-quiesced="1"]')?.checked === true,
            };
            let outcome = null;
            try {
              outcome = await runtime.execute({
                prepared: p02v8Prepared,
                planned: p02v8Planned,
                authority,
                evidence: v8Evidence(),
              });
            } finally {
              /* Never leave operator material in the DOM, success or failure. */
              clearV8CeremonyFields();
            }
            /* The publication is spent: force a fresh enumeration before any
             * further candidate can be selected. */
            p02v8Prepared = null;
            p02v8Candidates = projectV8Candidates(null);
            p02v8SelectionKey = "";
            p02v8Planned = null;
            p02v8Plan = projectV8Plan(null);
            message = `Governed first publication: ${V.clean(outcome?.outcome) || "completed"}.`;
          }
        } catch (error) {
          message = `Blocked: ${V.clean(error?.message || error) || "diagnostic action unavailable"}`;
        }
        await render();
      });
      await render();
      return () => { disposed = true; copyPayload = null; p02v8Runtime = null; clearCeremonyFields(); clearV8CeremonyFields(); removeInput(); removeClick(); };
    },
  });
})();
