#!/usr/bin/env node
// Validator for the M05 Phase 4 consumer convergence surface.
//
// Phase 2/3 proved the ENGINE obeys the frozen rules (see
// validate-saved-chat-coverage-v1.mjs). This validator proves the CONSUMERS do
// not quietly undo them on the way to the screen — which is the only place the
// guarantees actually reach an operator. A coverage engine that correctly
// refuses to call a package current is worth nothing if the adapter above it
// renders "Current" anyway.
//
// Scope: the shared presentation adapter and the Inspector's identity mapping.
// Both are loaded into a Node VM; no DB, no filesystem, no Tauri.
//
// Contracts: docs/systems/archive/saved-chat-generations.md §D §E §F §G

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const ADAPTER_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-presentation.studio.js';
const INSPECTOR_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-inspector.studio.js';

const PASS = [];
const FAIL = [];
function check(label, fn) {
  try { fn(); PASS.push(label); console.log(`  ✓ ${label}`); }
  catch (e) { const m = e?.message ?? String(e); FAIL.push({ label, m }); console.log(`  ✗ ${label}`); console.log(`      ${m}`); }
}
function readRepo(rel) { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); }

/* Forbidden-token scans must read CODE, not prose. The adapter's header
 * documents the very fields it refuses to consult, so a naive substring scan
 * over the raw file reports a violation for the comment that promises the
 * opposite. Strip comments first. */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const HASH_CUR = 'sha256-' + 'c'.repeat(64);
const HASH_OLD = 'sha256-' + '0'.repeat(64);
const HASH_MID = 'sha256-' + 'd'.repeat(64);

function loadAdapter() {
  const ctx = vm.createContext({ console });
  ctx.window = ctx;
  vm.runInContext(readRepo(ADAPTER_REL), ctx, { filename: ADAPTER_REL });
  return ctx.H2O.Studio.ingestion;
}

const api = loadAdapter();
const { describeSavedChatArchiveStateV1, describeMaterializationOutcomeV1, savedChatArchivePresentationV1 } = api;

/* A coverage result in the shape the Phase 2.2 engine emits. */
function entry(over) {
  return Object.assign({
    packagePath: 'archive/packages/chat_x.g' + 'c'.repeat(64) + '.h2ochat',
    packageDirName: 'chat_x.g' + 'c'.repeat(64) + '.h2ochat',
    classification: 'generation',
    chatId: 'chat_x',
    snapshotId: 'snap_1',
    schemaVersion: 2,
    payloadVersion: 2,
    contentHash: HASH_CUR,
    savedAt: '2026-08-20T00:00:00.000Z',
    status: 'valid',
    blockers: [],
  }, over || {});
}

function coverage(over) {
  return Object.assign({
    chatId: 'chat_x',
    complete: true,
    preserved: true,
    covered: true,
    projection: { status: 'ok', contentHash: HASH_CUR },
    generations: [], legacy: [], unusable: [], fresh: [], stale: [],
    selected: null, bestHistorical: null, bestHistoricalTies: [],
  }, over || {});
}

console.log('── Saved-Chat archive consumer convergence validator (M05 P4) ──────');

/* ── Proof 1 — multiple generations remain individually visible ──────────── */
check('1. sibling generations are each presented, never collapsed into one row', () => {
  const a = entry({ contentHash: HASH_CUR, packageDirName: 'a.h2ochat' });
  const b = entry({ contentHash: HASH_OLD, packageDirName: 'b.h2ochat', status: 'valid' });
  const c = entry({ contentHash: HASH_MID, packageDirName: 'c.h2ochat', status: 'valid' });
  const out = describeSavedChatArchiveStateV1(coverage({ generations: [a, b, c] }));
  assert.equal(out.generations.length, 3, 'a sibling was dropped');
  const names = out.generations.map((g) => g.packageDirName);
  assert.equal(new Set(names).size, 3, 'siblings collapsed to a shared identity');
  assert.equal(new Set(out.generations.map((g) => g.contentHash)).size, 3);
});

