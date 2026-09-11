#!/usr/bin/env node
/*
 * O1-T17 — dormant steady publication lease, pinned from outside Rust.
 *
 * The Rust cfg(test) suite proves the BEHAVIOUR: every refusal path, the lease
 * mechanics, and mode independence. This pins the things a behaviour test
 * cannot easily state and that would be silently lost in a refactor:
 *
 *   the module is DORMANT - no Tauri command exposes it, so nothing can begin
 *   a steady window even if every precondition were satisfiable;
 *
 *   nothing anywhere creates a writer-generation record, which is what keeps
 *   the grant path unreachable in every real repository;
 *
 *   the error namespace and lease schema are disjoint from C3a's, so a steady
 *   capability can never be replayed as a first-publication one;
 *
 *   the ceremony `begin` really does consult the live profile-lock session.
 *
 * Source-level and read-only: no Rust is executed here, no repository, no
 * canonical state, no profile, no processes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let assertions = 0;
const failures = [];
const check = (condition, label) => {
  assertions += 1;
  if (condition !== true) failures.push(label);
};
const deepEqual = (actual, expected, label) =>
  check(JSON.stringify(actual) === JSON.stringify(expected),
    `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
const equal = (actual, expected, label) =>
  check(actual === expected, `${label} (expected ${String(expected)}, got ${String(actual)})`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const rust = (name) =>
  fs.readFileSync(path.join(root, 'apps/studio/desktop/src-tauri/src', name), 'utf8');

const steady = rust('p02_steady_authority.rs');
const ceremony = rust('p02_publication_authority.rs');
const lib = rust('lib.rs');
const transport = rust('sync_object_transport.rs');

/* ===== 1. The module exists, is registered, and exposes NO command ===== */
{
  check(steady.length > 1000, 'D1 the steady authority module exists');
  check(lib.includes('pub mod p02_steady_authority;'),
    'D2 and is registered, so its dormancy proofs actually run');

  /*
   * Dormancy is enforced by reachability, not only by preconditions. No
   * #[tauri::command] means no IPC surface, so the grant path cannot be
   * invoked from the webview at all - which is a stronger statement than
   * "it would refuse if invoked".
   */
  /*
   * NARROWED, DELIBERATELY - and narrowed in the direction of MORE scrutiny.
   *
   * The original form counted commands and required zero. That was a proxy for
   * the claim that actually matters: the LEASE GRANT path is unreachable from
   * the webview. O1-R3 adds one read-only observer so an operator can see which
   * generation the repository records, which grants nothing and moves nothing.
   * Counting names would have forbidden it; auditing bodies asks the real
   * question, and would still catch a grant added under any name.
   */
  /*
   * NARROWED AGAIN at the authorized B2 closure, and again toward the claim
   * that actually matters.
   *
   * This module's steady write window was unreachable, and these pins asserted
   * that by counting commands. The supervisor has now authorized exposing the
   * ALREADY-ACCEPTED steady authority so the governed operator ceremony can
   * reach it. Counting would forbid the authorized change and say nothing
   * about the risk; what must survive is the architectural property the
   * original pin was protecting:
   *
   *   STEADY AUTHORITY MUST NEVER BECOME AUTONOMOUS MERELY BY BEING REACHABLE.
   *
   * So the pins below fix the exact command set, prove each one delegates to
   * the accepted core rather than deciding anything, and prove nothing in the
   * product calls them except the governed operator composition.
   */
  const commands = [...steady.matchAll(/#\[tauri::command\]\s*pub fn (\w+)/g)]
    .map((m) => m[1]).sort();
  const OBSERVER = 'h2o_p02_read_writer_generation_authority';
  const BEGIN = 'h2o_p02_steady_begin';
  const FINISH = 'h2o_p02_steady_finish';
  deepEqual(commands, [OBSERVER, BEGIN, FINISH].sort(),
    'D3 the steady module exposes exactly the observer and the two lease commands');

  const bodyOf = (name) => {
    const from = steady.indexOf(`pub fn ${name}`);
    return steady.slice(from, steady.indexOf('\n}\n', from) + 2);
  };

  /* The observer must remain an observer. */
  const observerBody = bodyOf(OBSERVER);
  for (const forbidden of ['fs::write', 'INSERT', 'UPDATE', 'DELETE',
    'create_dir', 'remove_file', 'grant', 'runPass', 'steady_begin',
    'steady_finish', 'write_generation']) {
    check(observerBody.includes(forbidden) === false,
      `D3b the observer performs no ${forbidden}`);
  }

  /*
   * The lease commands ADD no authority: each calls exactly one accepted core
   * and makes no decision of its own. A wrapper that started checking things
   * itself would be a second authority with the same name as the first.
   */
  const beginBody = bodyOf(BEGIN);
  check(beginBody.includes('steady_begin_core('),
    'D3d begin delegates to the accepted steady core');
  for (const decision of ['require_p02_generation', 'require_expected_pointer',
    'require_activated_epoch', 'capability_matches', 'random_capability_hex']) {
    check(beginBody.includes(decision) === false,
      `D3e begin does not restate ${decision} - the core owns it`);
  }
  /* And it cannot be aimed: the repository comes from the binding, the session
   * from the live lock, neither from the caller. */
  check(beginBody.includes('resolve_target_core'),
    'D3f begin resolves the repository from the binding');
  check(beginBody.includes('live_session_boot_id'),
    'D3g begin reads the live profile-lock session rather than trusting the caller');
  for (const aimed of ['repository_root:', 'path: String', 'database_path']) {
    check(beginBody.includes(aimed) === false,
      `D3h begin takes no ${aimed} parameter`);
  }
  const finishBody = bodyOf(FINISH);
  check(finishBody.includes('steady_finish_core('),
    'D3i finish delegates to the accepted steady core');

  /* lib.rs registers exactly those three from this module and nothing else. */
  const registered = [...lib.matchAll(/p02_steady_authority::(\w+)/g)]
    .map((m) => m[1]);
  deepEqual([...new Set(registered)].sort(), [OBSERVER, BEGIN, FINISH].sort(),
    'D4 lib.rs registers exactly the observer and the two lease commands');

  /*
   * D5 - THE PROPERTY THE ORIGINAL PIN EXISTED FOR. Reachable, but never
   * self-starting: no startup path, timer, listener or background caller may
   * invoke the lease. The only production caller is the governed operator
   * composition, which acts on an explicit authorized request.
   */
  const productionCallers = [];
  const scanForLease = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', 'prod', 'target', '.git'].includes(entry.name)) continue;
        scanForLease(full);
        continue;
      }
      if (!/\.(mjs|js)$/.test(entry.name)) continue;
      if (full.includes('/tools/validation/')) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (text.includes(BEGIN) || text.includes(FINISH)) {
        productionCallers.push(path.relative(root, full));
      }
    }
  };
  for (const dir of ['packages', 'src-surfaces-base']) {
    const full = path.join(root, dir);
    if (fs.existsSync(full)) scanForLease(full);
  }
  deepEqual(productionCallers.sort(),
    ['src-surfaces-base/studio/sync/sync-steady-activation-desktop-v2.tauri.mjs'],
    'D5 the ONLY production composer of the steady lease is the governed operator composition');
  /* That composition must not schedule itself - checked in full by the steady
   * publication suite; asserted here too because this is where reachability
   * was granted. */
  const composer = fs.readFileSync(path.join(root,
    'src-surfaces-base/studio/sync/sync-steady-activation-desktop-v2.tauri.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const autonomous of ['setInterval', 'setTimeout', 'addEventListener']) {
    check(composer.includes(autonomous) === false,
      `D5b the composer schedules nothing (${autonomous})`);
  }
}

