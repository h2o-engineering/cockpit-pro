// ==UserScript==
// @h2o-id             s0f1f.library_maintenance.studio
// @name               S0F1f. 🎬 Library Maintenance - Studio
// @namespace          H2O.Premium.CGX.library_maintenance.studio
// @author             HumamDev
// @version            1.0.0
// @revision           001
// @build              260511-000008
// @description        Studio Library Maintenance: diagnostics, store inspection, registry inspection, snapshot import/export, and repair routines. Exposes H2O.Library.Maintenance. In native this also wires the Command Bar Library group; in Studio (no Command Bar yet) it registers entries via the surface command-bar service so a future Studio Command Bar can read them.
// @match              https://chatgpt.com/*
// @run-at             document-idle
// @grant              none
// ==/UserScript==

(() => {
  'use strict';

  console.log('H2O DEV LOAD ✅ S0F1f Library Maintenance (Studio)', Date.now());

  const W = window;
  const H2O = (W.H2O = W.H2O || {});
  H2O.Library = H2O.Library || {};

  const diag = { t0: performance.now(), steps: [], errors: [], bufMax: 60, errMax: 20 };
  const step = (s, o = '') => {
    try {
      diag.steps.push({ t: Math.round(performance.now() - diag.t0), s: String(s || ''), o: String(o || '') });
      if (diag.steps.length > diag.bufMax) diag.steps.splice(0, diag.steps.length - diag.bufMax);
    } catch {}
  };
  const err = (s, e) => {
    try {
      diag.errors.push({ t: Math.round(performance.now() - diag.t0), s: String(s || ''), e: String(e?.stack || e || '') });
      if (diag.errors.length > diag.errMax) diag.errors.splice(0, diag.errors.length - diag.errMax);
    } catch {}
  };

  function getCore() { return H2O.LibraryCore || null; }
  function getStore() { return H2O.Library?.Store || null; }
  function getRegistry() { return H2O.ChatRegistry || null; }
  function getIndex() { return H2O.LibraryIndex || null; }
  function getWorkspace() { return H2O.LibraryWorkspace || null; }
  function getCmdBar() { return getCore()?.getService?.('command-bar') || null; }

  // ── Inspections (read-only) ────────────────────────────────────────────────
  async function inspectStore() {
    const store = getStore();
    if (!store) return { ok: false, reason: 'no-store' };
    try {
      const keys = await store.listKeys('h2o:');
      const estimate = await store.estimate();
      return {
        ok: true,
        backend: store.backend(),
        caps: store.caps(),
        keysCount: keys.length,
        keysSample: keys.slice(0, 30),
        estimate,
      };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  }

  async function inspectRegistry() {
    const reg = getRegistry();
    if (!reg) return { ok: false, reason: 'no-registry' };
    try {
      const all = await reg.listAll();
      return {
        ok: true,
        diagnose: reg.diagnose(),
        size: all.length,
        sample: all.slice(0, 12),
      };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  }

  function inspectIndex() {
    const idx = getIndex();
    if (!idx) return { ok: false, reason: 'no-index' };
    return { ok: true, diagnose: idx.diagnose(), counts: idx.counts() };
  }

  function inspectWorkspace() {
    const ws = getWorkspace();
    if (!ws) return { ok: false, reason: 'no-workspace' };
    return { ok: true, diagnose: ws.diagnose() };
  }

  function inspectCore() {
    const core = getCore();
    if (!core) return { ok: false, reason: 'no-core' };
    return {
      ok: true,
      diagnose: core.diagnose(),
      selfCheck: core.selfCheck(),
    };
  }

  // ── Snapshot import/export ─────────────────────────────────────────────────
  async function exportSnapshot() {
    const reg = getRegistry();
    const idx = getIndex();
    const store = getStore();
    return {
      version: 1,
      surface: 'studio',
      capturedAt: Date.now(),
      core: getCore()?.diagnose?.() || null,
      registry: reg ? { diag: reg.diagnose(), records: await reg.listAll() } : null,
      indexCounts: idx?.counts?.() || null,
      store: store ? {
        backend: store.backend(),
        caps: store.caps(),
        keys: await store.listKeys('h2o:prm:cgx:library:'),
      } : null,
    };
  }

  async function importSnapshot(snap) {
    if (!snap || typeof snap !== 'object') throw new Error('invalid snapshot');
    const reg = getRegistry();
    if (reg && Array.isArray(snap.registry?.records)) {
      await reg.upsertMany(snap.registry.records);
    }
    step('import.ok', `${snap.registry?.records?.length || 0} chats`);
    return { ok: true };
  }

  // ── Repair routines ────────────────────────────────────────────────────────
  async function rebuildIndex() {
    const idx = getIndex();
    if (!idx) return { ok: false, reason: 'no-index' };
    await idx.refresh('maintenance.rebuild');
    return { ok: true, counts: idx.counts() };
  }

  async function cleanupStaleRegistryEntries({ olderThanDays = 365 } = {}) {
    const reg = getRegistry();
    if (!reg) return { ok: false, reason: 'no-registry' };
    const all = await reg.listAll();
    const cutoff = Date.now() - olderThanDays * 86400_000;
    const stale = all.filter((c) => c.deleted && Number(c.deletedAt || 0) < cutoff);
    for (const c of stale) await reg.markDeleted(c.chatId).catch(() => {});
    return { ok: true, removed: stale.length };
  }

  // ── Folder-maintenance review model (C5-D, read-only) ──────────────────────
  // Library-owned classification of FolderParity facts into a review plan.
  // buildFolderReviewPlan is synchronous and reads nothing beyond the supplied
  // selfCheck / displayModel; getFolderReviewPlan only orchestrates the existing
  // FolderParity.selfCheck + getDisplayModel reads. Neither performs storage,
  // Sync/mirror, binding or deletion work, and no plan field grants mutation
  // authority: classification / proposedAction / riskLevel / requiresApproval /
  // reversible / warnings are review metadata only.
  function folderReviewCount(value) {
    const n = Number(value || 0);
    return Number.isFinite(n) ? n : 0;
  }

  function folderReviewRowBindingCount(row) {
    return Math.max(
      folderReviewCount(row?.bindingCount),
      folderReviewCount(row?.localBindingCount)
    );
  }

  // Desktop/F5D review rows stay review-only even with zero binding/known counts.
  function folderReviewIsF5DReviewCandidate(row) {
    const src = row && typeof row === 'object' ? row : {};
    const parts = [
      src.folderId,
      src.id,
      src.name,
      src.normalizedName,
    ].map((value) => String(value || ''));
    return parts.some((value) => /f5d/i.test(value));
  }

  function buildFolderReviewCandidate(row, classification, opts = {}) {
    const src = row && typeof row === 'object' ? row : {};
    const folderId = String(src.folderId || src.id || opts.folderId || '').trim();
    const name = String(src.name || opts.name || folderId || 'Folder review item').trim();
    const knownCount = folderReviewCount(src.knownCount ?? src.knownStudioCount);
    const localBindingCount = folderReviewRowBindingCount(src);
    const bindingCount = Math.max(localBindingCount, knownCount);
    const canonicalCount = folderReviewCount(src.canonicalCount ?? src.nativeMembershipCount);
    const orphanCount = folderReviewCount(src.orphanCount || opts.orphanCount);
    const warnings = Array.isArray(opts.warnings) ? opts.warnings.slice() : [];
    const badges = Array.isArray(src.badges) ? src.badges.map((badge) => String(badge || '').trim()).filter(Boolean) : [];
    const isCanonical = !!src.isCanonical || !!opts.isCanonical;
    const isConflict = !!src.isConflict || classification === 'same-name-conflict';
    const isTestCandidate = !!src.isTestCandidate;
    const isExtra = !!src.isExtra;
    const nativePresence = isCanonical || !!opts.nativePresence;

    if (isCanonical) warnings.push('Protected canonical folder. Never a cleanup candidate.');
    if (isConflict) warnings.push('Same-name/different-ID conflict. Review-only; no automatic merge.');
    if (bindingCount > 0 && !isCanonical) warnings.push('Folder has local bindings or known rows. Review-only.');
    if (orphanCount > 0) warnings.push('Native memberships are not represented by known Studio rows.');
    if (folderReviewIsF5DReviewCandidate(src)) {
      warnings.push('Desktop/F5D review required.');
      warnings.push('Not eligible for Chrome mirror P7b deletion.');
    }

    let proposedAction = 'Review only. No P7a mutation is available.';
    let riskLevel = 'review';
    let requiresApproval = true;
    if (classification === 'safe-empty') {
      proposedAction = 'Future P8i cleanup candidate only after explicit preview and typed approval.';
      riskLevel = 'low-review-required';
    } else if (classification === 'orphan-membership') {
      proposedAction = 'Review membership coverage. Not a folder removal candidate.';
      riskLevel = 'review-required';
    } else if (classification === 'canonical-protected') {
      proposedAction = 'Preserve canonical folder.';
      riskLevel = 'protected';
      requiresApproval = false;
    } else if (classification === 'bound-review') {
      proposedAction = 'Inspect bindings before any future action.';
      riskLevel = 'high-review-required';
    } else if (classification === 'same-name-conflict') {
      proposedAction = 'Resolve only through a future conflict review plan.';
      riskLevel = 'high-review-required';
    } else if (classification === 'unsafe-to-delete') {
      proposedAction = 'Keep review-only until a later plan explains exact ownership and blockers.';
      riskLevel = 'high-review-required';
    }

    return {
      folderId,
      name,
      normalizedName: String(src.normalizedName || name).trim().toLowerCase(),
      classification,
      source: String(src.source || opts.source || '').trim(),
      kind: String(src.kind || opts.kind || '').trim(),
      surface: String(opts.surface || src.surface || ''),
      isCanonical,
      isExtra,
      isTestCandidate,
      isConflict,
      bindingCount,
      canonicalCount,
      nativeMembershipCount: canonicalCount,
      knownCount,
      localBindingCount,
      savedCount: folderReviewCount(src.savedCount),
      linkedCount: folderReviewCount(src.linkedCount),
      orphanCount,
      badges,
      displayCountLabel: String(src.displayCountLabel || opts.displayCountLabel || '').trim(),
      nativePresence,
      proposedAction,
      riskLevel,
      requiresApproval,
      reversible: false,
      warnings: Array.from(new Set(warnings.filter(Boolean))),
    };
  }

  function buildFolderReviewPlan(selfCheck, displayModel) {
    const rows = Array.isArray(displayModel?.rows) ? displayModel.rows : [];
    const surface = String(selfCheck?.surface || displayModel?.surface || '');
    const rowCandidate = (row, classification, opts = {}) => buildFolderReviewCandidate(row, classification, { ...opts, surface });
    const isSafeEmpty = (row) => {
      const bindingCount = folderReviewRowBindingCount(row);
      const knownCount = folderReviewCount(row?.knownCount);
      return !row?.isCanonical
        && (!!row?.isExtra || !!row?.isTestCandidate)
        && !row?.isConflict
        && !folderReviewIsF5DReviewCandidate(row)
        && bindingCount === 0
        && knownCount === 0;
    };
    const safeEmptyCandidates = rows
      .filter(isSafeEmpty)
      .map((row) => rowCandidate(row, 'safe-empty', { nativePresence: false }));
    const sameNameConflicts = rows
      .filter((row) => !row?.isCanonical && !!row?.isConflict)
      .map((row) => rowCandidate(row, 'same-name-conflict', { nativePresence: false }));
    const boundReviewCandidates = rows
      .filter((row) => {
        const bindingCount = folderReviewRowBindingCount(row);
        const knownCount = folderReviewCount(row?.knownCount);
        return !row?.isCanonical
          && (!!row?.isExtra || !!row?.isTestCandidate)
          && !row?.isConflict
          && (bindingCount > 0 || knownCount > 0 || folderReviewIsF5DReviewCandidate(row));
      })
      .map((row) => rowCandidate(row, 'bound-review', { nativePresence: false }));
    const orphanRows = rows
      .filter((row) => !!row?.isCanonical && folderReviewCount(row?.orphanCount) > 0)
      .map((row) => rowCandidate(row, 'orphan-membership', {
        isCanonical: true,
        nativePresence: true,
        orphanCount: folderReviewCount(row?.orphanCount),
      }));
    const orphanCheck = (Array.isArray(selfCheck?.checks) ? selfCheck.checks : [])
      .find((check) => String(check?.id || '') === 'folder.binding.orphan');
    const orphanCount = folderReviewCount(selfCheck?.summary?.orphanMembershipCount || orphanCheck?.details?.orphanMembershipCount);
    const orphanMemberships = orphanRows.length || orphanCount === 0
      ? orphanRows
      : [buildFolderReviewCandidate({
        name: 'Canonical orphan memberships',
        orphanCount,
        knownCount: folderReviewCount(orphanCheck?.details?.knownStudioRowTotal),
      }, 'orphan-membership', {
        surface,
        orphanCount,
        nativePresence: true,
        warnings: ['Aggregate self-check item. It is not a folder deletion candidate.'],
      })];
    const canonicalProtected = rows
      .filter((row) => !!row?.isCanonical)
      .map((row) => rowCandidate(row, 'canonical-protected', { isCanonical: true, nativePresence: true }));
    const groupedIds = new Set([
      ...safeEmptyCandidates,
      ...sameNameConflicts,
      ...boundReviewCandidates,
    ].map((candidate) => String(candidate.folderId || '').trim()).filter(Boolean));
    const unsafeToDelete = rows
      .filter((row) => {
        const id = String(row?.folderId || row?.id || '').trim();
        return !row?.isCanonical && id && !groupedIds.has(id);
      })
      .map((row) => rowCandidate(row, 'unsafe-to-delete', {
        nativePresence: false,
        warnings: ['Review row does not meet empty-test cleanup requirements.'],
      }));

    const groups = {
      safeEmptyCandidates,
      sameNameConflicts,
      boundReviewCandidates,
      orphanMemberships,
      canonicalProtected,
      unsafeToDelete,
    };
    return {
      readOnly: true,
      noMutation: true,
      generatedAt: new Date().toISOString(),
      surface,
      selfCheckSummary: selfCheck?.summary || null,
      selfCheckSeverity: selfCheck?.severity || '',
      counts: {
        safeEmpty: safeEmptyCandidates.length,
        conflicts: sameNameConflicts.length,
        boundReview: boundReviewCandidates.length,
        orphanMemberships: orphanMemberships.length,
        canonicalProtected: canonicalProtected.length,
        unsafeToDelete: unsafeToDelete.length,
      },
      groups,
      safetyRules: [
        'P8i-c1 is review-only.',
        'No folder cleanup is performed.',
        'No Chrome storage, SQLite, or native folder-state writes are performed.',
        'Canonical f_* folders are protected.',
        'Conflicts and bound folders are review-only.',
        'Desktop/F5D test folders are review-only in P8i-c1.',
      ],
    };
  }

  async function getFolderReviewPlan({ fresh = true } = {}) {
    const parity = H2O.Library?.FolderParity;
    if (!parity || typeof parity.selfCheck !== 'function' || typeof parity.getDisplayModel !== 'function') {
      throw new Error('FolderParity review APIs unavailable');
    }
    const selfCheck = await parity.selfCheck({ fresh });
    const displayModel = await parity.getDisplayModel({ fresh });
    return {
      selfCheck,
      displayModel,
      plan: buildFolderReviewPlan(selfCheck, displayModel),
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  const Maintenance = {
    surface: 'studio',
    inspectStore, inspectRegistry, inspectIndex, inspectWorkspace, inspectCore,
    exportSnapshot, importSnapshot,
    rebuildIndex, cleanupStaleRegistryEntries,
    buildFolderReviewPlan, getFolderReviewPlan,

    async diagnose() {
      return {
        surface: 'studio',
        store:     await inspectStore(),
        registry:  await inspectRegistry(),
        index:     inspectIndex(),
        workspace: inspectWorkspace(),
        core:      inspectCore(),
        steps: diag.steps.slice(-15),
        errors: diag.errors.slice(-10),
      };
    },
  };

  H2O.Library.Maintenance = Maintenance;

  // Register a Command Bar group via the surface command-bar service so a future
  // Studio Command Bar can pick this up without code changes here.
  function registerCommandGroup() {
    const cb = getCmdBar();
    if (!cb || typeof cb.registerGroup !== 'function') return false;
    cb.registerGroup('library-maintenance', { label: 'Library Maintenance', icon: '🛠️' });
    cb.registerCommand('library-maintenance', { id: 'inspect-store',    label: 'Inspect Library Store',    fn: inspectStore });
    cb.registerCommand('library-maintenance', { id: 'inspect-registry', label: 'Inspect Chat Registry',    fn: inspectRegistry });
    cb.registerCommand('library-maintenance', { id: 'rebuild-index',    label: 'Rebuild Library Index',    fn: rebuildIndex });
    cb.registerCommand('library-maintenance', { id: 'export-snapshot',  label: 'Export Library Snapshot',  fn: exportSnapshot });
    cb.registerCommand('library-maintenance', { id: 'diagnose-all',     label: 'Diagnose Library',         fn: Maintenance.diagnose });
    step('cmd-bar-registered', 'library-maintenance');
    return true;
  }

  function registerOnCore() {
    const core = getCore();
    if (!core || typeof core.registerOwner !== 'function') return false;
    try {
      core.registerOwner('library-maintenance', Maintenance, { replace: true });
      core.registerService('library-maintenance', Maintenance, { replace: true });
      registerCommandGroup();
      step('register-on-core', 'library-maintenance');
      return true;
    } catch (e) { err('register-on-core', e); return false; }
  }

  if (!registerOnCore()) {
    W.addEventListener('h2o.ev:prm:cgx:lib:ready:v1', () => registerOnCore(), { once: true });
  }

  step('boot', 'studio-library-maintenance-ready');
})();