/* ── Proof 2 — a valid FRESH generation is shown as current coverage ─────── */
check('2. the fresh generation is labelled current and drives covered state', () => {
  const fresh = entry({ contentHash: HASH_CUR });
  const out = describeSavedChatArchiveStateV1(
    coverage({ generations: [fresh], fresh: [fresh], selected: fresh, covered: true }));
  assert.equal(out.coverageState, 'covered');
  assert.equal(out.selected.isCurrent, true);
  assert.equal(out.selected.freshnessLabel, 'Current');
  assert.equal(out.generations[0].isHistoricalOnly, false);
});

/* ── Proof 3 — a preserved stale generation is never shown as fresh ──────── */
check('3. a preserved stale generation is historical, not current', () => {
  const stale = entry({ contentHash: HASH_OLD, staleKind: 'content-stale' });
  const out = describeSavedChatArchiveStateV1(
    coverage({ generations: [stale], stale: [stale], covered: false, selected: null }));
  const p = out.generations[0];
  assert.equal(p.isCurrent, false, 'a stale generation was presented as current');
  assert.equal(p.freshness, 'content-stale');
  assert.equal(p.isHistoricalOnly, true);
  assert.equal(out.coverageState, 'not-covered');
  // Preserved and covered are separate facts; preservation survives staleness.
  assert.equal(out.preservedLabel, 'Preserved');
});

/* ── Proof 3c — the TWO REPRESENTATIONS the engine actually emits ─────────
 *
 * Every other fixture in this file spells both sides of the comparison in the
 * pre-M10 `sha256-<hex>` form, so none of them can see a representation skew.
 * The shipping engine no longer does that: M10 P3.5a moved package identity to
 * the trusted Rust authority, whose wire carries a BARE lowercase digest, while
 * the current-projection probe still carries the writer's prefixed form. So the
 * real coverage result arrives with a bare entry hash and a prefixed projection
 * hash, and an adapter that compares them literally reports the exact inversion
 * this validator exists to prevent: a genuinely current package rendered as
 * "Historical (content changed)".
 *
 * This fixture is written in the representations the engine emits TODAY. */
const BARE_CUR = 'c'.repeat(64);
check('3c. a bare trusted digest still matches the prefixed projection hash', () => {
  const live = entry({ contentHash: BARE_CUR });
  const out = describeSavedChatArchiveStateV1(coverage({
    projection: { status: 'ok', contentHash: 'sha256-' + BARE_CUR },
    generations: [live], fresh: [live], selected: live, covered: true,
  }));
  assert.equal(out.selected.freshness, 'fresh',
    'a current package read as ' + out.selected.freshness + ' because of hash REPRESENTATION alone');
  assert.equal(out.selected.freshnessLabel, 'Current');
  assert.equal(out.selected.isCurrent, true);
  assert.equal(out.selected.isHistoricalOnly, false);
});

/* NEGATIVE CONTROL for 3c: normalization must not make everything match. A
 * blanket "strip and compare loosely" repair would pass 3c and destroy the
 * freshness rule; a genuinely different digest must still be stale in BOTH
 * representations. */
check('3c-neg. NEGATIVE CONTROL — normalization did not make every hash match', () => {
  for (const wrong of ['0'.repeat(64), 'sha256-' + '0'.repeat(64)]) {
    const p = savedChatArchivePresentationV1.entryPresentation(
      entry({ contentHash: wrong, staleKind: 'content-stale' }),
      coverage({ projection: { status: 'ok', contentHash: 'sha256-' + BARE_CUR } }));
    assert.equal(p.isCurrent, false, `digest ${wrong} was presented as current`);
    assert.equal(p.freshness, 'content-stale');
  }
});

/* NEGATIVE CONTROL for proof 3: if the adapter fell back to "assume fresh"
 * when a hash did not match, this fixture would report current. */
check('3b. NEGATIVE CONTROL — a non-matching hash can never yield isCurrent', () => {
  for (const h of [HASH_OLD, HASH_MID, '', 'sha256-' + 'f'.repeat(64)]) {
    const p = savedChatArchivePresentationV1.entryPresentation(
      entry({ contentHash: h }), coverage());
    if (h === HASH_CUR) continue;
    assert.equal(p.isCurrent, false, `hash ${h || '(empty)'} was presented as current`);
  }
});

