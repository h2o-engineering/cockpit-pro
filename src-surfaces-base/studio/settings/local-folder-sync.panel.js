// Sync Settings M3 — Local Folder presentation over existing Desktop/Chrome authorities.
(() => {
  "use strict";
  const W = typeof globalThis !== "undefined" ? globalThis : window;
  const panels = W.H2O?.Studio?.settings?.domainPanels;
  if (!panels) return;
  const V = panels.view;

  /* W-2b. The dedicated background op that observes the governed P02 repository
   * read-only. Sent DIRECTLY from this extension-owned Studio document; it is
   * deliberately not an archive op, because archive ops are reachable from
   * page-world JavaScript and this must not be. */
  const MSG_P02_OBSERVE = "h2o-ext-p02-observe:v1";
  const MSG_P02_RECEIVE_ADMIT = "h2o-ext-p02-receive-admit:v1";
  const MSG_P02_APPLY = "h2o-ext-p02-apply:v1";
  const MSG_P02_PUBLISH_LOCAL = "h2o-ext-p02-publish-local:v1";
  const MSG_P01_WRITER_STANDDOWN =
    "h2o-ext-p02-standdown-p01-writer:v1";
  const P02_W2C_RESULT_SCHEMA = "h2o.studio.syncW2cReceiveAdmissionResult.v1";
  const P02_W3_RESULT_SCHEMA = "h2o.studio.syncW3ApplyResult.v1";
  const P02_PUBLISH_RESULT_SCHEMA =
    "h2o.studio.syncChromePublicationResult.p02.v1";
  const P02_DESKTOP_RECEIVE_RESULT_SCHEMA =
    "h2o.studio.syncDesktopP02ReceiveResult.v1";
  const P02_DESKTOP_APPLY_RESULT_SCHEMA =
    "h2o.studio.syncDesktopP02ApplyResult.v1";
  const P01_WRITER_STANDDOWN_RESULT_SCHEMA =
    "h2o.studio.syncP01WriterStanddownResult.v1";
  const CONFIGURED_PEER_RESULT_SCHEMA =
    "h2o.studio.syncConfiguredPeerWriteResult.v1";
  /* Readiness is a race between the existing one-shot Port acknowledgement and
   * a liveness-only announcement emitted after a cold worker has started. The
   * announcement wire value deliberately differs from the Port name only by the
   * Port's ":port" transport suffix. */
  const P02_OBSERVE_READY_ANNOUNCE = "h2o-ext-p02-observe-ready:v1";
  const P02_OBSERVE_READY_PORT = "h2o-ext-p02-observe-ready:v1:port";
  /* Replaced exactly once by the canonical production pack step from the same
   * frozen build context used to generate bg.js. It is public provenance, not
   * an authentication secret; sender validation remains independently required. */
  const H2O_BUILD_STAMP = "__H2O_RUNTIME_BUILD_STAMP_FROM_CANONICAL_BUILD__";

  /* V.escapeHtml intentionally trims ordinary presentation values. Authority
   * input must preserve every operator byte so whitespace is rejected by the
   * owner rather than silently corrected after a render. */
  function escapeAuthorityInput(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* Reverse-direction authorization for worker -> Studio readiness. This is not
   * the Studio -> worker observer guard: a valid announcement comes from bg.js,
   * carries this extension's id, and has no tab-bearing content-script sender. */
  function isP02ObserveReadyWorkerSender(sender) {
    const runtime = W.chrome?.runtime;
    if (!runtime || !sender || sender.id !== runtime.id || sender.tab) return false;
    let workerUrl = "";
    try { workerUrl = runtime.getURL("bg.js"); } catch (_) { return false; }
    return typeof sender.url === "string" && sender.url === workerUrl;
  }

  /* Phase A. The temporary announcement listener is armed BEFORE the one and
   * only Port is opened. A warm Port ACK or a cold post-start announcement may
   * win the same latch; cleanup removes both paths before resolving. There is no
   * reconnect, retry, polling loop, timer, persistence, or later authority. */
  function confirmWorkerReady() {
    return new Promise((resolve) => {
      const runtime = W.chrome.runtime;
      let settled = false;
      let staleBuildSeen = false;
      let observedBuild = "";
      let announcementListenerArmed = false;
      let port = null;

      function acceptCurrentBuild(message) {
        if (message?.build === H2O_BUILD_STAMP) return true;
        if (message && Object.prototype.hasOwnProperty.call(message, "build")) {
          staleBuildSeen = true;
          observedBuild = typeof message.build === "string"
            ? message.build.slice(0, 128)
            : `<${typeof message.build}>`;
        }
        return false;
      }

      function onReadyAnnouncement(message, sender) {
        if (message?.type !== P02_OBSERVE_READY_ANNOUNCE || message?.ready !== true) return;
        if (!isP02ObserveReadyWorkerSender(sender)) return;
        if (!acceptCurrentBuild(message)) return;
        settle({ ready: true, signal: "post-start-announcement" });
      }

      function onPortMessage(message) {
        if (!acceptCurrentBuild(message)) return;
        settle(message?.ok === true
          ? { ready: true, signal: "port-ack" }
          : { ready: false,
              error: V.clean(message?.error) || "p02-observe-worker-not-ready" });
      }

      function onPortDisconnect() {
        /* Read so Chrome does not log an unchecked error; the typed result the
         * operator sees is deliberately the same whatever the transport said. */
        void runtime.lastError;
        settle(staleBuildSeen
          ? { ready: false, error: "p02-observe-worker-stale",
              expectedBuild: H2O_BUILD_STAMP, observedBuild }
          : { ready: false, error: "p02-observe-worker-not-ready" });
      }

      function cleanup() {
        if (announcementListenerArmed) {
          try { runtime.onMessage.removeListener(onReadyAnnouncement); } catch (_) { /* context gone */ }
          announcementListenerArmed = false;
        }
        staleBuildSeen = false;
        observedBuild = "";
        if (!port) return;
        try { port.onMessage.removeListener(onPortMessage); } catch (_) { /* context gone */ }
        try { port.onDisconnect.removeListener(onPortDisconnect); } catch (_) { /* context gone */ }
        try { port.disconnect(); } catch (_) { /* already closed */ }
        port = null;
      }

      function settle(value) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      }

      try {
        runtime.onMessage.addListener(onReadyAnnouncement);
        announcementListenerArmed = true;
        port = runtime.connect({ name: P02_OBSERVE_READY_PORT });
        port.onMessage.addListener(onPortMessage);
        port.onDisconnect.addListener(onPortDisconnect);
      } catch (error) {
        settle({ ready: false,
          error: V.clean(error?.message || error) || "p02-observe-worker-not-ready" });
      }
    });
  }

  /* Phase B. Sent once. Never repeated, whatever it answers - it is the request
   * that carries the observation. */
  function observeRepositoryOnce() {
    return new Promise((resolve) => {
      try {
        W.chrome.runtime.sendMessage({ type: MSG_P02_OBSERVE }, (response) => {
          const failure = W.chrome.runtime.lastError;
          resolve(failure
            ? { ok: false, error: V.clean(failure.message) || "p02-observe-unavailable" }
            : (response || { ok: false, error: "p02-observe-no-response" }));
        });
      } catch (error) {
        resolve({ ok: false,
          error: V.clean(error?.message || error) || "p02-observe-unavailable" });
      }
    });
  }

  /* W-2c fixed-purpose request. The trusted click below is the sole caller;
   * this function sends exactly the operation type and the expected build. */
  function receiveAdmitOnce() {
    return new Promise((resolve) => {
      try {
        W.chrome.runtime.sendMessage({
          type: MSG_P02_RECEIVE_ADMIT,
          build: H2O_BUILD_STAMP,
        }, (response) => {
          const failure = W.chrome.runtime.lastError;
          resolve(failure
            ? { ok: false, schema: P02_W2C_RESULT_SCHEMA,
                error: "p02-w2c-receive-admission-unavailable" }
            : (response || { ok: false, schema: P02_W2C_RESULT_SCHEMA,
                error: "p02-w2c-receive-admission-no-response" }));
        });
      } catch (_) {
        resolve({ ok: false, schema: P02_W2C_RESULT_SCHEMA,
          error: "p02-w2c-receive-admission-unavailable" });
      }
    });
  }

  /* W-3 fixed-purpose request. No page-selected object, revision, peer,
   * anchor, mode, path or option crosses this boundary. */
  function applyAdmittedRevisionOnce() {
    return new Promise((resolve) => {
      try {
        W.chrome.runtime.sendMessage({
          type: MSG_P02_APPLY,
          build: H2O_BUILD_STAMP,
        }, (response) => {
          const failure = W.chrome.runtime.lastError;
          resolve(failure
            ? { ok: false, schema: P02_W3_RESULT_SCHEMA,
                outcome: "runtime-unavailable" }
            : (response || { ok: false, schema: P02_W3_RESULT_SCHEMA,
                outcome: "runtime-unavailable" }));
        });
      } catch (_) {
        resolve({ ok: false, schema: P02_W3_RESULT_SCHEMA,
          outcome: "runtime-unavailable" });
      }
    });
  }

  /* Reverse P02 fixed-purpose request. Object, revision, writer, parent, path,
   * destination and options never cross the page -> worker boundary. */
  function publishLocalRevisionOnce() {
    return new Promise((resolve) => {
      try {
        W.chrome.runtime.sendMessage({
          type: MSG_P02_PUBLISH_LOCAL,
          build: H2O_BUILD_STAMP,
        }, (response) => {
          const failure = W.chrome.runtime.lastError;
          resolve(failure
            ? { ok: false, schema: P02_PUBLISH_RESULT_SCHEMA,
                outcome: "runtime-unavailable" }
            : (response || { ok: false, schema: P02_PUBLISH_RESULT_SCHEMA,
                outcome: "runtime-unavailable" }));
        });
      } catch (_) {
        resolve({ ok: false, schema: P02_PUBLISH_RESULT_SCHEMA,
          outcome: "runtime-unavailable" });
      }
    });
  }

  async function desktopP02ReverseRuntime() {
    await panels.loadScriptOnce("./sync/sync-object-runtime.tauri.js", () =>
      typeof W.H2O?.Desktop?.SyncObjectRuntime
        ?.applyNextAdmittedP02Revision === "function");
    if (typeof W.H2O?.Studio?.sync?.p02Reverse?.receiveFromChrome !== "function") {
      await import("../sync/sync-reverse-desktop-v2.tauri.mjs");
    }
    const runtime = W.H2O?.Studio?.sync?.p02Reverse;
    if (typeof runtime?.receiveFromChrome !== "function" ||
        typeof runtime?.applyAdmittedFromChrome !== "function" ||
        typeof runtime?.configureChromePeer !== "function") {
      throw new Error("p02-desktop-reverse-runtime-unavailable");
    }
    return runtime;
  }

  /* Fixed-purpose and sent once from the trusted click branch below. No
   * authority value is accepted from the page; the worker resolves the sole
   * configured Desktop peer, timestamp, reason and generation target. */
  function standDownP01WriterOnce() {
    return new Promise((resolve) => {
      try {
        W.chrome.runtime.sendMessage({
          type: MSG_P01_WRITER_STANDDOWN,
          build: H2O_BUILD_STAMP,
        }, (response) => {
          const failure = W.chrome.runtime.lastError;
          resolve(failure
            ? { ok: false, schema: P01_WRITER_STANDDOWN_RESULT_SCHEMA,
                outcome: "runtime-unavailable" }
            : (response || { ok: false,
                schema: P01_WRITER_STANDDOWN_RESULT_SCHEMA,
                outcome: "runtime-unavailable" }));
        });
      } catch (_) {
        resolve({ ok: false, schema: P01_WRITER_STANDDOWN_RESULT_SCHEMA,
          outcome: "runtime-unavailable" });
      }
    });
  }

  function standdownOutcomeText(result) {
    if (result?.schema !== P01_WRITER_STANDDOWN_RESULT_SCHEMA) {
      return "Chrome P01 standdown blocked: worker unavailable.";
    }
    const messages = Object.freeze({
      "stood-down": "Chrome P01 writer stood down and P01 mutation is refused.",
      "already-stood-down": "Chrome P01 writer was already stood down; no change made.",
      "p01-not-quiescent": "Chrome P01 standdown blocked: active P01 work did not quiesce.",
      "configured-peer-authority-invalid": "Chrome P01 standdown blocked: trusted Desktop peer authority is invalid.",
      "generation-state-invalid": "Chrome P01 standdown blocked: writer-generation authority is invalid.",
      busy: "Chrome P01 standdown blocked: an invocation is already active.",
      "sender-forbidden": "Chrome P01 standdown blocked: Studio sender is not trusted.",
      "build-mismatch": "Chrome P01 standdown blocked: Studio and worker builds differ.",
      "serialization-unavailable": "Chrome P01 standdown blocked: serialization is unavailable.",
      "persistence-failed": "Chrome P01 standdown failed while persisting authority.",
      "readback-mismatch": "Chrome P01 standdown write could not be verified; no retry was attempted.",
      "request-invalid": "Chrome P01 standdown blocked: request contract is invalid.",
      "runtime-unavailable": "Chrome P01 standdown blocked: worker runtime is unavailable.",
      "trusted-activation-required": "Chrome P01 standdown blocked: trusted active user gesture required.",
    });
    return messages[result.outcome] || "Chrome P01 standdown blocked.";
  }

  function standdownRows(result) {
    return Object.freeze([
      ["Result", result?.ok === true ? "Completed" : "Blocked"],
      ["Outcome", V.valueText(result?.outcome, "unavailable")],
      ["Generation", V.valueText(result?.generation, "unchanged")],
      ["P01 mutation", result?.p01MayMutate === false ? "Refused" : "Not changed"],
      ["Verified", result?.verified === true ? "Yes" : "No"],
    ]);
  }

  function receiveAdmissionRows(result) {
    const source = result || {};
    const outcomes = source.outcomes || {};
    return Object.freeze([
      ["Result", source.ok === true ? "Completed" : "Blocked"],
      ["Runtime", V.valueText(source.runtimeStatus, "unavailable")],
      ["Passes", String(Number.isSafeInteger(source.runPasses) ? source.runPasses : 0)],
      ["Dispatched", String(Number.isSafeInteger(source.dispatchedCount) ? source.dispatchedCount : 0)],
      ["Progress / no effect", `${Number(outcomes.progress) || 0} / ${Number(outcomes.noEffect) || 0}`],
      ["Blocked / indeterminate", `${Number(outcomes.blocked) || 0} / ${Number(outcomes.indeterminate) || 0}`],
      ["Integrity / transient", `${Number(outcomes.integrity) || 0} / ${Number(outcomes.transient) || 0}`],
      ["Apply", source.applyEnabled === false ? "Disabled" : "Blocked"],
      ["Publication", source.publicationReachable === false ? "Unreachable" : "Blocked"],
      ...(source.error ? [["Error", V.valueText(source.error, "blocked")]] : []),
    ]);
  }

  function manualApplyRows(result) {
    const source = result || {};
    return Object.freeze([
      ["Result", source.ok === true ? "Completed" : "Blocked"],
      ["Outcome", V.valueText(source.outcome, "unavailable")],
      ["Runtime", V.valueText(source.runtimeStatus, "unavailable")],
      ["Passes", String(Number.isSafeInteger(source.runPasses) ? source.runPasses : 0)],
      ["Canonical content", source.canonicalMutated === true ? "Imported once" : "Not changed"],
      ["Apply state", source.outcome === "already-applied"
        ? "Already committed"
        : (source.applied === true ? "Committed" : "Not committed")],
      ["Publication", source.publicationReachable === false ? "Unreachable" : "Blocked"],
    ]);
  }

  function trustedPeerOutcomeText(result) {
    if (result?.schema !== CONFIGURED_PEER_RESULT_SCHEMA) {
      return "Trusted Desktop peer blocked: config owner unavailable.";
    }
    const messages = Object.freeze({
      configured: "Trusted Desktop peer configured and verified.",
      "already-configured": "Trusted Desktop peer already configured; no change made.",
      "invalid-peer": "Trusted Desktop peer blocked: peer ID is invalid.",
      "invalid-writer-key": "Trusted Desktop peer blocked: writer key must be 64 lowercase hexadecimal characters.",
      "writer-key-mismatch": "Trusted Desktop peer blocked: writer key does not match the peer ID.",
      "self-peer": "Trusted Desktop peer blocked: Chrome cannot configure itself as a Receive peer.",
      "authority-conflict": "Trusted Desktop peer blocked: different peer authority is already configured.",
      "local-identity-unavailable": "Trusted Desktop peer blocked: Chrome local identity is unavailable.",
      "trusted-activation-required": "Trusted Desktop peer blocked: trusted active user gesture required.",
      "authority-unavailable": "Trusted Desktop peer blocked: peer validation is unavailable.",
      "persistence-failed": "Trusted Desktop peer write failed.",
      "readback-mismatch": "Trusted Desktop peer write could not be verified; no retry was attempted.",
    });
    return messages[result.outcome] || "Trusted Desktop peer blocked.";
  }

  function trustedChromePeerOutcomeText(result) {
    const text = trustedPeerOutcomeText(result);
    return text.replaceAll("Desktop", "Chrome");
  }

  function desktopP02ReceiveRows(result) {
    const report = result?.report || {};
    return Object.freeze([
      ["Result", result?.ok === true ? "Completed" : "Blocked"],
      ["Outcome", V.valueText(result?.outcome, "unavailable")],
      ["Known peer", result?.peerSyncPeerId ? "Verified" : "Unavailable"],
      ["Objects admitted", String(Number(result?.admittedCount) || 0)],
      ["Apply", result?.applyExecuted === false ? "Not executed" : "Blocked"],
      ["Apply candidates", String(Array.isArray(report.applyCandidates)
        ? report.applyCandidates.length : 0)],
      ["WebDAV", result?.webdavReachable === false ? "Unreachable" : "Blocked"],
    ]);
  }

  /* Outcome of the bounded already-applied metadata self-heal, carried inside
   * the runtime result: never a canonical import, never a repository write. */
  function metadataReconciledText(result) {
    const detail = result?.result?.metadataReconciliation;
    if (!detail || typeof detail !== "object") return "n/a";
    const chats = Array.isArray(detail.chats) ? detail.chats : [];
    if (detail.reconciled === true) {
      const fields = chats.flatMap((chat) => Array.isArray(chat?.fields) ? chat.fields : []);
      return fields.length ? `Yes (${fields.join(", ")})` : "Yes";
    }
    if (chats.length && chats.every((chat) => chat?.status === "noop")) return "Not needed";
    const code = V.clean(detail.code || chats[0]?.code);
    return code ? `No (${code})` : "No";
  }

  function desktopP02ApplyRows(result) {
    return Object.freeze([
      ["Result", result?.ok === true ? "Completed" : "Blocked"],
      ["Outcome", V.valueText(result?.outcome, "unavailable")],
      ["Canonical import attempts", String(Number(result?.canonicalImportAttempts) || 0)],
      ["Metadata reconciled", metadataReconciledText(result)],
      ["Direction", V.valueText(result?.convergedDirection, "unchanged")],
      ["Publication", result?.publicationReachable === false ? "Unreachable" : "Blocked"],
      ["Repository writes", String(Number(result?.repositoryWrites) || 0)],
      ["WebDAV", result?.webdavReachable === false ? "Unreachable" : "Blocked"],
    ]);
  }

  /* Read-only presentation of whatever the production observation actually
   * returned. Nothing is normalised away and nothing is persisted: the record
   * lives in this panel's closure for this Studio session only. */
  function observationRows(observation) {
    const source = observation || {};
    const gate = source.gate || {};
    const generation = source.generation || {};
    const rows = [
      ["Gate state", V.valueText(gate.state, "none")],
      ["Gate reason", V.valueText(gate.reason, "none")],
      ["May read", gate.mayRead === true ? "Yes" : (gate.mayRead === false ? "No" : "n/a")],
      ["May write", gate.mayWrite === true ? "Yes" : (gate.mayWrite === false ? "No" : "n/a")],
      ["Classification", V.valueText(gate.classification, "none")],
      ["Read only", source.readOnly === true ? "Yes" : "No"],
      ["Repaired", source.repaired === true ? "Yes" : "No"],
      ["Local generation", V.valueText(generation.local, "none")],
      ["Local generation state", V.valueText(generation.localState, "none")],
      ["Repository generation", V.valueText(generation.repository, "none")],
      ["Generation block", V.valueText(generation.blockReason, "none")],
      ["Legacy (N.2) observation", source.legacyObservation === null || source.legacyObservation === undefined
        ? "none"
        : (source.legacyObservation.matches === true ? "Matches" : "Does not match")],
    ];
    return Object.freeze(rows);
  }

  function folderLeaf(path) {
    const parts = V.clean(path).replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || "Not configured";
  }

  function firstActivity(snapshot) {
    const source = snapshot || {};
    const values = [
      source.localFolder?.operation?.lastActivity,
      source.browserDelivery?.operation?.lastActivity,
      source.webdav?.operation?.lastActivity,
      source.archiveRecovery?.operation?.lastActivity,
      ...Object.values(source.automation || {}).flatMap((capability) => [
        capability?.lastActivity,
        capability?.operation?.lastActivity,
      ]),
    ].map(V.clean).filter(Boolean);
    return values.sort((left, right) => {
      const leftTime = Date.parse(left);
      const rightTime = Date.parse(right);
      return Number.isFinite(leftTime) && Number.isFinite(rightTime) ? rightTime - leftTime : 0;
    })[0] || "";
  }

  function projectOverview(snapshot, platform) {
    const source = snapshot || {};
    const local = source.localFolder || {};
    const browser = source.browserDelivery || {};
    const webdav = source.webdav || {};
    const recovery = source.archiveRecovery || {};
    const automation = Object.values(source.automation || {});
    const chrome = platform === "chrome";
    const localConnected = chrome
      ? browser.connected === true
      : local.authorizationValid === true || local.authorized === true;
    const automationConfigured = automation.filter((item) => item?.configured === true);
    const automationEffective = automationConfigured.filter((item) => item?.effective === true);
    const rows = [
      ["Local connection", localConnected ? "Connected" : "Not connected"],
      ["Desktop → Chrome", browser.ready === true
        ? "Ready"
        : (browser.connected === true || browser.handlePresent === true ? "Blocked" : "Not configured")],
      ["WebDAV", webdav.ready === true ? "Configured" : (webdav.configured === true ? "Blocked" : "Not configured")],
      ["Automation", automationConfigured.length === 0
        ? "Off"
        : (automationEffective.length === automationConfigured.length ? "Working" : "Partially blocked")],
    ];
    if (recovery.available === true || V.clean(recovery.reason)) {
      rows.push(["Recovery", recovery.ready === true ? "Healthy" : "Attention required"]);
    }
    const lastActivity = firstActivity(source);
    if (lastActivity) rows.push(["Last activity", lastActivity]);
    return Object.freeze({ rows: Object.freeze(rows) });
  }

  function project(snapshot, config, platform, folderName) {
    const foundation = snapshot?.foundation || {};
    const backend = foundation.persistentBackend || {};
    const identity = foundation.canonicalAuthority || {};
    const local = snapshot?.localFolder || {};
    const browser = snapshot?.browserDelivery || {};
    const operation = local.operation || {};
    const configuredPath = config?.folderPath || "";
    const chrome = platform === "chrome";
    const connected = chrome
      ? browser.connected === true
      : local.authorizationValid === true || local.authorized === true;
    const ready = chrome ? browser.ready === true : local.ready === true;
    const configured = chrome ? connected : local.configured === true;
    const reason = V.clean(chrome ? browser.reason : (local.reason || local.authorizationStatus));
    const rows = [
      ["Folder", chrome ? V.valueText(folderName, "Not connected") : folderLeaf(configuredPath)],
      ["Connected", connected ? "Yes" : "No"],
      [chrome ? "Read access" : "Authorization", chrome ? V.valueText(browser.permission, "not checked") : V.valueText(local.authorizationStatus, "not checked")],
      ...(chrome ? [["Chrome publishing", browser.publishingAuthorized === true
        ? "Authorized"
        : (browser.publishingPermission === "denied" ? "Denied"
          : (browser.publishingPermission === "unavailable" ? "Unavailable" : "Authorization required"))]] : []),
      ["Status", ready ? "Ready" : (configured ? "Blocked" : "Not configured")],
      ["Last activity", V.valueText(operation.lastActivity, "None yet")],
    ];
    if (!ready && reason && reason !== "none") rows.push(["Why it's blocked", reason]);
    return Object.freeze({
      rows: Object.freeze(rows),
      backendReady: backend.ready === true,
      identityReady: identity.ready === true && identity.canonical === true,
      connected,
      ready,
    });
  }

  panels.register({
    routeId: "settings.sync-new.local-folder",
    panelId: "h2o-settings-local-folder-panel",
    authority: {
      displaySources: [
        "H2O.Studio.sync.getReadinessSnapshot",
        "H2O.Studio.sync.getConfig",
        "H2O.Studio.sync.folder.getReadinessSnapshot",
        "H2O.Studio.sync.folder.getConnectedDirectoryHandle",
      ],
      actionApis: [
        "H2O.Desktop.SyncObjectDelivery.selectDeliveryFolder",
        "H2O.Studio.sync.folder.connectFolder",
        "H2O.Studio.sync.folder.disconnectFolder",
        "H2O.Studio.sync.folder.authorizeChromePublishing",
        "H2O.Studio.sync.setTrustedDesktopPeer",
        "H2O.Studio.sync.p02Reverse.configureChromePeer",
        "H2O.Studio.sync.p02Reverse.receiveFromChrome",
        "H2O.Studio.sync.p02Reverse.applyAdmittedFromChrome",
        "chrome.runtime.sendMessage h2o-ext-p02-observe:v1",
        "chrome.runtime.sendMessage h2o-ext-p02-receive-admit:v1",
        "chrome.runtime.sendMessage h2o-ext-p02-apply:v1",
        "chrome.runtime.sendMessage h2o-ext-p02-publish-local:v1",
        "chrome.runtime.sendMessage h2o-ext-p02-standdown-p01-writer:v1",
      ],
      persistenceOwners: [
        "platform SQLite Sync config",
        "Item 11 native destination authorization",
        "Chrome folder-import IndexedDB handle",
      ],
    },
    test: Object.freeze({
      project, projectOverview, firstActivity, folderLeaf, observationRows,
      trustedPeerOutcomeText,
    }),
    async mount(host) {
      const root = V.frame(host, {
        routeId: "settings.sync-new.local-folder",
        panelId: "h2o-settings-local-folder-panel",
        intro: "Desktop authorizes the local transfer folder. Chrome connects to that same folder and asks for live permission when needed.",
        body: V.card("Local Folder state", "<p style=\"margin:0;opacity:.7\">Reading the existing authority…</p>"),
      });
      let disposed = false;
      let message = "";
      /* One click, one response. Kept in page memory for this Studio session
       * only and never persisted - not to extension storage, not to IndexedDB,
       * not to any evidence store - and never refreshed on its own. */
      let observation = null;
      let observationError = "";
      let receiveAdmission = null;
      let manualApply = null;
      let manualApplyBusy = false;
      let p02Publication = null;
      let p02PublicationBusy = false;
      let desktopP02Receive = null;
      let desktopP02ReceiveBusy = false;
      let desktopP02Apply = null;
      let desktopP02ApplyBusy = false;
      let trustedPeerId = "";
      let trustedWriterKey = "";
      let trustedPeerBusy = false;
      let trustedPeerResult = null;
      let standdownBusy = false;
      let standdownResult = null;

      async function render() {
        const sync = W.H2O?.Studio?.sync || {};
        const chromeFolder = sync.folder && typeof sync.folder.connectFolder === "function" ? sync.folder : null;
        const platform = chromeFolder ? "chrome" : "desktop";
        let snapshot = null;
        let config = null;
        let folderName = "";
        try {
          if (chromeFolder) {
            snapshot = await chromeFolder.getReadinessSnapshot?.({ uiMounted: true });
            folderName = chromeFolder.getConnectedDirectoryHandle?.()?.name || "";
          } else {
            snapshot = await sync.getReadinessSnapshot?.({ uiMounted: true });
            config = await sync.getConfig?.();
          }
        } catch (error) {
          message = `Read blocked: ${V.clean(error?.message || error) || "authority unavailable"}`;
        }
        if (disposed) return;
        const model = project(snapshot, config, platform, folderName);
        const overview = projectOverview(snapshot, platform);
        const actions = chromeFolder
          ? `<div style="display:flex;gap:8px;flex-wrap:wrap">${V.action("connect", folderName ? "Change Folder" : "Connect Folder")}${V.action("authorize-publishing", "Authorize Chrome publishing", { disabled: !folderName })}${V.action("disconnect", "Disconnect Folder", { disabled: !folderName, danger: true })}${V.action("refresh", "Refresh live permission")}${V.action("observe-repository", "Observe repository")}${V.action("stand-down-p01-writer", "Stand Down Chrome P01 Writer", { disabled: standdownBusy || manualApplyBusy || p02PublicationBusy })}${V.action("receive-admit", "Receive / Admit", { disabled: standdownBusy || manualApplyBusy || p02PublicationBusy })}${V.action("apply-admitted-revision", "Apply admitted revision", { disabled: standdownBusy || manualApplyBusy || p02PublicationBusy })}${V.action("publish-local-revision", "Publish local revision", { disabled: standdownBusy || manualApplyBusy || p02PublicationBusy })}</div>`
          : `<div style="display:flex;gap:8px;flex-wrap:wrap">${V.action("select", config?.folderPath ? "Change Folder" : "Select Folder")}${V.action("refresh", "Refresh")}${V.action("desktop-p02-receive", "Receive from Chrome (P02 v2)", { disabled: desktopP02ReceiveBusy || desktopP02ApplyBusy })}${V.action("desktop-p02-apply", "Apply admitted Chrome revision (P02 v2)", { disabled: desktopP02ReceiveBusy || desktopP02ApplyBusy })}</div>`;
        const trustedPeerCard = chromeFolder
          ? V.card("Trusted Desktop peer",
              `<label style="display:grid;gap:5px;font-size:12px">Desktop Sync Peer ID<input type="text" data-trusted-peer-field="syncPeerId" autocomplete="off" spellcheck="false" value="${escapeAuthorityInput(trustedPeerId)}"></label>` +
              `<label style="display:grid;gap:5px;font-size:12px">Writer Key<input type="text" data-trusted-peer-field="writerKey" autocomplete="off" spellcheck="false" value="${escapeAuthorityInput(trustedWriterKey)}"></label>` +
              `<div style="display:flex;gap:8px;flex-wrap:wrap">${V.action("set-trusted-desktop-peer", "Set Trusted Desktop Peer", { disabled: trustedPeerBusy })}</div>` +
              `<p data-trusted-peer-message="1" style="margin:0;opacity:.72;font-size:12px">${V.escapeHtml(trustedPeerResult ? trustedPeerOutcomeText(trustedPeerResult) : "Enter independently authorized Desktop peer authority. Nothing is written until the trusted action.")}</p>`)
          : V.card("Trusted Chrome peer",
              `<label style="display:grid;gap:5px;font-size:12px">Chrome Sync Peer ID<input type="text" data-trusted-peer-field="syncPeerId" autocomplete="off" spellcheck="false" value="${escapeAuthorityInput(trustedPeerId)}"></label>` +
              `<label style="display:grid;gap:5px;font-size:12px">Writer Key<input type="text" data-trusted-peer-field="writerKey" autocomplete="off" spellcheck="false" value="${escapeAuthorityInput(trustedWriterKey)}"></label>` +
              `<div style="display:flex;gap:8px;flex-wrap:wrap">${V.action("set-trusted-chrome-peer", "Set Trusted Chrome Peer", { disabled: trustedPeerBusy })}</div>` +
              `<p data-trusted-peer-message="1" style="margin:0;opacity:.72;font-size:12px">${V.escapeHtml(trustedPeerResult ? trustedChromePeerOutcomeText(trustedPeerResult) : "Enter independently authorized Chrome peer authority. Nothing is written until the trusted action.")}</p>`);
        V.setBody(root,
          V.card("Sync overview", V.statusRows(overview.rows) + `<div style="display:flex;gap:8px;flex-wrap:wrap">${V.link("#/settings/convergence/relay-exchange", "Conflicts & reviews · Convergence")}${V.link("#/settings/activity", "Activity history")}</div><p style="margin:0;opacity:.68;font-size:12px;line-height:1.45">Conflicts and reviews are handled in Convergence.</p>`, { data: 'data-sync-new-overview="1"' }) +
          V.card("Local Folder state", V.statusRows(model.rows)) +
          (observation
            ? V.card("Repository observation", V.statusRows(observationRows(observation)) +
                `<p style="margin:0;opacity:.68;font-size:12px">Read-only. Captured once, on request; not stored.</p>`)
            : (observationError
              ? V.card("Repository observation", `<p style="margin:0;opacity:.72">${V.escapeHtml(observationError)}</p>`)
              : "")) +
          (receiveAdmission
            ? V.card("Receive / Admit", V.statusRows(receiveAdmissionRows(receiveAdmission)) +
                `<p style="margin:0;opacity:.68;font-size:12px">One bounded Receive/admission pass. Apply and publication remain disabled.</p>`)
            : "") +
          (manualApply
            ? V.card("Apply admitted revision", V.statusRows(manualApplyRows(manualApply)) +
                `<p style="margin:0;opacity:.68;font-size:12px">One trusted content Apply. Publication, repository writes, and WebDAV remain unreachable.</p>`)
            : "") +
          (p02Publication
            ? V.card("Publish local revision", V.statusRows(Object.freeze([
                ["Result", p02Publication?.ok === true ? "Completed" : "Blocked"],
                ["Outcome", V.valueText(p02Publication?.outcome, "unavailable")],
                ["Published", p02Publication?.published === true ? "Yes" : "No"],
                ["Eligible objects", String(Number(p02Publication?.eligibleCount) || 0)],
                ["WebDAV", p02Publication?.webdavReachable === false ? "Unreachable" : "Blocked"],
              ])) +
                `<p style="margin:0;opacity:.68;font-size:12px">One trusted Chrome P02 publication. Writer identity and candidate are resolved inside the worker.</p>`)
            : "") +
          (desktopP02Receive
            ? V.card("Desktop P02 Receive from Chrome", V.statusRows(desktopP02ReceiveRows(desktopP02Receive)) +
                `<p style="margin:0;opacity:.68;font-size:12px">One trusted v2 repository read/admission pass. It does not Apply.</p>`)
            : "") +
          (desktopP02Apply
            ? V.card("Desktop P02 Apply from Chrome", V.statusRows(desktopP02ApplyRows(desktopP02Apply)) +
                `<p style="margin:0;opacity:.68;font-size:12px">One trusted canonical Apply. It does not Receive, publish, or write the shared repository.</p>`)
            : "") +
          (standdownResult
            ? V.card("Chrome P01 writer standdown", V.statusRows(standdownRows(standdownResult)) +
                `<p style="margin:0;opacity:.68;font-size:12px">Fixed-purpose retirement of Chrome-local P01 mutation authority. It does not Receive, Apply, or publish.</p>`)
            : "") +
          trustedPeerCard +
          V.card("Routine actions", `${actions}<p data-domain-message="1" style="margin:0;opacity:.72;font-size:12px">${V.escapeHtml(message || (chromeFolder ? "Permission is queried live; it is not persisted as durable truth." : "Selection writes through the existing Item 11 authorization and Sync config APIs."))}</p>`)
        );
      }

      const removeInput = V.listen(root, "input", (event) => {
        const field = event.target?.dataset?.trustedPeerField;
        if (field === "syncPeerId") trustedPeerId = String(event.target.value ?? "");
        else if (field === "writerKey") trustedWriterKey = String(event.target.value ?? "");
      });

      const removeClick = V.listen(root, "click", async (event) => {
        const button = event.target?.closest?.("[data-domain-action]");
        if (!button || !root.contains(button)) return;
        event.preventDefault();
        const action = button.dataset.domainAction;
        if (action === "refresh") { message = "Refreshed from the live authority."; await render(); return; }
        if (action === "set-trusted-desktop-peer") {
          if (event.isTrusted !== true ||
              W.navigator?.userActivation?.isActive !== true) {
            trustedPeerResult = Object.freeze({
              schema: CONFIGURED_PEER_RESULT_SCHEMA,
              ok: false,
              outcome: "trusted-activation-required",
            });
            message = "Trusted Desktop peer blocked: trusted active user gesture required.";
            await render();
            return;
          }
          const owner = W.H2O?.Studio?.sync;
          if (typeof owner?.setTrustedDesktopPeer !== "function") {
            trustedPeerResult = null;
            message = "Trusted Desktop peer blocked: config owner unavailable.";
            await render();
            return;
          }
          button.disabled = true;
          trustedPeerBusy = true;
          try {
            trustedPeerResult = await owner.setTrustedDesktopPeer({
              syncPeerId: trustedPeerId,
              writerKey: trustedWriterKey,
            });
            message = trustedPeerOutcomeText(trustedPeerResult);
          } catch (_) {
            trustedPeerResult = Object.freeze({
              schema: CONFIGURED_PEER_RESULT_SCHEMA,
              ok: false,
              outcome: "persistence-failed",
            });
            message = trustedPeerOutcomeText(trustedPeerResult);
          } finally {
            trustedPeerBusy = false;
            await render();
          }
          return;
        }
        if (action === "set-trusted-chrome-peer") {
          if (event.isTrusted !== true ||
              W.navigator?.userActivation?.isActive !== true) {
            trustedPeerResult = Object.freeze({
              schema: CONFIGURED_PEER_RESULT_SCHEMA,
              ok: false,
              outcome: "trusted-activation-required",
            });
            message = "Trusted Chrome peer blocked: trusted active user gesture required.";
            await render();
            return;
          }
          let reverse = null;
          try { reverse = await desktopP02ReverseRuntime(); } catch (_) { /* typed below */ }
          if (typeof reverse?.configureChromePeer !== "function") {
            trustedPeerResult = null;
            message = "Trusted Chrome peer blocked: config owner unavailable.";
            await render();
            return;
          }
          button.disabled = true;
          trustedPeerBusy = true;
          try {
            trustedPeerResult = await reverse.configureChromePeer({
              syncPeerId: trustedPeerId,
              writerKey: trustedWriterKey,
            });
            message = trustedChromePeerOutcomeText(trustedPeerResult);
          } catch (_) {
            trustedPeerResult = Object.freeze({
              schema: CONFIGURED_PEER_RESULT_SCHEMA,
              ok: false,
              outcome: "persistence-failed",
            });
            message = trustedChromePeerOutcomeText(trustedPeerResult);
          } finally {
            trustedPeerBusy = false;
            await render();
          }
          return;
        }
        if (action === "desktop-p02-receive" || action === "desktop-p02-apply") {
          if (event.isTrusted !== true ||
              W.navigator?.userActivation?.isActive !== true) {
            const isReceive = action === "desktop-p02-receive";
            const result = Object.freeze({
              schema: isReceive ? P02_DESKTOP_RECEIVE_RESULT_SCHEMA
                : P02_DESKTOP_APPLY_RESULT_SCHEMA,
              ok: false,
              outcome: "trusted-activation-required",
            });
            if (isReceive) desktopP02Receive = result;
            else desktopP02Apply = result;
            message = `${isReceive ? "Receive" : "Apply"} blocked: trusted active user gesture required.`;
            await render();
            return;
          }
          const isReceive = action === "desktop-p02-receive";
          button.disabled = true;
          if (isReceive) desktopP02ReceiveBusy = true;
          else desktopP02ApplyBusy = true;
          try {
            const reverse = await desktopP02ReverseRuntime();
            const result = isReceive
              ? await reverse.receiveFromChrome()
              : await reverse.applyAdmittedFromChrome();
            if (isReceive) desktopP02Receive = result;
            else desktopP02Apply = result;
            message = result?.ok === true
              ? `${isReceive ? "Receive" : "Apply"} completed once.`
              : `${isReceive ? "Receive" : "Apply"} blocked: ${V.valueText(result?.outcome, "unavailable")}`;
          } catch (error) {
            const result = Object.freeze({
              schema: isReceive ? P02_DESKTOP_RECEIVE_RESULT_SCHEMA
                : P02_DESKTOP_APPLY_RESULT_SCHEMA,
              ok: false,
              outcome: V.clean(error?.code || error?.message) || "runtime-unavailable",
            });
            if (isReceive) desktopP02Receive = result;
            else desktopP02Apply = result;
            message = `${isReceive ? "Receive" : "Apply"} blocked: ${result.outcome}`;
          } finally {
            if (isReceive) desktopP02ReceiveBusy = false;
            else desktopP02ApplyBusy = false;
            await render();
          }
          return;
        }
        if (action === "stand-down-p01-writer") {
          if (event.isTrusted !== true ||
              W.navigator?.userActivation?.isActive !== true) {
            standdownResult = Object.freeze({
              schema: P01_WRITER_STANDDOWN_RESULT_SCHEMA,
              ok: false,
              outcome: "trusted-activation-required",
            });
            message = standdownOutcomeText(standdownResult);
            await render();
            return;
          }
          button.disabled = true;
          const receiveButton = root.querySelector?.(
            '[data-domain-action="receive-admit"]');
          if (receiveButton) receiveButton.disabled = true;
          standdownBusy = true;
          try {
            standdownResult = await standDownP01WriterOnce();
            message = standdownOutcomeText(standdownResult);
          } finally {
            standdownBusy = false;
            await render();
          }
          return;
        }
        if (action === "receive-admit") {
          if (event.isTrusted !== true ||
              W.navigator?.userActivation?.isActive !== true) {
            message = "Receive / Admit blocked: trusted active user gesture required.";
            await render();
            return;
          }
          button.disabled = true;
          try {
            const response = await receiveAdmitOnce();
            receiveAdmission = response;
            message = response?.ok === true
              ? "Receive / Admit completed once."
              : `Receive / Admit blocked: ${V.valueText(response?.error, "unavailable")}`;
          } finally {
            await render();
          }
          return;
        }
        if (action === "apply-admitted-revision") {
          if (event.isTrusted !== true ||
              W.navigator?.userActivation?.isActive !== true) {
            manualApply = Object.freeze({
              schema: P02_W3_RESULT_SCHEMA,
              ok: false,
              outcome: "trusted-activation-required",
            });
            message = "Apply blocked: trusted active user gesture required.";
            await render();
            return;
          }
          button.disabled = true;
          manualApplyBusy = true;
          try {
            manualApply = await applyAdmittedRevisionOnce();
            message = manualApply?.ok === true
              ? `Apply completed: ${V.valueText(manualApply.outcome, "applied")}.`
              : `Apply blocked: ${V.valueText(manualApply?.outcome, "unavailable")}`;
          } finally {
            manualApplyBusy = false;
            await render();
          }
          return;
        }
        if (action === "publish-local-revision") {
          if (event.isTrusted !== true ||
              W.navigator?.userActivation?.isActive !== true) {
            p02Publication = Object.freeze({
              schema: P02_PUBLISH_RESULT_SCHEMA,
              ok: false,
              outcome: "trusted-activation-required",
            });
            message = "Publication blocked: trusted active user gesture required.";
            await render();
            return;
          }
          button.disabled = true;
          p02PublicationBusy = true;
          try {
            p02Publication = await publishLocalRevisionOnce();
            message = p02Publication?.ok === true
              ? `Publication completed: ${V.valueText(p02Publication.outcome, "completed")}.`
              : `Publication blocked: ${V.valueText(p02Publication?.outcome, "unavailable")}`;
          } finally {
            p02PublicationBusy = false;
            await render();
          }
          return;
        }
        if (action === "observe-repository") {
          /* Explicit Human activation is the ONLY thing that reaches the
           * background observer. Nothing here runs on mount, on render, on a
           * timer or on a folder-state change. */
          button.disabled = true;
          try {
            const readiness = await confirmWorkerReady();
            if (!readiness.ready) {
              /* Phase A never confirmed, so Phase B is not sent at all: this
               * click produced zero observation requests. */
              observation = null;
              observationError = `Observation blocked: ${
                V.valueText(readiness.error, "unavailable")}`;
              message = observationError;
              return;
            }
            const response = await observeRepositoryOnce();
            if (response?.ok === true) {
              observation = response.observation || null;
              observationError = "";
              message = "Observed the repository read-only.";
            } else {
              observation = null;
              observationError = `Observation blocked: ${V.valueText(response?.error, "unavailable")}`;
              message = observationError;
            }
          } finally {
            await render();
          }
          return;
        }
        button.disabled = true;
        try {
          const sync = W.H2O?.Studio?.sync || {};
          const chromeFolder = sync.folder && typeof sync.folder.connectFolder === "function" ? sync.folder : null;
          let result;
          if (action === "connect" && chromeFolder) result = await chromeFolder.connectFolder();
          else if (action === "authorize-publishing" && chromeFolder) result = await chromeFolder.authorizeChromePublishing();
          else if (action === "disconnect" && chromeFolder) result = await chromeFolder.disconnectFolder();
          else if (action === "select") {
            await panels.loadScriptOnce("./sync/browser-delivery-producer.tauri.js", () =>
              typeof W.H2O?.Desktop?.SyncObjectDelivery?.selectDeliveryFolder === "function");
            result = await W.H2O.Desktop.SyncObjectDelivery.selectDeliveryFolder();
          }
          if (action === "authorize-publishing") {
            message = result?.ok === true
              ? "Chrome publishing is authorized. Automatic Sync has been scheduled."
              : (result?.permission === "denied"
                ? "Chrome publishing authorization was denied."
                : "Chrome publishing authorization is still required.");
          } else {
            message = result?.ok === true ? V.valueText(result.status || result.verdict, "Completed")
              : `Blocked: ${V.valueText(result?.errorCode || result?.status, "operation unavailable")}`;
          }
        } catch (error) {
          message = `Blocked: ${V.clean(error?.message || error) || "operation unavailable"}`;
        }
        await render();
      });
      await render();
      return () => { disposed = true; removeInput(); removeClick(); };
    },
  });
})();
