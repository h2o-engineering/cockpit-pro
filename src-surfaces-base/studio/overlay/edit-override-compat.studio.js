/* Authoring edit-override compatibility projection over the canonical overlay.
 * Renderer reads this projection synchronously; editOverlay remains the only
 * durable record and RibbonBridge remains the text-replace operation path.
 */
(function (global) {
  "use strict";

  const H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  const authoring = H2O.Studio.authoring = H2O.Studio.authoring || {};
  if (authoring.editOverrideCompat?.__installed) return;

  const projectionBySnapshot = new Map();
  let getCurrentSnapshotId = null;
  let applyOverlayOp = null;

  function project(overlay) {
    const view = new Map();
    try {
      const applier = H2O.Studio.overlay;
      if (!overlay || typeof applier?.computeMessageState !== "function") return view;
      const turnIndexes = new Set();
      (Array.isArray(overlay.ops) ? overlay.ops : []).forEach((op) => {
        const idx = Number(op?.target?.turnIdx);
        if (op?.target?.kind === "message" && Number.isInteger(idx) && idx > 0) turnIndexes.add(idx);
      });
      turnIndexes.forEach((idx) => {
        const body = applier.computeMessageState(overlay, idx)?.textReplace?.body;
        if (typeof body === "string") view.set(idx, body);
      });
    } catch (_) {}
    return view;
  }

  function updateFromOverlay(snapshotId, overlay) {
    const sid = String(snapshotId || "").trim();
    if (!sid) return new Map();
    const view = project(overlay);
    projectionBySnapshot.set(sid, view);
    return view;
  }

  async function hydrate(snapshotId) {
    const sid = String(snapshotId || "").trim();
    if (!sid) return null;
    try {
      const store = H2O.Studio.store?.editOverlay;
      if (!store || typeof store.get !== "function") {
        projectionBySnapshot.set(sid, new Map());
        return null;
      }
      const overlay = await store.get(sid);
      updateFromOverlay(sid, overlay || null);
      return overlay || null;
    } catch (_) {
      projectionBySnapshot.set(sid, new Map());
      return null;
    }
  }

  function get(snapshotId, turnIdx) {
    const sid = String(snapshotId || "").trim();
    const idx = Number(turnIdx);
    if (!sid || !Number.isInteger(idx) || idx < 1) return null;
    const view = projectionBySnapshot.get(sid);
    return view && view.has(idx) ? view.get(idx) : null;
  }

  function set(snapshotId, turnIdx, text) {
    try {
      const sid = String(snapshotId || "").trim();
      const idx = Number(turnIdx);
      if (!sid || !Number.isInteger(idx) || idx < 1) return false;
      if (typeof getCurrentSnapshotId !== "function" ||
          String(getCurrentSnapshotId() || "").trim() !== sid ||
          typeof applyOverlayOp !== "function") return false;

      const previous = projectionBySnapshot.get(sid);
      const view = new Map(previous || []);
      view.set(idx, String(text));
      projectionBySnapshot.set(sid, view);
      let dispatched;
      try {
        dispatched = applyOverlayOp({
          type: "text-replace",
          target: { kind: "message", turnIdx: idx, messageId: null },
          payload: { text: String(text) },
        });
      } catch (_) {
        if (previous) projectionBySnapshot.set(sid, previous);
        else projectionBySnapshot.delete(sid);
        return false;
      }
      if (dispatched === undefined) {
        if (previous) projectionBySnapshot.set(sid, previous);
        else projectionBySnapshot.delete(sid);
        return false;
      }
      Promise.resolve(dispatched).then((result) => {
        if (result?.ok && result.overlay) updateFromOverlay(sid, result.overlay);
        else hydrate(sid).catch(() => {});
      }, () => { hydrate(sid).catch(() => {}); });
      return true;
    } catch (_) {
      return false;
    }
  }

  async function removeSnapshot(snapshotId) {
    const sid = String(snapshotId || "").trim();
    if (!sid) return false;
    projectionBySnapshot.delete(sid);
    try {
      const store = H2O.Studio.store?.editOverlay;
      if (!store || typeof store.remove !== "function") return false;
      return await store.remove(sid) === true;
    } catch (_) {
      return false;
    }
  }

  authoring.editOverrideCompat = Object.freeze({
    __installed: true,
    schema: "h2o.studio.authoring-edit-override-compat",
    version: "1.0.0",
    configure(collaborators) {
      getCurrentSnapshotId = collaborators?.getCurrentSnapshotId;
      applyOverlayOp = collaborators?.applyOverlayOp;
    },
    updateFromOverlay,
    hydrate,
    get,
    set,
    removeSnapshot,
  });
})(window);