/* ── Proof 4 — a corrupt sibling is surfaced but erases nothing ──────────── */
check('4. a corrupt sibling is surfaced and does not erase a valid sibling', () => {
  const good = entry({ contentHash: HASH_CUR });
  const bad = entry({
    contentHash: '', status: 'invalid', classification: 'mismatch',
    packageDirName: 'corrupt.h2ochat', blockers: ['package-content-hash-mismatch'],
  });
  const out = describeSavedChatArchiveStateV1(
    coverage({ generations: [good], unusable: [bad], fresh: [good], selected: good }));
  assert.equal(out.unusable.length, 1, 'the corrupt sibling was hidden');
  assert.equal(out.unusable[0].kind, 'unusable');
  assert.equal(out.unusable[0].freshness, 'unusable');
  assert.ok(out.unusable[0].blockers.includes('package-content-hash-mismatch'));
  // The valid sibling is untouched by its neighbour's corruption.
  assert.equal(out.coverageState, 'covered');
  assert.equal(out.selected.contentHash, HASH_CUR);
});

/* ── Proof 5 — incomplete discovery cannot produce authoritative absence ─── */
check('5. incomplete discovery cannot be presented as authoritative absence', () => {
  const out = describeSavedChatArchiveStateV1(
    coverage({ complete: false, covered: null, preserved: null, generations: [] }));
  assert.notEqual(out.coverageState, 'not-covered', 'a truncated scan produced an absence verdict');
  assert.equal(out.coverageState, 'coverage-unknown');
  assert.equal(out.complete, false);
  assert.ok(/incomplete/i.test(out.discoveryNote), 'no incompleteness disclosure');
  assert.equal(out.preservedLabel, 'Preservation unknown');
});

check('5b. null coverage passes through as unknown and is never coerced to false', () => {
  assert.equal(describeSavedChatArchiveStateV1(coverage({ covered: null })).coverageState, 'coverage-unknown');
  assert.equal(describeSavedChatArchiveStateV1(coverage({ covered: undefined })).coverageState, 'coverage-unknown');
  // Only an explicit false is an absence claim.
  assert.equal(describeSavedChatArchiveStateV1(coverage({ covered: false })).coverageState, 'not-covered');
});

/* ── Proof 6 — BEST-HISTORICAL is explicitly historical, never authority ─── */
check('6. BEST-HISTORICAL is presentation-only and never the selection', () => {
  const best = entry({ contentHash: HASH_OLD, staleKind: 'content-stale' });
  const out = describeSavedChatArchiveStateV1(
    coverage({ covered: false, selected: null, stale: [best], bestHistorical: best }));
  assert.ok(out.bestHistorical, 'bestHistorical was dropped');
  assert.equal(out.bestHistorical.presentationOnly, true, '§G marker missing');
  assert.equal(out.bestHistorical.isCurrent, false);
  assert.equal(out.bestHistorical.isHistoricalOnly, true);
  assert.equal(out.selected, null, 'BEST-HISTORICAL was promoted to the selection');
  assert.equal(out.coverageState, 'not-covered');
});

check('6b. BEST-HISTORICAL ties are all marked presentation-only', () => {
  const t1 = entry({ contentHash: HASH_OLD, staleKind: 'content-stale', packageDirName: 't1' });
  const t2 = entry({ contentHash: HASH_MID, staleKind: 'content-stale', packageDirName: 't2' });
  const out = describeSavedChatArchiveStateV1(
    coverage({ covered: false, selected: null, bestHistorical: t1, bestHistoricalTies: [t1, t2] }));
  assert.equal(out.bestHistoricalTies.length, 2, 'ties were silently broken');
  for (const t of out.bestHistoricalTies) {
    assert.equal(t.presentationOnly, true);
    assert.equal(t.isCurrent, false);
  }
});

