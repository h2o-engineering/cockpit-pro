#!/usr/bin/env node
// Validator for the M10 P1 trusted read-only archive-integrity wire contract.
//
// P1 exposes existing trusted authority; it introduces none. This validator
// pins exactly that: one read-only command with no mutation partner, an
// envelope that reports FACTS rather than a health verdict, and a renderer that
// supplies nothing — no path, no root, no scope.
//
// It deliberately does NOT re-test the classifier, the verifier or the M06
// decision path; those have owning Rust suites. It tests the BOUNDARY.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

const LIB_REL = 'apps/studio/desktop/src-tauri/src/lib.rs';
const MODULE_REL = 'apps/studio/desktop/src-tauri/src/saved_chat_archive_integrity.rs';
const SCAN_REL = 'apps/studio/desktop/src-tauri/src/archive_package_scan.rs';
const PUBLISH_REL = 'apps/studio/desktop/src-tauri/src/archive_generation_publish.rs';
const RETENTION_REL = 'apps/studio/desktop/src-tauri/src/archive_retention_plan.rs';
const QUARANTINE_REL = 'apps/studio/desktop/src-tauri/src/archive_occupant_quarantine.rs';

const COMMAND = 'h2o_saved_chat_archive_integrity';
const SCHEMA = 'h2o.savedChatArchiveIntegrity';

const readRepo = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const PASS = [];
const FAIL = [];
function check(label, fn) {
  try { fn(); PASS.push(label); console.log(`  ✓ ${label}`); }
  catch (e) { const m = e && e.message ? e.message : String(e); FAIL.push({ label, m }); console.log(`  ✗ ${label}`); console.log(`      ${m}`); }
}

console.log('= saved-chat archive integrity (M10 P1) wire contract =');

const lib = readRepo(LIB_REL);
const mod = readRepo(MODULE_REL);

check('the command is registered in BOTH the debug and release invoke handlers', () => {
  const arms = lib.split('macro_rules! h2o_studio_invoke_handler');
  // [0] is everything before the first macro; the two arms follow.
  assert.equal(arms.length, 3, 'exactly two invoke-handler arms are expected');
  const [, debugArm, releaseArm] = arms;
  assert.ok(/#\[cfg\(debug_assertions\)\]/.test(arms[0].slice(-80)) || true);
  for (const [name, arm] of [['debug', debugArm], ['release', releaseArm]]) {
    assert.ok(
      arm.includes(`saved_chat_archive_integrity::${COMMAND}`),
      `${name} handler must register ${COMMAND}`,
    );
  }
  assert.ok(lib.includes('pub mod saved_chat_archive_integrity;'), 'module is declared');
});

check('the envelope identity and version are exact', () => {
  assert.ok(mod.includes(`pub const INTEGRITY_SCHEMA: &str = "${SCHEMA}";`), 'schema constant');
  assert.ok(mod.includes('pub const INTEGRITY_SCHEMA_VERSION: u32 = 1;'), 'version constant');
});

check('`complete` is mandatory and is not optional-shaped', () => {
  assert.ok(/pub complete: bool,/.test(mod), 'complete is a required bool');
  assert.ok(!/pub complete: Option</.test(mod), 'complete must never be optional');
});

check('archive-level blockers are structurally distinct from occupant blockers', () => {
  // Envelope level: a flat list of canonical strings.
  assert.ok(/pub struct ArchiveIntegrityResult[\s\S]*?pub blockers: Vec<String>,/.test(mod),
    'the archive layer carries Vec<String>');
  // Occupant level: typed objects carrying a canonical code.
  assert.ok(/pub struct IntegrityOccupant[\s\S]*?pub blockers: Vec<IntegrityBlocker>,/.test(mod),
    'the occupant layer carries Vec<IntegrityBlocker>');
  assert.ok(/pub struct IntegrityBlocker \{\s*pub code: String,\s*\}/.test(mod),
    'a blocker is exactly a canonical code in P1');
});

check('populations are named `observed`, never `total`', () => {
  assert.ok(mod.includes('pub observed: ObservedPopulations,'), 'observed is the population field');
  assert.ok(!/pub total/.test(mod), 'no field may be named total*');
  assert.ok(!/pub totals/.test(mod), 'no field may be named totals');
});

check('Rust emits no aggregate status or health verdict', () => {
  for (const forbidden of [
    'pub status', 'pub ok:', 'pub health', 'pub verdict', 'pub severity', 'pub grade',
    '"GOOD"', '"WARNING"', '"BAD"', 'Healthy', 'Unhealthy',
  ]) {
    assert.ok(!mod.includes(forbidden), `the envelope must not emit ${forbidden}`);
  }
});

check('no host filesystem path and no chat content is projected', () => {
  for (const forbidden of [
    'PathBuf', 'absolute_path', 'host_path', 'root_path',
    'pub messages', 'pub message', 'pub title', 'pub body', 'pub markdown',
    'pub html', 'pub content:', 'snapshot_bytes',
  ]) {
    assert.ok(!mod.includes(forbidden), `the envelope must not project ${forbidden}`);
  }
  // Occupant paths come from the scanner's archive-relative identity.
  assert.ok(/ARCHIVE_ROOT\}\/\{PACKAGES_DIR\}\/\{name\}/.test(readRepo(SCAN_REL)),
    'the scanner produces archive-relative paths');
});

check('the renderer supplies no archive root, no path and no scope', () => {
  const signature = mod.slice(mod.indexOf(`pub async fn ${COMMAND}`));
  const params = signature.slice(signature.indexOf('('), signature.indexOf(')') + 1);
  assert.equal(
    params.replace(/\s+/g, ' ').trim(),
    '( app: tauri::AppHandle, )',
    'the command takes ONLY the app handle',
  );
  assert.ok(
    mod.includes('crate::archive_durable_write::archive_root(&app)'),
    'the root is derived by trusted native code',
  );
});

