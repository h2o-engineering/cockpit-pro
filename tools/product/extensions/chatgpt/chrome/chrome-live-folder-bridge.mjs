// @version 1.2.0
// P02 T02: the existing read operations (getFoldersList, resolveFolderBindings)
// gain a STRICT mode (payload.strict === true) that reads the page-world
// H2O.folders authority only and fails closed with a typed
// relationship-source-unavailable error instead of any localStorage fallback.
// Non-strict callers keep the exact prior behaviour.
// P02 T05 (Host lease EXT-P02-T05-HOST-CHROME-RELATIONSHIP-WRITE-ADAPTER):
// two STRICT relationship WRITE operations for the Sync counterpart -
// applyFolderMetadataOperation (create-with-verbatim-id / rename through the
// H2O-owned H2O.folders.applyMetadataOperation) and setFolderBinding in strict
// mode (bind / move / unbind through H2O.folders.setBinding), each read back
// through the strict owner reads and tagged as an H2O Folder owner result.
// They fail closed when the owner API is absent or refuses, and never touch
// localStorage, the archive stamp or any cache. Non-strict setFolderBinding
// keeps its exact prior behaviour.
export function makeChromeLiveFolderBridgePageJs() {
  return `"use strict";
(() => {
  if (window.__H2O_EXT_FOLDER_BRIDGE_V1__) return;
  window.__H2O_EXT_FOLDER_BRIDGE_V1__ = true;

  const MSG_REQ = ${JSON.stringify("h2o-ext-folders:v1:req")};
  const MSG_RES = ${JSON.stringify("h2o-ext-folders:v1:res")};
  const DEFAULT_NS = ${JSON.stringify("h2o:prm:cgx:h2odata")};

  function normalizeNsDisk(raw) {
    const ns = String(raw || DEFAULT_NS).trim();
    return ns || DEFAULT_NS;
  }

  function normalizeChatId(raw) {
    return String(raw || "").trim();
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(String(key));
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(String(key), JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function normalizeHexColor(raw) {
    const value = String(raw || "").trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : "";
  }

  function delKey(key) {
    try {
      localStorage.removeItem(String(key));
      return true;
    } catch {
      return false;
    }
  }

  function foldersApi() {
    const f = window.H2O && window.H2O.folders;
    return (f && typeof f === "object") ? f : null;
  }

  function normalizeFolderEntry(raw) {
    const id = String(raw && (raw.id || raw.folderId) || "").trim();
    if (!id) return null;
    const out = {
      id,
      name: String(raw && (raw.name || raw.title || id) || id).trim() || id,
      createdAt: String(raw && raw.createdAt || "").trim(),
    };
    const iconColor = normalizeHexColor(raw && (raw.iconColor || raw.color || raw.folderColor || raw.accentColor || raw.appearance && raw.appearance.color));
    if (iconColor) out.iconColor = iconColor;
    return out;
  }

  function normalizeFolderList(raw) {
    const src = Array.isArray(raw) ? raw : [];
    const out = [];
    const seen = new Set();
    for (const row of src) {
      const item = normalizeFolderEntry(row);
      if (!item || seen.has(item.id)) continue;
      out.push(item);
      seen.add(item.id);
    }
    return out;
  }

  function tryLoadFoldersFallback() {
    const keys = [
      "h2o:prm:cgx:fldrs:state:data:v1",
      "h2o:folders:v1",
      "h2o:prm:cgx:folders:v1",
      "H2O:folders:v1",
    ];
    for (const key of keys) {
      const value = readJson(key, null);
      if (Array.isArray(value)) return value;
      if (value && Array.isArray(value.folders)) return value.folders;
    }
    return [];
  }

  function getFoldersList() {
    const api = foldersApi();
    try {
      if (typeof (api && api.list) === "function") return normalizeFolderList(api.list());
      if (typeof (api && api.getAll) === "function") return normalizeFolderList(api.getAll());
      if (api && Array.isArray(api.folders)) return normalizeFolderList(api.folders);
    } catch {}
    return normalizeFolderList(tryLoadFoldersFallback());
  }

  /* ---- P02 T02 strict reads: page-world H2O.folders authority only ---- */
  const STRICT_SOURCE = "H2O.folders";
  const STRICT_UNAVAILABLE = "relationship-source-unavailable";

  function strictUnavailable(detail) {
    const error = new Error(STRICT_UNAVAILABLE + ":" + String(detail || "h2o-folders-unavailable"));
    error.code = STRICT_UNAVAILABLE;
    return error;
  }

  function strictFoldersApi() {
    const api = foldersApi();
    if (!api) throw strictUnavailable("h2o-folders-api-missing");
    return api;
  }

  // Verbatim authority fields the P02 projection needs; nothing is invented,
  // coerced or merged. Colour is deliberately not carried (deferred).
  function strictFolderRecord(raw) {
    if (!raw || typeof raw !== "object") return null;
    const out = {
      id: raw.id !== undefined ? raw.id : raw.folderId,
      name: raw.name !== undefined ? raw.name : raw.title,
    };
    for (const key of ["kind", "projectRef", "createdAt", "updatedAt", "parentId", "parent_id", "sourceKind", "system", "virtual", "view"]) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) out[key] = raw[key];
    }
    return out;
  }

  function getFoldersListStrict() {
    const api = strictFoldersApi();
    if (typeof api.list !== "function") throw strictUnavailable("h2o-folders-list-missing");
    let raw;
    try {
      raw = api.list();
    } catch (error) {
      throw strictUnavailable("h2o-folders-list-threw");
    }
    if (!Array.isArray(raw)) throw strictUnavailable("h2o-folders-list-invalid");
    return { source: STRICT_SOURCE, strict: true, folders: raw.map(strictFolderRecord) };
  }

  function resolveFolderBindingsStrict(chatIds) {
    const api = strictFoldersApi();
    if (typeof api.getBinding !== "function") throw strictUnavailable("h2o-folders-get-binding-missing");
    const bindings = {};
    const ids = Array.isArray(chatIds) ? chatIds : [];
    for (const chatId of ids) {
      const cid = normalizeChatId(chatId);
      if (!cid) continue;
      try {
        const res = api.getBinding(cid);
        bindings[cid] = {
          folderId: String(res && (res.folderId || "") || "").trim(),
          folderName: String(res && (res.folderName || "") || "").trim(),
        };
      } catch (error) {
        bindings[cid] = { error: "relationship-source-record-threw" };
      }
    }
    return { source: STRICT_SOURCE, strict: true, bindings };
  }

  /* ---- P02 T05 strict writes: H2O Folder owner API only ---- */
  const STRICT_WRITE_UNSUPPORTED = "relationship-write-operation-unsupported";
  const FOLDER_METADATA_OPERATION_SCHEMA = "h2o.folder-metadata-operation.v1";
  const STRICT_WRITE_SOURCE_TAG = "p02-relationship-apply";

  function strictWriteUnsupported(detail) {
    const error = new Error(STRICT_WRITE_UNSUPPORTED + ":" + String(detail || "unsupported"));
    error.code = STRICT_WRITE_UNSUPPORTED;
    return error;
  }

  function strictCodes(list) {
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      const code = item && typeof item === "object" ? item.code : item;
      if (code !== undefined && code !== null && String(code) !== "") out.push(String(code));
    }
    return out;
  }

  // create-with-verbatim-id / rename through the existing owner API. The
  // operation shape is the owner's own metadata-operation contract; the
  // requested folderId is passed verbatim for create and is the exact target
  // for rename. Nothing is retried, merged or written anywhere else.
  function applyFolderMetadataOperationStrict(payload) {
    const api = strictFoldersApi();
    if (typeof api.applyMetadataOperation !== "function") throw strictUnavailable("h2o-folders-apply-metadata-operation-missing");
    const operationType = String(payload && payload.operationType || "").trim();
    if (operationType !== "create-folder" && operationType !== "rename-folder") throw strictWriteUnsupported(operationType || "operation-type-missing");
    const folderId = String(payload && payload.folderId || "").trim();
    const name = typeof (payload && payload.name) === "string" ? payload.name : "";
    if (!folderId) throw strictWriteUnsupported("folder-id-missing");
    if (!name) throw strictWriteUnsupported("folder-name-missing");
    const operation = { schema: FOLDER_METADATA_OPERATION_SCHEMA, operationType, folderId, after: { name } };
    let result;
    try {
      result = api.applyMetadataOperation(operation, {});
    } catch (error) {
      throw strictUnavailable("h2o-folders-apply-metadata-operation-threw");
    }
    if (!result || typeof result !== "object") throw strictUnavailable("h2o-folders-apply-metadata-operation-invalid");
    return {
      source: STRICT_SOURCE,
      strict: true,
      writer: "H2O.folders.applyMetadataOperation",
      ok: result.ok === true,
      applied: result.applied === true,
      noMutation: result.noMutation === true,
      writesPerformed: Number(result.writesPerformed) || 0,
      operationType,
      folderId: String(result.folderId || folderId),
      resultSchema: String(result.schema || ""),
      blockers: strictCodes(result.blockers),
      warnings: strictCodes(result.warnings),
      after: result.after && typeof result.after === "object"
        ? { id: String(result.after.id || result.after.folderId || ""), name: typeof result.after.name === "string" ? result.after.name : "" }
        : null,
    };
  }

  // bind / move (folderId set) or unbind (folderId "") through the owner's
  // setBinding, read back through the owner's getBinding. No archive stamp,
  // no localStorage mirror, no cache: the owner is the only writer.
  function setFolderBindingStrict(payload) {
    const api = strictFoldersApi();
    if (typeof api.setBinding !== "function") throw strictUnavailable("h2o-folders-set-binding-missing");
    if (typeof api.getBinding !== "function") throw strictUnavailable("h2o-folders-get-binding-missing");
    const chatId = normalizeChatId(payload && payload.chatId);
    if (!chatId) throw strictWriteUnsupported("chat-id-missing");
    const folderId = String(payload && payload.folderId || "").trim();
    let res;
    try {
      res = api.setBinding(chatId, folderId, { source: STRICT_WRITE_SOURCE_TAG, reason: STRICT_WRITE_SOURCE_TAG });
    } catch (error) {
      throw strictUnavailable("h2o-folders-set-binding-threw");
    }
    let readback;
    try {
      readback = api.getBinding(chatId);
    } catch (error) {
      throw strictUnavailable("h2o-folders-get-binding-threw");
    }
    const refused = !!res && res.ok === false;
    return {
      source: STRICT_SOURCE,
      strict: true,
      writer: "H2O.folders.setBinding",
      ok: !refused,
      status: String(res && (res.status || "") || (refused ? "rejected" : "ok")),
      reason: String(res && (res.reason || "") || ""),
      chatId,
      requestedFolderId: folderId,
      folderId: String(readback && (readback.folderId || "") || "").trim(),
      folderName: String(readback && (readback.folderName || "") || "").trim(),
    };
  }

  function setFolderIconColor(folderIdRaw, colorRaw) {
    const folderId = String(folderIdRaw || "").trim();
    if (!folderId) throw new Error("missing folderId");
    const color = normalizeHexColor(colorRaw || "");
    const api = foldersApi();
    try {
      if (api && typeof api.setFolderIconColor === "function") {
        const res = api.setFolderIconColor(folderId, color);
        return { ok: !res || res.ok !== false, folderId, iconColor: color };
      }
    } catch {}

    const keys = [
      "h2o:prm:cgx:fldrs:state:data:v1",
      "h2o:folders:data:v1",
      "h2o:folders:v1",
      "h2o:prm:cgx:folders:v1",
      "H2O:folders:v1",
    ];
    let changed = false;
    for (const key of keys) {
      const value = readJson(key, null);
      const folders = Array.isArray(value) ? value : (value && Array.isArray(value.folders) ? value.folders : null);
      if (!folders) continue;
      let hit = false;
      const nextFolders = folders.map((row) => {
        const id = String(row && (row.id || row.folderId) || "").trim();
        if (id !== folderId || !row || typeof row !== "object") return row;
        hit = true;
        const next = { ...row, updatedAt: new Date().toISOString() };
        if (color) next.iconColor = color;
        else delete next.iconColor;
        return next;
      });
      if (!hit) continue;
      const nextValue = Array.isArray(value) ? nextFolders : { ...value, folders: nextFolders, updatedAt: new Date().toISOString() };
      changed = writeJson(key, nextValue) || changed;
    }
    if (changed) {
      try {
        window.dispatchEvent(new CustomEvent("evt:h2o:folders:changed", {
          detail: { action: "folder-appearance", folderId, iconColor: color, source: "ext-folder-bridge", ts: Date.now() },
        }));
      } catch {}
    }
    return { ok: changed, folderId, iconColor: color };
  }

  function keyArchiveFolder(chatId, nsDisk) {
    return normalizeNsDisk(nsDisk) + ":archiveFolder:" + normalizeChatId(chatId) + ":v1";
  }

  function resolveFolderInfo(folderId) {
    const id = String(folderId || "").trim();
    if (!id) return { folderId: "", folderName: "" };
    const folders = getFoldersList();
    for (const folder of folders) {
      const fid = String(folder && (folder.id || folder.folderId) || "").trim();
      if (!fid || fid !== id) continue;
      return {
        folderId: id,
        folderName: String(folder && (folder.name || folder.title || id) || id).trim() || id,
      };
    }
    return { folderId: id, folderName: id };
  }

  function resolveFolderBinding(chatId, nsDisk) {
    const id = normalizeChatId(chatId);
    if (!id) return { folderId: "", folderName: "" };
    const api = foldersApi();
    try {
      if (api && typeof api.getBinding === "function") {
        const res = api.getBinding(id);
        const folderId = String(res && (res.folderId || res.id) || "").trim();
        if (folderId) {
          const info = resolveFolderInfo(folderId);
          return {
            folderId,
            folderName: String(res && (res.folderName || res.name) || info.folderName || folderId).trim() || folderId,
          };
        }
      }
    } catch {}
    const raw = readJson(keyArchiveFolder(id, nsDisk), null);
    const folderId = String(raw && (raw.folderId || raw.id) || "").trim();
    if (!folderId) return { folderId: "", folderName: "" };
    const info = resolveFolderInfo(folderId);
    return { folderId, folderName: info.folderName || "" };
  }

  function setFolderBinding(chatId, folderIdRaw, nsDisk) {
    const id = normalizeChatId(chatId);
    if (!id) throw new Error("missing chatId");
    const folderId = String(folderIdRaw || "").trim();
    const api = foldersApi();
    if (api && typeof api.setBinding === "function") {
      const res = api.setBinding(id, folderId);
      if (res && res.ok === false) {
        return {
          ok: false,
          chatId: id,
          folderId: String(res.folderId || ""),
          folderName: String(res.folderName || ""),
          status: String(res.status || res.reason || "rejected"),
          reason: String(res.reason || res.status || "rejected"),
        };
      }
      const info = folderId ? resolveFolderInfo(folderId) : { folderId: "", folderName: "" };
      const effectiveId = String(res && (res.folderId || res.id) || info.folderId || "").trim();
      const effectiveName = String(res && (res.folderName || res.name) || info.folderName || effectiveId).trim();
      if (effectiveId) {
        writeJson(keyArchiveFolder(id, nsDisk), {
          folderId: effectiveId,
          folderName: effectiveName,
          updatedAt: new Date().toISOString(),
        });
      } else {
        delKey(keyArchiveFolder(id, nsDisk));
      }
      return {
        ok: !res || res.ok !== false,
        chatId: id,
        folderId: effectiveId,
        folderName: effectiveName,
        status: String(res && res.status || "ok"),
      };
    }
    if (!folderId) {
      delKey(keyArchiveFolder(id, nsDisk));
      try {
        const upsert = window.H2O && window.H2O.archiveBoot && typeof window.H2O.archiveBoot.upsertLatestSnapshotMeta === "function"
          ? window.H2O.archiveBoot.upsertLatestSnapshotMeta.bind(window.H2O.archiveBoot)
          : null;
        if (upsert) Promise.resolve(upsert(id, { folderId: "", folderName: "" }, { source: "ext-folder-bridge" })).catch(() => {});
      } catch {}
      return { ok: true, chatId: id, folderId: "", folderName: "" };
    }
    const info = resolveFolderInfo(folderId);
    writeJson(keyArchiveFolder(id, nsDisk), {
      folderId: info.folderId,
      folderName: info.folderName,
      updatedAt: new Date().toISOString(),
    });
    try {
      const upsert = window.H2O && window.H2O.archiveBoot && typeof window.H2O.archiveBoot.upsertLatestSnapshotMeta === "function"
        ? window.H2O.archiveBoot.upsertLatestSnapshotMeta.bind(window.H2O.archiveBoot)
        : null;
      if (upsert) Promise.resolve(upsert(id, { folderId: info.folderId, folderName: info.folderName }, { source: "ext-folder-bridge" })).catch(() => {});
    } catch {}
    return { ok: true, chatId: id, folderId: info.folderId, folderName: info.folderName };
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.type !== MSG_REQ) return;
    const id = String(data.id || "");
    const req = data.req && typeof data.req === "object" ? data.req : {};
    const op = String(req.op || "").trim();
    const payload = req.payload && typeof req.payload === "object" ? req.payload : {};
    const nsDisk = normalizeNsDisk(req.nsDisk);
    try {
      let result = null;
      const strict = payload.strict === true;
      if (op === "getFoldersList") {
        result = strict ? getFoldersListStrict() : getFoldersList();
      } else if (op === "resolveFolderBindings" && strict) {
        result = resolveFolderBindingsStrict(payload.chatIds);
      } else if (op === "resolveFolderBindings") {
        const out = {};
        const ids = Array.isArray(payload.chatIds) ? payload.chatIds : [];
        for (const chatId of ids) {
          const cid = normalizeChatId(chatId);
          if (!cid) continue;
          out[cid] = resolveFolderBinding(cid, nsDisk);
        }
        result = out;
      } else if (op === "setFolderBinding" && strict) {
        result = setFolderBindingStrict(payload);
      } else if (op === "setFolderBinding") {
        result = setFolderBinding(payload.chatId, payload.folderId, nsDisk);
      } else if (op === "applyFolderMetadataOperation" && strict) {
        result = applyFolderMetadataOperationStrict(payload);
      } else if (op === "setFolderIconColor") {
        result = setFolderIconColor(payload.folderId, payload.iconColor || payload.color || "");
      } else {
        throw new Error("unsupported folders op: " + op);
      }
      window.postMessage({ type: MSG_RES, id, ok: true, result }, "*");
    } catch (error) {
      window.postMessage({
        type: MSG_RES,
        id,
        ok: false,
        error: String(error && (error.stack || error.message || error)),
      }, "*");
    }
  }, false);
})();
`;
}