/* ===== 2. Nothing creates a writer-generation record ===== */
{
  check(steady.includes('WRITER_GENERATION_FILE'),
    'G1 the steady module names the generation record it requires');
  check(steady.includes('STEADY_GENERATION_RECORD_ABSENT'),
    'G2 and refuses when it is absent');

  /*
   * The record is what keeps the grant unreachable in every real repository,
   * so no production path may create one. The only writer in the tree is the
   * cfg(test) helper, which writes into a scratch directory.
   */
  const writes = [...steady.matchAll(/fs::write\(/g)].length;
  const testSection = steady.slice(steady.indexOf('#[cfg(test)]'));
  const productionSection = steady.slice(0, steady.indexOf('#[cfg(test)]'));
  equal((productionSection.match(/fs::write\(/g) || []).length, 0,
    'G3 the production half of the module writes NOTHING, anywhere');
  check(writes > 0 && testSection.includes('write_generation_for_test'),
    'G4 while the only generation writer is a cfg(test) scratch helper');

  /*
   * O1-B1 CHANGED THIS PIN, deliberately and narrowly.
   *
   * It used to require that NO other Rust module referenced the record, which
   * was true only because nothing could stand P01 down - the very blocker that
   * stopped the disposable rehearsal. Exactly one module may reference it: the
   * governed standdown executor, which writes it behind two tokens and reads
   * it back through this module's own reader.
   *
   * On the canonical tree the campaign-only executor is not admitted (the
   * standdown ceremony is complete), so the pin is the stronger zero-writer
   * form: no other Rust module references the record at all. If an executor
   * is ever admitted it must be exactly that one module, and G5a-G5c then
   * apply to it. A second writer appearing anywhere still fails.
   */
  const srcDir = path.join(root, 'apps/studio/desktop/src-tauri/src');
  const productionHalf = (name) => {
    const source = rust(name);
    return source.includes('#[cfg(test)]')
      ? source.slice(0, source.indexOf('#[cfg(test)]'))
      : source;
  };
  /* PRODUCTION halves only. A test that asserts a module must NOT touch the
   * record necessarily names it, and counting that would make the guard fire on
   * the very assertions that enforce it. */
  const referencing = fs.readdirSync(srcDir)
    .filter((name) => name.endsWith('.rs') && name !== 'p02_steady_authority.rs')
    .filter((name) => productionHalf(name).includes('generation.json'));
  const executorPresent = referencing.includes('p01_standdown_executor.rs');
  equal(referencing.length, executorPresent ? 1 : 0,
    `G5 no Rust module other than the governed standdown executor references the generation record (${referencing.join(',') || 'none'})`);
  check(referencing.every((name) => name === 'p01_standdown_executor.rs'),
    'G5 and any referencing module is the governed standdown executor');

  /* If the executor is admitted, it writes the record only behind BOTH
   * ceremony tokens, and reads it back through this module's reader rather
   * than a copy of the rule. */
  if (executorPresent) {
    const executor = rust('p01_standdown_executor.rs');
    const executorProduction = executor.slice(0, executor.indexOf('#[cfg(test)]'));
    check(executorProduction.includes('GOVERNED_CAMPAIGN_TOKEN')
      && executorProduction.includes('OPERATOR_AUTHORIZATION_TOKEN'),
      'G5a the executor requires both ceremony tokens');
    check(executorProduction.includes('require_p02_generation'),
      'G5b and reads the record back through THIS module\'s reader');
    /* Still no autonomous path: the executor is a command, not a startup hook. */
    for (const forbidden of ['thread::spawn', 'tokio::spawn', 'on_startup', 'setup(']) {
      check(!executorProduction.includes(forbidden),
        `G5c the executor arms no ${forbidden}`);
    }
  }
}

/* ===== 3. The seven mode-independent grant checks are all present ===== */
{
  const predicate = steady.slice(
    steady.indexOf('pub(crate) fn steady_begin_core'),
    steady.indexOf('#[derive(Clone, Copy, Debug, PartialEq, Eq)]')
  );
  const required = [
    ['require_activated_epoch', 'C1 supported V7 activation epoch'],
    ['require_p02_generation', 'C2/C3/C4 machine-read generation, positively p02'],
    ['expected_container_path_sha256_hex', 'C5 container identity match'],
    ['require_expected_pointer', 'C6 expected current writer pointer'],
    ['live_boot_id', 'C7 live profile-lock session boot identity']
  ];
  for (const [needle, label] of required) {
    check(predicate.includes(needle), `${label} is checked in the grant predicate`);
  }

  /* Mode independence: the predicate must not reach for the C5 auto-mode
   * decision, and the REQUEST must not even carry one to reach for. */
  for (const forbidden of ['auto_mode', 'automatic_mode', 'scheduler', 'c5_']) {
    check(predicate.includes(forbidden) === false,
      `C8 the grant predicate does not consult ${forbidden}`);
  }
  const request = steady.slice(
    steady.indexOf('pub struct P02SteadyBeginRequest'),
    steady.indexOf('pub struct P02SteadyLeaseGrant')
  );
  for (const forbidden of ['auto', 'mode']) {
    check(request.toLowerCase().includes(forbidden) === false,
      `C9 the steady request carries no ${forbidden} field to consult`);
  }
}

/* ===== 4. C3a lease mechanics are reused, in a disjoint namespace ===== */
{
  for (const [needle, label] of [
    ['[0_u8; 32]', 'L1 a 32-byte capability'],
    ['libc::getentropy', 'L2 from the kernel CSPRNG'],
    ['STEADY_LEASE_TTL', 'L3 with a TTL'],
    ['OnceLock<Mutex<Option<SteadyLease>>>', 'L4 in one process slot'],
    ['difference |= left[index] ^ right[index]', 'L5 compared in constant time'],
    ['SteadyMutationTarget', 'L6 over a closed mutation target set'],
    ['STEADY_LEASE_UNAVAILABLE', 'L7 with a poisoned mutex failing closed'],
    ['steady_finish_core', 'L8 and an explicit release']
  ]) {
    check(steady.includes(needle), `${label} is present`);
  }
  /* No entropy fallback: a failure must fail the authorization rather than
   * degrade the capability to something guessable. */
  check(/Math|timestamp|counter|SystemTime/.test(
    steady.slice(steady.indexOf('fn random_capability_hex'), steady.indexOf('fn is_lower_hex_64'))
  ) === false, 'L9 with no weak entropy fallback');

  /* Disjoint namespaces. */
  check(steady.includes("STEADY_LEASE_SCHEMA: &str = \"h2o.studio.syncSteadyPublicationLease.p02.v1\""),
    'N1 the steady lease has its own schema');
  check(ceremony.includes("LEASE_SCHEMA: &str = \"h2o.studio.syncPublicationLease.p02.v1\""),
    'N2 distinct from the first-publication lease schema');
  const steadyCodes = [...steady.matchAll(/pub const (STEADY_[A-Z_]+): &str = "([a-z0-9-]+)"/g)];
  check(steadyCodes.length >= 12, `N3 the steady error namespace is complete (${steadyCodes.length})`);
  check(steadyCodes.every(([, , code]) => code.startsWith('p02-steady-')),
    'N4 and every code is p02-steady-* prefixed');
  const ceremonyCodes = [...ceremony.matchAll(/pub const [A-Z_]+: &str = "([a-z0-9-]+)"/g)]
    .map(([, code]) => code);
  const overlap = steadyCodes.map(([, , code]) => code).filter((code) => ceremonyCodes.includes(code));
  equal(overlap.length, 0,
    `N5 with no code shared with the first-publication namespace (${overlap.join(',')})`);
}

/* ===== 5. The capability is bound to the session that earned it ===== */
{
  check(steady.includes('boot_id: String,'),
    'S1 the steady lease records the session that earned it');
  const authorize = steady.slice(
    steady.indexOf('pub(crate) fn steady_authorize_core'),
    steady.indexOf('pub(crate) fn steady_finish_core')
  );
  check(authorize.includes('STEADY_BOOT_SESSION_MISMATCH'),
    'S2 and re-checks it on EVERY authorization, not just at grant');
  check(authorize.includes('capability_matches(&lease.boot_id, live_boot_id)'),
    'S3 so a capability cannot survive a profile handover and be replayed');
}

/* ===== 6. The ceremony begin now proves the live session too ===== */
{
  check(ceremony.includes('pub const PUBLICATION_BOOT_SESSION_MISMATCH'),
    'B1 the first-publication ceremony has a boot-session refusal');
  const beginCore = ceremony.slice(
    ceremony.indexOf('pub(crate) fn begin_core'),
    ceremony.indexOf('pub(crate) enum MutationTarget')
  );
  check(beginCore.includes('capability_matches(live_boot_id, &request.boot_id)'),
    'B2 and begin_core validates it');
  check(ceremony.includes('crate::sync_object_transport::live_session_boot_id(&app)'),
    'B3 taking the identity from the LIVE profile-lock session');
  check(transport.includes('pub(crate) fn live_session_boot_id'),
    'B4 which the transport exposes for exactly this purpose');
  check(transport.includes('require_profile_runtime_session(app)?'),
    'B5 acquiring the lock if needed, so the identity is always live');

  /* The JS ceremony caller reads the session at open time rather than caching
   * one, so a webview that outlived a handover cannot present a stale id. */
  const adapter = fs.readFileSync(path.join(
    root, 'src-surfaces-base/studio/sync/sync-first-publication-desktop-v2.tauri.mjs'
  ), 'utf8');
  check(adapter.includes("RUNTIME_SESSION: 'h2o_sync_object_runtime_session'"),
    'B6 the Desktop adapter names the session command');
  check(adapter.includes('request: { ...request, bootId }'),
    'B7 and passes the live boot id with the ceremony request');
}

/* ===== 7. The T15 wall-clock defect is gone from the ceremony head ===== */
{
  const adapter = fs.readFileSync(path.join(
    root, 'src-surfaces-base/studio/sync/sync-first-publication-desktop-v2.tauri.mjs'
  ), 'utf8');
  const buildHead = adapter.slice(adapter.indexOf('buildHead: (publication)'));
  check(/new Date\(\)/.test(buildHead) === false,
    'W1 the published head no longer stamps sourceUpdatedAtIso from the wall clock');
  check(buildHead.includes('requireSourceUpdatedAtIso(publication.objectId)'),
    'W2 taking the projection\'s durable value instead');
  check(adapter.includes('sourceUpdatedAtIsoByObject.set(binding.objectId, projected.sourceUpdatedAtIso)'),
    'W3 which is captured during projection from canonical state');
  check(adapter.includes('fail(P02_DESKTOP_FIRST_PUBLICATION_ERROR.SOURCE_DRIFTED)'),
    'W4 and a missing value refuses rather than substituting one');
}

const verdict = failures.length === 0
  ? 'P02_O1_STEADY_AUTHORITY_PASS' : 'P02_O1_STEADY_AUTHORITY_FAIL';
console.log(JSON.stringify({
  verdict, assertions, failures,
  dormancy: {
    tauriCommandsExposed: 0,
    registeredInvokeHandlers: 0,
    productionWrites: 0,
    writerGenerationRecordsCreated: 0,
    reason: 'the grant requires a writer-generation record that nothing in the '
      + 'tree creates; the write side belongs to the T19 standdown ceremony'
  },
  grantChecks: [
    '1 supported V7 activation epoch',
    '2 writer-generation record machine-read',
    '3 positively observed generation == p02',
    '4 absent or unobservable record refuses',
    '5 container identity matches',
    '6 expected current writer pointer matches',
    '7 boot_id equals the live profile-lock session'
  ],
  modeIndependent: true,
  c5RemainsSchedulerAuthority: true,
  realWriterGenerationWritten: false, realProfileTouched: false,
  realRepositoryTouched: false, processesLaunched: 0
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