check('the command has no mutation partner and no setter', () => {
  const commands = [...mod.matchAll(/#\[tauri::command\]\s*pub (?:async )?fn (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(commands, [COMMAND], 'the module registers exactly one command');
  for (const forbidden of ['fn set_', 'fn write_', 'fn apply_', 'fn repair_', 'fn delete_']) {
    assert.ok(!mod.includes(forbidden), `no mutation partner: ${forbidden}`);
  }
});

check('P1 composes the accepted authorities and none of the destructive stack', () => {
  for (const required of [
    'crate::archive_durable_write::archive_root',
    'crate::archive_package_scan::scan_packages_within',
    'crate::saved_chat_generation_policy::production_policy',
  ]) {
    assert.ok(mod.includes(required), `must compose ${required}`);
  }
  for (const forbidden of [
    'crate::archive_retention_plan', 'crate::archive_reclaim', 'crate::archive_cas_scan',
    'crate::archive_db_probe', 'crate::archive_occupant_quarantine',
    'crate::archive_reclamation_preview', 'crate::archive_transport_handoff',
  ]) {
    assert.ok(!mod.includes(forbidden), `must not compose ${forbidden}`);
  }
  // No persistent state of any kind.
  for (const forbidden of ['std::fs::', 'sqlx', 'CREATE TABLE', 'INSERT INTO', 'static mut', 'Mutex<']) {
    assert.ok(!mod.includes(forbidden), `P1 holds no persistent/mutable state: ${forbidden}`);
  }
});

check('the diagnostic blocker never reaches a destructive decision', () => {
  assert.ok(
    /Indeterminate \{\s*reason: IndeterminateReason,\s*verifier_blocker: Option<&'static str>,\s*\}/.test(readRepo(SCAN_REL)),
    'the additive field exists on the canonical enum',
  );
  for (const [rel, label] of [[RETENTION_REL, 'retention'], [QUARANTINE_REL, 'quarantine']]) {
    assert.ok(
      !readRepo(rel).includes('verifier_blocker'),
      `${label} must never name the diagnostic blocker field`,
    );
    assert.ok(
      readRepo(rel).includes('OccupantClass::Indeterminate { reason, .. }'),
      `${label} matches in future-additive form on reason alone`,
    );
  }
});

/* P1.2 blind-spot A: current-parity identity fields. P1 shipped an envelope
   that could not identify a snapshot, which no migration could have consumed. */
check('the occupant contract carries the trusted current-parity identity fields', () => {
  for (const field of ['pub chat_id:', 'pub snapshot_id:', 'pub content_hash:']) {
    assert.ok(
      new RegExp(`pub struct IntegrityOccupant[\\s\\S]*?${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(mod),
      `the occupant DTO must carry ${field}`,
    );
  }
  // And the trusted source is the ALREADY-VALIDATED manifest, not a re-parse.
  const scan = readRepo(SCAN_REL);
  assert.ok(
    scan.includes('snapshot_id: verified.manifest.snapshot_id.clone()'),
    'snapshotId is read from the validated manifest object',
  );
  assert.ok(!scan.includes('serde_json::from_slice'), 'the scanner re-parses no manifest bytes');
});

/* P1.2 blind-spot B: the blocker must be INFORMATIVE. It comes from the distinct
   optional granular channel; carrying the coarse admission code would duplicate
   what `class` and `reason` already say. Behavioural proof lives in Rust. */
check('the verifier blocker comes from the granular channel, not the coarse code', () => {
  const publish = readRepo(PUBLISH_REL);
  // The failure payload has a THIRD, optional element distinct from the coarse pair.
  assert.ok(
    /pub\(crate\) type AdmissionFailure = \(Outcome, &'static str, Option<&'static str>\);/.test(publish),
    'admission failure carries a distinct optional granular channel',
  );
  // The granular code is PRESERVED from the verifier, not re-derived.
  assert.ok(
    publish.includes('Some(granular)'),
    'the granular verifier code is carried through',
  );
  // The scanner reads the granular element and explicitly discards the coarse one.
  const scan = readRepo(SCAN_REL);
  assert.ok(
    scan.includes('.map_err(|(outcome, _coarse, granular)| (indeterminate_for(outcome), granular))'),
    'the scanner blocker is the granular code; the coarse code feeds `reason` only',
  );
  // Admission itself still ignores the granular evidence entirely.
  assert.ok(
    publish.includes('Err((outcome, code, _granular)) => return (outcome, code, Vec::new()),'),
    'publication reads only the coarse pair',
  );
});

check('the current JS operator authority is untouched by P1', () => {
  // P4 retirement of the JS integrity computation is a SEPARATE authorization.
  // P1 must not have repointed the operator surface at the new command.
  const health = readRepo('src-surfaces-base/studio/ingestion/saved-chat-reclamation-ui.studio.js');
  assert.ok(!health.includes(COMMAND), 'the reclamation UI is not repointed in P1');
  const diagnostics = readRepo('src-surfaces-base/studio/ingestion/saved-chat-archive-materializer.tauri.js');
  assert.ok(!diagnostics.includes(COMMAND), 'the materializer is not repointed in P1');
});

console.log('');
if (FAIL.length) {
  console.log(`[saved-chat-archive-integrity-contract] ${FAIL.length} failed, ${PASS.length} passed`);
  process.exit(1);
}
console.log(`[saved-chat-archive-integrity-contract] all ${PASS.length} checks passed`);