/* ── Proof 14 — timestamps cannot drive freshness or destructive selection ─ */
check('14. timestamps cannot manufacture freshness at the presentation layer', () => {
  const ancientHashMatch = entry({ contentHash: HASH_CUR, savedAt: '1999-01-01T00:00:00.000Z' });
  const newestHashMismatch = entry({ contentHash: HASH_OLD, savedAt: '2099-01-01T00:00:00.000Z', staleKind: 'content-stale' });
  const out = describeSavedChatArchiveStateV1(
    coverage({ generations: [newestHashMismatch, ancientHashMatch] }));
  const byHash = Object.fromEntries(out.generations.map((g) => [g.contentHash, g]));
  assert.equal(byHash[HASH_CUR].isCurrent, true, 'hash equality lost to an older timestamp');
  assert.equal(byHash[HASH_OLD].isCurrent, false, 'a newer timestamp manufactured freshness');
});

check('14b. the adapter reads no timestamp field for freshness', () => {
  const src = codeOnly(readRepo(ADAPTER_REL));
  for (const forbidden of ['generatedAt', 'mtime', 'updated_at', 'Date.now', 'writtenAt']) {
    assert.ok(!src.includes(forbidden), `adapter references ${forbidden}`);
  }
  assert.equal(savedChatArchivePresentationV1.diagnose().usesTimestamps, false);
});

/* ── Proof 3/5 corollary — indeterminate projection is unknown, not stale ── */
check('9a. an indeterminate projection yields unknown, never stale', () => {
  for (const status of ['indeterminate', 'db-unavailable', 'undefined-no-snapshot']) {
    const p = savedChatArchivePresentationV1.entryPresentation(
      entry({ contentHash: HASH_OLD }),
      coverage({ projection: { status, contentHash: '' } }));
    assert.equal(p.freshness, 'freshness-unknown', `${status} produced ${p.freshness}`);
    assert.equal(p.isHistoricalOnly, false, `${status} asserted a historical verdict`);
    assert.equal(p.isCurrent, false, `${status} asserted currentness`);
  }
});

/* NEGATIVE CONTROL: without the projection gate, a mismatching hash under an
 * unavailable projection would read as content-stale. */
check('9b. NEGATIVE CONTROL — the projection gate is load-bearing', () => {
  const stale = savedChatArchivePresentationV1.freshnessLabel(
    entry({ contentHash: HASH_OLD, staleKind: 'content-stale' }), coverage());
  assert.equal(stale, 'content-stale', 'baseline: an ok projection must still yield stale');
  const gated = savedChatArchivePresentationV1.freshnessLabel(
    entry({ contentHash: HASH_OLD, staleKind: 'content-stale' }),
    coverage({ projection: { status: 'db-unavailable', contentHash: '' } }));
  assert.notEqual(gated, stale, 'projection status did not change the verdict — gate is dead code');
});

/* ── Proof 8 — Created / Deduped / Already-fresh are distinguished ───────── */
check('8. created / deduped / already-fresh are distinct, and only created wrote', () => {
  const mk = (outcome) => describeMaterializationOutcomeV1({ status: 'written', package: { outcome, packagePath: 'p', contentHash: HASH_CUR } });
  const created = mk('created');
  const deduped = mk('deduped');
  const alreadyFresh = mk('already-fresh');
  const labels = [created.label, deduped.label, alreadyFresh.label];
  assert.equal(new Set(labels).size, 3, 'outcomes collapsed to a shared label');
  assert.equal(created.wrotePackage, true);
  assert.equal(deduped.wrotePackage, false, 'dedupe claimed to have written a package');
  assert.equal(alreadyFresh.wrotePackage, false, 'already-fresh claimed to have written a package');
});

check('8b. deferred and failed are not presented as successful publication', () => {
  const deferred = describeMaterializationOutcomeV1({ status: 'deferred', deferred: { reason: 'discovery-incomplete' } });
  assert.equal(deferred.outcome, 'deferred');
  assert.equal(deferred.wrotePackage, false);
  assert.ok(/deferred/i.test(deferred.label));
  const failed = describeMaterializationOutcomeV1({ status: 'failed', error: 'boom' });
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.wrotePackage, false);
});

/* ── Proof 9 — recorded metadata cannot override current verification ────── */
check('9. recorded result metadata is marked history, not present-tense truth', () => {
  const r = describeMaterializationOutcomeV1({
    status: 'written',
    package: { outcome: 'created', packagePath: 'archive/packages/x.h2ochat', contentHash: HASH_CUR },
  });
  assert.equal(r.recordedOnly, true, 'recorded result was not marked as history');
  // The recorded values are exposed under explicitly recorded* names, so a
  // consumer cannot mistake them for a live verification result.
  assert.equal(r.recordedPackagePath, 'archive/packages/x.h2ochat');
  assert.equal(r.recordedContentHash, HASH_CUR);
  assert.ok(!('contentHash' in r), 'recorded hash exposed under a live-sounding name');
  assert.ok(!('packagePath' in r), 'recorded path exposed under a live-sounding name');
});

/* ── Proof 7 — the Inspector uses the recomputed verified contentHash ────── */
check('7. Inspector identity uses the recomputed hash, not the manifest claim', () => {
  const src = readRepo(INSPECTOR_REL);
  // The identity's contentHash must be sourced from the governed validator's
  // recomputation; the manifest's own claim must be a separate, labelled field.
  assert.ok(/contentHash:\s*cleanString\(hashChecks\.expectedContentHash\)/.test(src),
    'identity.contentHash is not the recomputed hashChecks.expectedContentHash');
  assert.ok(/manifestClaimedContentHash:\s*cleanString\(m\.contentHash\)/.test(src),
    'the manifest claim is not surfaced separately');
  assert.ok(/contentHashVerified:\s*hashChecks\.contentHashOk\s*===\s*true/.test(src),
    'verification state is not surfaced');
  // And it must not fall back to the claim when recomputation is empty.
  assert.ok(!/expectedContentHash\)\s*\|\|\s*cleanString\(m\.contentHash\)/.test(src),
    'identity.contentHash falls back to the manifest claim');
});

check('7b. Inspector renders divergence between recomputed and claimed hash', () => {
  const src = readRepo(INSPECTOR_REL);
  assert.ok(/manifestClaimedContentHash/.test(src) && /does not match verified/i.test(src),
    'no divergence disclosure when the claim differs from the recomputed hash');
  assert.ok(/generatedAt \(recorded\)/.test(src),
    'generatedAt is not labelled as recorded metadata');
});

/* ── Structural: the adapter holds no policy of its own ──────────────────── */
check('adapter is pure: no hashing, no name parsing, no IO, no state', () => {
  const src = codeOnly(readRepo(ADAPTER_REL));
  for (const forbidden of ['sha256(', 'createHash', 'invoke(', 'fetch(', 'localStorage', 'readFile', '.g<', 'sort(']) {
    assert.ok(!src.includes(forbidden), `adapter performs forbidden operation: ${forbidden}`);
  }
  const d = savedChatArchivePresentationV1.diagnose();
  assert.equal(d.recomputesContentHash, false);
  assert.equal(d.parsesGenerationNames, false);
  assert.equal(d.persistentIndex, false);
  assert.equal(d.freshnessRule, 'coverage authority only');
});

check('adapter is registered in studio.html and both pack lists', () => {
  const leaf = 'ingestion/saved-chat-archive-presentation.studio.js';
  assert.ok(readRepo('src-surfaces-base/studio/studio.html').includes('./' + leaf), 'missing from studio.html');
  const pack = readRepo('tools/product/studio/pack-studio.mjs');
  const occurrences = pack.split('"' + leaf + '"').length - 1;
  assert.equal(occurrences, 2, `expected 2 pack-list entries, found ${occurrences}`);
});

console.log('');
if (FAIL.length) {
  console.log(`[archive-presentation] ${FAIL.length} of ${PASS.length + FAIL.length} checks FAILED`);
  for (const f of FAIL) console.log(`  ✗ ${f.label}: ${f.m}`);
  process.exit(1);
}
console.log(`[archive-presentation] all ${PASS.length} checks passed`);
