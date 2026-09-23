#!/usr/bin/env node
// B2B v1 — Operating-Space Archive physical delivery contract validator.
//
// Mission establish-operating-space-archive-physical-delivery-v1, T02, under
// HDA-DRE-S1-20260923-23 and the accepted T01 contract/reuse map.
//
// WHAT THIS PROVES. The bounded B2B adapter publishes ONE governed Archive
// inventory evidence object at a time into the incumbent Saved-Chats archive
// CAS, resolves it by verified content identity, records a create-only
// protection mapping and keeps one recovery-only secondary copy — while
// holding NO delete/GC/reclamation authority, NO repair/replace authority, NO
// generic CAS or Binary-Assets authority, NO caller-selected physical
// destination and NO source-acquisition/credential authority.
//
// TWO CHECK FAMILIES.
//
//   * CONTRACT FENCES run ALWAYS. They are pure functions of the three
//     authorized sources, so they keep their meaning after the candidate is
//     eventually landed. Each one is also executed against a deliberately
//     BROKEN copy of those sources (§ negative controls) so a fence that has
//     stopped detecting anything fails this validator rather than passing
//     vacuously.
//
//   * CANDIDATE TOPOLOGY checks (exact 3-path diff, parent = pinned base,
//     lib.rs pre-image, mechanical-only lease scope, Product-main position)
//     are only MEANINGFUL while the tree is positioned as the T02 candidate.
//     They run whenever that position is detectable and otherwise report SKIP
//     with the exact reason. A stage-negative guard that asserts "the next
//     stage has not happened" goes red the moment it does, so these are
//     deliberately scoped rather than unconditional — the content fences above
//     are what remain permanently binding.
//
// PRODUCT-MAIN POSITION HAS TWO WINDOWS. The original T02 shape asserted a
// single one — Product main EXACTLY at the frozen base — which was true while
// the candidate was being constructed and becomes permanently false the moment
// any unrelated lane lands. That is a lifecycle defect in the guard, not in the
// candidate, so the guard now admits exactly two positions and nothing else:
//
//   Window A  origin/main == BASE_PRODUCT_MAIN. Unchanged, still valid, still
//             exactly as strict as it was during T02 construction.
//
//   Window B  origin/main has advanced, but only forward and only elsewhere:
//               B1  it is a forward-only descendant of BASE_PRODUCT_MAIN, and
//               B2  git diff BASE_PRODUCT_MAIN..origin/main across the three
//                   authorized B2B paths is empty.
//
// Anything else is RED. Two discriminating negative controls (§ negative
// controls) prove the predicate rejects a later Product main that touched one
// of the three authorized paths, and a Product main that is not a forward-only
// descendant of the frozen base, while still accepting the clean cases.
//
// SOURCE INSPECTION IS CODE-ONLY. Prose that DESCRIBES a prohibited authority
// must never be able to satisfy — or to fail — a check about whether the code
// USES it, so every source predicate runs over a comment-stripped view and the
// stripper itself carries a negative control.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

/* ── Frozen authority pins (HDA-DRE-S1-20260923-23) ──────────────────────── */

const BASE_PRODUCT_MAIN = '8b21030ae25832a9d2192817556e7f6cc2bc321b';
const BASE_PRODUCT_TREE = 'b44f132a1efa041b38bf8b9e65641ef540b55f35';
const LIB_RS_PREIMAGE_BLOB = '682b8ebc2f47cae9d77d226d69f7bf39005803c1';

const MODULE_REL = 'apps/studio/desktop/src-tauri/src/operating_space_archive_delivery.rs';
const LIB_REL = 'apps/studio/desktop/src-tauri/src/lib.rs';
const VALIDATOR_REL = 'tools/validation/studio/validate-operating-space-archive-physical-delivery-v1.mjs';
const AUTHORIZED_PATHS = [MODULE_REL, LIB_REL, VALIDATOR_REL].slice().sort();

/* The four commands the bounded B2B surface exposes — no more. */
const B2B_COMMANDS = [
  'h2o_operating_space_archive_publish_object',
  'h2o_operating_space_archive_resolve_object',
  'h2o_operating_space_archive_record_protection',
  'h2o_operating_space_archive_verify_delivery',
];

/* ── Product-main position windows ───────────────────────────────────────── */

/* Pure classifier for the Product-main position, expressed over three plain
 * observations so the live check below can drive it from real git while the
 * negative controls drive it from synthetic inputs. It returns the window that
 * was satisfied, or a null window plus the exact reason it is RED.
 *
 * Window A (equality with the frozen base) short-circuits: during original T02
 * candidate construction that equality held and it remains a valid position. */
function classifyProductMain({ originMain, isForwardDescendant, touchedAuthorizedPaths }) {
  if (originMain === BASE_PRODUCT_MAIN) {
    return { window: 'A', reason: null };
  }
  if (!isForwardDescendant) {
    return {
      window: null,
      reason:
        `Product main ${originMain} is not a forward-only descendant of the frozen base ${BASE_PRODUCT_MAIN}`,
    };
  }
  const touched = (touchedAuthorizedPaths || []).slice().sort();
  if (touched.length > 0) {
    return {
      window: null,
      reason:
        `Product main ${originMain} changed authorized B2B path(s) after the frozen base: ${touched.join(', ')}`,
    };
  }
  return { window: 'B', reason: null };
}

/* Incumbent registrations the Host lib.rs lease must leave untouched. */
const P02_T19_REGISTRATION = 'p01_standdown_executor::h2o_p01_execute_writer_generation_standdown';
const P02_RELATIONSHIP_REGISTRATION = 'p02_relationship_apply::h2o_p02_relationship_apply';

/* ── Reporting ───────────────────────────────────────────────────────────── */

const PASS = [];
const FAIL = [];
const SKIP = [];

function check(label, fn) {
  try {
    fn();
    PASS.push(label);
    console.log(`  PASS ${label}`);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    FAIL.push({ label, message });
    console.log(`  FAIL ${label}`);
    console.log(`       ${message}`);
  }
}

function skip(label, reason) {
  SKIP.push({ label, reason });
  console.log(`  SKIP ${label}`);
  console.log(`       ${reason}`);
}

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

function git(args) {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitOrNull(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

/* ── Rust/JS comment stripper ────────────────────────────────────────────── */

/* Removes line and block comments while preserving string and char literals,
 * so a doc comment can neither satisfy nor break a check about the code. */
function codeOnly(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  let state = 'code';
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (c === '"') {
        state = 'string';
        out += c;
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      if (c === '\n') out += c;
      i += 1;
      continue;
    }
    /* string */
    if (c === '\\') {
      out += c + (next === undefined ? '' : next);
      i += 2;
      continue;
    }
    if (c === '"') state = 'code';
    out += c;
    i += 1;
  }
  return out;
}

/* Production half of the module: everything before the test module. A test may
 * legitimately name a prohibited symbol in order to prove its absence. */
function productionOnly(moduleSource) {
  const marker = '#[cfg(all(test, unix))]';
  const index = moduleSource.indexOf(marker);
  return index === -1 ? moduleSource : moduleSource.slice(0, index);
}

function bundleFrom(moduleSource, libSource) {
  return {
    module: moduleSource,
    lib: libSource,
    moduleCode: codeOnly(moduleSource),
    productionCode: codeOnly(productionOnly(moduleSource)),
    libCode: codeOnly(libSource),
  };
}

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

/* ── Contract fences ─────────────────────────────────────────────────────── */

/* Every fence is a named predicate over the source bundle, so the SAME
 * function that guards the real sources is re-run against broken copies below.
 * A fence that cannot fail is a fence that proves nothing. */
const FENCES = {
  'create-only fail-closed primary publication': (b) => {
    assert.match(
      b.productionCode,
      /durable_write_within_root\(/,
      'the primary copy must compose the accepted create-only CAS publication'
    );
    assert.match(
      b.productionCode,
      /b2b-occupied-identity-mismatch/,
      'an occupied, mismatching content identity must have a fail-closed refusal'
    );
    assert.match(
      b.productionCode,
      /fn is_durably_delivered/,
      'delivery must be expressed as an explicit durability predicate'
    );
    assert.match(
      b.productionCode,
      /self\.present\s*&&\s*self\.verified\s*&&\s*\(!self\.created\s*\|\|\s*\(self\.committed\s*&&\s*self\.durability_complete\)\)/,
      'a created copy must require BOTH commit and the durability fence'
    );
  },

  'descriptor-relative no-follow safety': (b) => {
    assert.match(b.productionCode, /confined::Dir/, 'confinement must use the descriptor-relative primitive');
    assert.match(b.productionCode, /open_child_nofollow/, 'directory traversal must be no-follow');
    assert.match(b.productionCode, /open_child_read_nofollow/, 'object reads must be no-follow');
    assert.doesNotMatch(
      b.productionCode,
      /std::fs::(read|write|copy|create_dir|remove|rename|File)/,
      'no pathname-based filesystem authority may bypass the confined primitives'
    );
  },

  'traversal and symlink refusal': (b) => {
    assert.match(b.productionCode, /fn validate_logical_path/, 'the logical path must be validated');
    assert.match(b.productionCode, /b2b-logical-path-dot-segment/, 'dot/dot-dot segments must be refused');
    assert.match(b.productionCode, /b2b-logical-path-not-relative/, 'absolute paths must be refused');
    assert.match(b.productionCode, /b2b-containment-refused/, 'a symlink/non-directory in the derived chain must be refused');
  },

  'hash and size mismatch refusal': (b) => {
    assert.match(b.productionCode, /b2b-sha256-mismatch/, 'a digest mismatch must be refused');
    assert.match(b.productionCode, /b2b-size-mismatch/, 'an exact-size mismatch must be refused');
    assert.match(b.productionCode, /b2b-sha256-malformed/, 'a malformed identity must be refused');
    assert.match(
      b.productionCode,
      /let computed = sha256_hex\(bytes\);/,
      'the identity must be RECOMPUTED over the received bytes'
    );
    assert.match(
      b.productionCode,
      /if computed != descriptor\.sha256/,
      'the caller assertion must be compared against the recomputed digest'
    );
  },

  'no ordinary repair or overwrite path': (b) => {
    /* PRODUCTION half only. The test half legitimately quotes this symbol
     * inside a string literal to prove the comment stripper preserves string
     * literals, and a string literal in a test is not a reachable authority. */
    assert.doesNotMatch(
      b.productionCode,
      /cas_repair_write_within_root/,
      'B2B must never reach the corrupt-object replacement authority'
    );
    assert.doesNotMatch(b.productionCode, /h2o_archive_cas_repair_write/, 'no repair command may be reachable');
    assert.doesNotMatch(
      b.productionCode,
      /ExistingPolicy::Replace|\breplaced\b/,
      'no replacement policy may be expressed'
    );
  },

  'verified exact-byte resolution': (b) => {
    assert.match(b.productionCode, /fn resolve_bytes/, 'a verified resolver must exist');
    assert.match(
      b.productionCode,
      /if sha256_hex\(&found\) != identity/,
      'resolution must recompute the digest over the bytes read back'
    );
    assert.match(b.productionCode, /b2b-resolve-integrity-failure/, 'corruption must be an integrity failure');
    assert.match(b.productionCode, /b2b-resolve-unresolved/, 'absence must be distinguishable from corruption');
    /* Verified readback after publication, not just at resolve time. */
    assert.match(b.productionCode, /fn verified_readback/, 'publication must verify a readback');
  },

  'secondary backup root is recovery-only': (b) => {
    assert.match(
      b.productionCode,
      /BACKUP_ROOT_COMPONENT: &str = "H2O Operating-Space Archive Backups"/,
      'the recovery root component is fixed by the accepted contract'
    );
    assert.match(
      b.productionCode,
      /production_saved_chat_backup_root/,
      'the recovery root base must reuse the accepted immutable mode, not a new selector'
    );
    /* The resolver takes the PRIMARY root only: the recovery copy is never a
     * normal resolution authority. */
    assert.match(
      b.productionCode,
      /pub fn resolve_evidence_object_within_root\(\s*archive_root: &std::path::Path,\s*request: &IdentityRequest,\s*\)/,
      'resolution must accept the primary root only'
    );
    assert.doesNotMatch(
      b.productionCode,
      /backup_root[^)]*\)\s*->\s*Result<Vec<u8>/,
      'the recovery root must never back a byte resolver'
    );
  },

  'no arbitrary or caller-selected root': (b) => {
    assert.doesNotMatch(b.productionCode, /std::env::var|env!\(/, 'no environment variable may select a root');
    for (const banned of [
      'pub path:',
      'pub root:',
      'pub destination:',
      'pub backup_path:',
      'pub backup_root:',
      'pub cas_path:',
      'pub shard:',
      'pub provider:',
      'pub overwrite:',
      'pub replace:',
      'pub repair:',
      'pub delete:',
    ]) {
      assert.ok(
        !b.productionCode.includes(banned),
        `the wire contract must expose no caller-controlled "${banned}" field`
      );
    }
    /* Every caller-facing request type refuses unknown keys, so a supplied
     * destination is a REFUSAL rather than an ignored field. */
    assert.equal(
      occurrences(b.productionCode, 'deny_unknown_fields'),
      3,
      'each of the three request types must deny unknown fields'
    );
    assert.match(
      b.productionCode,
      /fn cas_relative\(identity: &str\)/,
      'the physical destination must be derived from the identity alone'
    );
  },

  'protection mapping preserves governed identity roots': (b) => {
    assert.match(b.productionCode, /PROTECTION_KEY|protection_key_digest/, 'the governed protection key must be explicit');
    assert.match(
      b.productionCode,
      /fn protection_key_digest\(archive_record_id: &str, capture_version: &str\)/,
      'the protection key is (archive_record_id, capture_version)'
    );
    assert.match(b.productionCode, /ONLY_BY_GOVERNED_DISPOSITION/, 'release is only by governed disposition');
    assert.match(b.productionCode, /out\.sort\(\);\s*out\.dedup\(\);/, 'protected identities must be sorted and unique');
    assert.match(b.productionCode, /b2b-protection-record-conflict/, 'a differing mapping at the same key must fail closed');
  },

  'no delete, GC or reclamation authority': (b) => {
    for (const banned of [
      'unlink_child_dir',
      'remove_file',
      'remove_dir_all',
      'archive_reclaim',
      'archive_retention_plan',
      'archive_occupant_quarantine',
      'reclamation',
    ]) {
      assert.ok(!b.productionCode.includes(banned), `B2B must expose no "${banned}" authority`);
    }
    /* The ONE unlink that may exist is this module's own staging cleanup. */
    const unlinks = occurrences(b.productionCode, 'unlink_child');
    assert.ok(unlinks <= 4, `only staging cleanup may unlink (found ${unlinks} sites)`);
    assert.doesNotMatch(b.productionCode, /fn\s+\w*(delete|purge|reclaim|gc)\w*\s*\(/i, 'no delete/GC entry point may exist');
  },

  'no generic Binary-Assets or CAS authority spill': (b) => {
    assert.doesNotMatch(b.productionCode, /AssetRef/, 'B2B mints no AssetRef');
    assert.doesNotMatch(b.productionCode, /refcount|reference_count/i, 'B2B mints no reference counting');
    /* The CAS namespace is CONSUMED from the incumbent authority, never
     * redeclared — a second literal would be a second CAS. */
    assert.match(
      b.productionCode,
      /crate::archive_durable_write::CAS_DIR/,
      'the CAS namespace must be consumed from the incumbent authority'
    );
    assert.doesNotMatch(
      b.productionCode,
      /const\s+CAS_DIR|const\s+\w*ASSETS?_DIR/,
      'B2B must not declare its own CAS namespace constant'
    );
    assert.doesNotMatch(b.productionCode, /fn sha256_hex\(/, 'B2B must not declare a second hashing authority');
    assert.match(b.productionCode, /use crate::archive_durable_write::\{sha256_hex/, 'hashing is the incumbent authority');
  },

  'no source-acquisition or private-session authority': (b) => {
    for (const banned of [
      'reqwest',
      'http',
      'cookie',
      'credential',
      'authorization',
      'bearer',
      'session_token',
      'chatgpt',
      'signed_url',
      'oauth',
    ]) {
      assert.ok(
        !b.productionCode.toLowerCase().includes(banned),
        `B2B holds no source-acquisition authority: found "${banned}"`
      );
    }
  },

  'no working-item9 or P02 runtime mutation': (b) => {
    for (const banned of [
      'working_item9',
      'p02_relationship_apply',
      'p01_standdown_executor',
      'p02_activation',
      'p02_writer_storage',
      'sync_object_transport',
      'local_publication_intake',
    ]) {
      assert.ok(!b.productionCode.includes(banned), `B2B must not reach P02/Sync runtime authority "${banned}"`);
    }
  },

  'no private payload leakage into the Product tree': (b) => {
    /* The module writes only beneath the two internally derived governed roots
     * and never into the repository or any temp path of its own choosing. */
    assert.doesNotMatch(b.productionCode, /temp_dir\(\)/, 'production code must not choose a temp destination');
    assert.doesNotMatch(b.productionCode, /REPO_ROOT|CARGO_MANIFEST_DIR|env!\("OUT_DIR"\)/, 'no repository-relative write');
    /* Results carry no physical location, so no path reaches Archive metadata. */
    const resultBlock = b.productionCode.slice(
      b.productionCode.indexOf('pub struct CopyOutcome'),
      b.productionCode.indexOf('impl CopyOutcome')
    );
    assert.ok(resultBlock.length > 0, 'CopyOutcome must exist');
    assert.doesNotMatch(resultBlock, /pub path|pub root/, 'a result must not return a physical path');
  },

  'bounded Host lease scope in lib.rs': (b) => {
    assert.equal(
      occurrences(b.libCode, 'pub mod operating_space_archive_delivery;'),
      1,
      'exactly one module declaration'
    );
    for (const command of B2B_COMMANDS) {
      assert.equal(
        occurrences(b.libCode, `operating_space_archive_delivery::${command}`),
        2,
        `${command} must be registered once in each debug/release handler`
      );
    }
    /* The bounded module needs no process-local state, so the lease registers
     * none — state registration was permitted ONLY if actually required. */
    assert.doesNotMatch(
      b.libCode,
      /\.manage\(operating_space_archive_delivery::/,
      'the bounded module requires no managed state'
    );
    /* Total B2B footprint in lib.rs: 1 declaration + 8 registrations. */
    assert.equal(
      occurrences(b.libCode, 'operating_space_archive_delivery'),
      9,
      'the Host lease footprint is exactly one declaration plus eight registrations'
    );
  },

  'P02 T19 and relationship registrations remain intact': (b) => {
    assert.equal(
      occurrences(b.libCode, P02_T19_REGISTRATION),
      2,
      'the P02 T19 writer-generation standdown executor must stay registered in both handlers'
    );
    assert.equal(
      occurrences(b.libCode, P02_RELATIONSHIP_REGISTRATION),
      2,
      'the P02 relationship-apply command must stay registered in both handlers'
    );
  },

  'the command surface is the minimum sufficient four': (b) => {
    assert.equal(
      occurrences(b.productionCode, '#[tauri::command]'),
      4,
      'B2B v1 exposes exactly publish / resolve / record-protection / verify'
    );
    for (const command of B2B_COMMANDS) {
      assert.ok(b.productionCode.includes(`pub async fn ${command}`), `${command} must exist`);
    }
  },
};

/* ── Run the fences against the real sources ─────────────────────────────── */

console.log('\n[b2b-physical-delivery] contract fences');

const REAL = bundleFrom(read(MODULE_REL), read(LIB_REL));

for (const [label, fence] of Object.entries(FENCES)) {
  check(label, () => fence(REAL));
}

/* ── Negative controls ───────────────────────────────────────────────────── */

/* Each entry breaks exactly ONE fence and names it. If the mutated source
 * still passes that fence, the fence has stopped detecting anything and THIS
 * validator fails — which is the point of the control. */
const CONTROLS = [
  {
    label: 'a replaced durability requirement',
    fence: 'create-only fail-closed primary publication',
    /* Anchored on a WRAPPING-INSENSITIVE pattern: rustfmt rewraps this
     * expression across lines, and a control pinned to one exact spelling
     * would silently stop mutating anything. */
    mutate: (b) => ({
      ...b,
      module: b.module.replace(
        /self\.present\s*&&\s*self\.verified\s*&&\s*\(!self\.created\s*\|\|\s*\(self\.committed\s*&&\s*self\.durability_complete\)\)/,
        'self.present'
      ),
    }),
  },
  {
    label: 'a removed occupied-identity refusal',
    fence: 'create-only fail-closed primary publication',
    mutate: (b) => ({ ...b, module: b.module.split('b2b-occupied-identity-mismatch').join('b2b-ok') }),
  },
  {
    label: 'a reachable repair/replace authority',
    fence: 'no ordinary repair or overwrite path',
    mutate: (b) => ({
      ...b,
      module: b.module.replace(
        'fn cas_relative(identity: &str)',
        'fn unused() { let _ = cas_repair_write_within_root; }\nfn cas_relative(identity: &str)'
      ),
    }),
  },
  {
    label: 'a caller-supplied physical destination',
    fence: 'no arbitrary or caller-selected root',
    mutate: (b) => ({
      ...b,
      module: b.module.replace('    pub archive_record_id: String,', '    pub path: String,\n    pub archive_record_id: String,'),
    }),
  },
  {
    label: 'an open request type accepting unknown keys',
    fence: 'no arbitrary or caller-selected root',
    mutate: (b) => ({
      ...b,
      module: b.module.replace('rename_all = "camelCase", deny_unknown_fields', 'rename_all = "camelCase"'),
    }),
  },
  {
    label: 'a dropped digest recomputation',
    fence: 'hash and size mismatch refusal',
    mutate: (b) => ({
      ...b,
      module: b.module.replace('let computed = sha256_hex(bytes);', 'let computed = descriptor.sha256.clone();'),
    }),
  },
  {
    label: 'corruption reported as absence',
    fence: 'verified exact-byte resolution',
    mutate: (b) => ({
      ...b,
      module: b.module.split('b2b-resolve-integrity-failure').join('b2b-resolve-unresolved'),
    }),
  },
  {
    label: 'an environment-selected root',
    fence: 'no arbitrary or caller-selected root',
    mutate: (b) => ({
      ...b,
      module: b.module.replace(
        'fn cas_relative(identity: &str)',
        'fn root_override() -> Option<String> { std::env::var("H2O_B2B_ROOT").ok() }\nfn cas_relative(identity: &str)'
      ),
    }),
  },
  {
    label: 'an added delete entry point',
    fence: 'no delete, GC or reclamation authority',
    mutate: (b) => ({
      ...b,
      module: b.module.replace(
        'fn cas_relative(identity: &str)',
        'pub fn delete_object(_i: &str) {}\nfn cas_relative(identity: &str)'
      ),
    }),
  },
  {
    label: 'a second declared CAS namespace',
    fence: 'no generic Binary-Assets or CAS authority spill',
    mutate: (b) => ({
      ...b,
      module: b.module.replace(
        'fn cas_relative(identity: &str)',
        'const CAS_DIR: &str = "assets";\nfn cas_relative(identity: &str)'
      ),
    }),
  },
  {
    label: 'a source-acquisition dependency',
    fence: 'no source-acquisition or private-session authority',
    mutate: (b) => ({
      ...b,
      module: b.module.replace('fn cas_relative(identity: &str)', 'use reqwest as _net;\nfn cas_relative(identity: &str)'),
    }),
  },
  {
    label: 'a P02 runtime reach',
    fence: 'no working-item9 or P02 runtime mutation',
    mutate: (b) => ({
      ...b,
      module: b.module.replace(
        'fn cas_relative(identity: &str)',
        'fn reach() { let _ = crate::p02_relationship_apply::h2o_p02_relationship_apply; }\nfn cas_relative(identity: &str)'
      ),
    }),
  },
  {
    label: 'a dropped release-handler registration',
    fence: 'bounded Host lease scope in lib.rs',
    mutate: (b) => ({
      ...b,
      lib: b.lib.replace(
        '            operating_space_archive_delivery::h2o_operating_space_archive_verify_delivery,\n',
        '',
      ),
    }),
  },
  {
    label: 'an unnecessary managed state registration',
    fence: 'bounded Host lease scope in lib.rs',
    mutate: (b) => ({
      ...b,
      lib: b.lib.replace(
        '.manage(saved_chat_local_backup::BackupState::default())',
        '.manage(operating_space_archive_delivery::DeliveryState::default())\n        .manage(saved_chat_local_backup::BackupState::default())'
      ),
    }),
  },
  {
    label: 'a removed P02 T19 registration',
    fence: 'P02 T19 and relationship registrations remain intact',
    mutate: (b) => ({
      ...b,
      lib: b.lib.replace(`            ${P02_T19_REGISTRATION},\n`, ''),
    }),
  },
  {
    label: 'a removed P02 relationship registration',
    fence: 'P02 T19 and relationship registrations remain intact',
    mutate: (b) => ({
      ...b,
      lib: b.lib.replace(`            ${P02_RELATIONSHIP_REGISTRATION},\n`, ''),
    }),
  },
  {
    label: 'a fifth command on the bounded surface',
    fence: 'the command surface is the minimum sufficient four',
    mutate: (b) => ({
      ...b,
      module: b.module.replace(
        'fn cas_relative(identity: &str)',
        '#[tauri::command]\npub async fn h2o_extra() {}\nfn cas_relative(identity: &str)'
      ),
    }),
  },
];

console.log('\n[b2b-physical-delivery] negative controls (each must make its fence RED)');

for (const control of CONTROLS) {
  check(`negative control detects ${control.label}`, () => {
    const mutated = control.mutate({ module: REAL.module, lib: REAL.lib });
    assert.ok(
      mutated.module !== REAL.module || mutated.lib !== REAL.lib,
      'the control did not actually change the source — its anchor has drifted'
    );
    const bundle = bundleFrom(mutated.module, mutated.lib);
    let threw = false;
    try {
      FENCES[control.fence](bundle);
    } catch {
      threw = true;
    }
    assert.ok(threw, `fence "${control.fence}" did not detect ${control.label}`);
  });
}

/* Product-main window negative controls. Each one drives the SAME classifier
 * the live check uses, proves it goes RED on the offending position, and then
 * proves it still accepts the neighbouring clean position — a control that
 * rejected everything would be no control at all. */

check('negative control: a later Product main that touched an authorized B2B path is rejected', () => {
  const later = 'a'.repeat(40);
  const dirty = classifyProductMain({
    originMain: later,
    isForwardDescendant: true,
    touchedAuthorizedPaths: [MODULE_REL],
  });
  assert.equal(dirty.window, null, 'a Product main that rewrote the B2B module must not be accepted');
  assert.ok(
    dirty.reason && dirty.reason.includes(MODULE_REL),
    `the refusal must name the touched path, got: ${dirty.reason}`
  );
  for (const rel of AUTHORIZED_PATHS) {
    assert.equal(
      classifyProductMain({ originMain: later, isForwardDescendant: true, touchedAuthorizedPaths: [rel] }).window,
      null,
      `a Product main touching ${rel} must be rejected`
    );
  }
  /* Discrimination: the same forward-only main with the three paths untouched
   * is exactly what window B is for, and must be accepted. */
  assert.equal(
    classifyProductMain({ originMain: later, isForwardDescendant: true, touchedAuthorizedPaths: [] }).window,
    'B',
    'a forward-only Product main clear of the three paths must satisfy window B'
  );
});

check('negative control: a Product main that is not a forward-only descendant of the frozen base is rejected', () => {
  const divergent = 'b'.repeat(40);
  const verdict = classifyProductMain({
    originMain: divergent,
    isForwardDescendant: false,
    touchedAuthorizedPaths: [],
  });
  assert.equal(verdict.window, null, 'a divergent or rewound Product main must not be accepted');
  assert.ok(
    verdict.reason && verdict.reason.includes('forward-only descendant'),
    `the refusal must name the lineage requirement, got: ${verdict.reason}`
  );
  /* Not even an otherwise-clean path set rescues a non-descendant. */
  assert.equal(
    classifyProductMain({
      originMain: divergent,
      isForwardDescendant: false,
      touchedAuthorizedPaths: [],
    }).window,
    null,
    'lineage is checked before, and independently of, the path set'
  );
  /* Discrimination: the same commit reached forward-only is accepted, and
   * window A — equality with the frozen base — is untouched by this correction. */
  assert.equal(
    classifyProductMain({ originMain: divergent, isForwardDescendant: true, touchedAuthorizedPaths: [] }).window,
    'B',
    'a forward-only descendant must satisfy window B'
  );
  assert.equal(
    classifyProductMain({
      originMain: BASE_PRODUCT_MAIN,
      isForwardDescendant: true,
      touchedAuthorizedPaths: [],
    }).window,
    'A',
    'Product main exactly at the frozen base must still satisfy window A'
  );
});

check('the comment stripper removes prose without eating code or strings', () => {
  const sample = 'let a = 1; // cas_repair_write_within_root\n/* std::env::var */\nlet s = "keep // this";\nlet b = 2;';
  const stripped = codeOnly(sample);
  assert.ok(!stripped.includes('cas_repair_write_within_root'), 'line comment survived');
  assert.ok(!stripped.includes('std::env::var'), 'block comment survived');
  assert.ok(stripped.includes('"keep // this"'), 'a string literal was damaged');
  assert.ok(stripped.includes('let a = 1;') && stripped.includes('let b = 2;'), 'code was damaged');
});

/* ── Candidate topology ──────────────────────────────────────────────────── */

console.log('\n[b2b-physical-delivery] candidate topology');

const baseReachable = gitOrNull(['cat-file', '-t', BASE_PRODUCT_MAIN]) === 'commit';

if (!baseReachable) {
  skip(
    'candidate topology',
    `the pinned T02 base ${BASE_PRODUCT_MAIN} is not reachable in this checkout; the contract fences above still ran`
  );
} else {
  const head = gitOrNull(['rev-parse', 'HEAD']);
  const headParent = gitOrNull(['rev-parse', 'HEAD^']);
  const dirtyAgainstBase =
    (gitOrNull(['diff', '--name-only', BASE_PRODUCT_MAIN]) || '') !== '' ||
    (gitOrNull(['ls-files', '--others', '--exclude-standard']) || '') !== '';
  /* "Positioned as the candidate" = the single T02 commit on top of the pinned
   * base, or that base with the T02 work still in the working tree. */
  const candidatePosition =
    (head === BASE_PRODUCT_MAIN && dirtyAgainstBase) || headParent === BASE_PRODUCT_MAIN;

  check('the pinned base tree is exactly the authorized tree', () => {
    assert.equal(gitOrNull(['rev-parse', `${BASE_PRODUCT_MAIN}^{tree}`]), BASE_PRODUCT_TREE);
  });

  check('the lib.rs pre-image at the pinned base is the leased blob', () => {
    assert.equal(gitOrNull(['rev-parse', `${BASE_PRODUCT_MAIN}:${LIB_REL}`]), LIB_RS_PREIMAGE_BLOB);
  });

  if (!candidatePosition) {
    skip(
      'exact three-path diff against the pinned base',
      'HEAD is not positioned as the T02 candidate (single commit on, or working tree over, the pinned base); the diff would describe unrelated history rather than this change'
    );
    skip('candidate parent is the pinned base', 'HEAD is not positioned as the T02 candidate');
    skip(
      'Product main is inside an authorized window (A: at the frozen base; B: forward-only and clear of the three B2B paths)',
      'HEAD is not positioned as the T02 candidate'
    );
  } else {
    check('exact three-path diff against the pinned base', () => {
      /* Tracked modifications AND untracked additions. A new Product file is
       * untracked until it is committed, so a tracked-only diff would let a
       * brand-new fourth path slip past the allowlist entirely. */
      const tracked = (gitOrNull(['diff', '--name-only', BASE_PRODUCT_MAIN]) || '')
        .split('\n')
        .filter(Boolean);
      const untracked = (gitOrNull(['ls-files', '--others', '--exclude-standard']) || '')
        .split('\n')
        .filter(Boolean);
      const changed = [...new Set([...tracked, ...untracked])].sort();
      assert.deepEqual(changed, AUTHORIZED_PATHS, 'the write set must be exactly the three authorized paths');
      assert.equal(changed.length, 3, 'a fourth Product path is prohibited');
    });

    check('candidate parent is the pinned base', () => {
      if (head === BASE_PRODUCT_MAIN) {
        assert.ok(dirtyAgainstBase, 'uncommitted candidate over the pinned base');
        return;
      }
      assert.equal(headParent, BASE_PRODUCT_MAIN, 'the candidate must be rooted directly at the pinned base');
    });

    check('the lib.rs lease diff is mechanical registration only', () => {
      const diff = gitOrNull(['diff', '--unified=0', BASE_PRODUCT_MAIN, '--', LIB_REL]) || '';
      const removed = diff
        .split('\n')
        .filter((line) => line.startsWith('-') && !line.startsWith('---'));
      assert.deepEqual(removed, [], 'the Host lease permits additions only — nothing may be removed from lib.rs');

      const added = diff
        .split('\n')
        .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
        .map((line) => line.slice(1).trim())
        .filter(Boolean);
      for (const line of added) {
        const mechanical =
          line.startsWith('///') ||
          line === 'pub mod operating_space_archive_delivery;' ||
          /^operating_space_archive_delivery::h2o_operating_space_archive_\w+,$/.test(line);
        assert.ok(mechanical, `non-mechanical lib.rs addition outside the lease: ${JSON.stringify(line)}`);
      }
      assert.ok(added.length > 0, 'the lease was expected to be consumed');
    });

    check('Product main is inside an authorized window (A: at the frozen base; B: forward-only and clear of the three B2B paths)', () => {
      const originMain = gitOrNull(['rev-parse', 'origin/main']);
      if (originMain === null) {
        /* No remote-tracking ref in this checkout: the local pin is still
         * checked, and ref position is a fetch-time property. */
        assert.equal(gitOrNull(['cat-file', '-t', BASE_PRODUCT_MAIN]), 'commit');
        return;
      }
      /* B1 — forward-only descendant. `merge-base --is-ancestor` exits 0 (empty
       * stdout) when it holds and non-zero otherwise, so null means "no". */
      const isForwardDescendant =
        gitOrNull(['merge-base', '--is-ancestor', BASE_PRODUCT_MAIN, originMain]) !== null;
      /* B2 — nothing landed on the three authorized B2B paths since the base. */
      const touchedAuthorizedPaths = (
        gitOrNull([
          'diff',
          '--name-only',
          `${BASE_PRODUCT_MAIN}..${originMain}`,
          '--',
          ...AUTHORIZED_PATHS,
        ]) || ''
      )
        .split('\n')
        .filter(Boolean);

      const verdict = classifyProductMain({ originMain, isForwardDescendant, touchedAuthorizedPaths });
      assert.equal(
        verdict.reason,
        null,
        verdict.reason || 'Product main is outside both authorized windows'
      );
      assert.ok(
        verdict.window === 'A' || verdict.window === 'B',
        `Product main ${originMain} satisfied neither window A nor window B`
      );
    });
  }
}

/* ── Authorized files exist and nothing else was introduced ──────────────── */

console.log('\n[b2b-physical-delivery] write set');

check('all three authorized paths are present', () => {
  for (const rel of AUTHORIZED_PATHS) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `${rel} must exist`);
  }
});

check('no sibling B2B module was introduced beside the bounded one', () => {
  const dir = path.join(REPO_ROOT, 'apps/studio/desktop/src-tauri/src');
  const strays = fs
    .readdirSync(dir)
    .filter((name) => /operating.?space/i.test(name) && name !== 'operating_space_archive_delivery.rs');
  assert.deepEqual(strays, [], 'the B2B adapter is exactly one module');
});

/* ── Report ──────────────────────────────────────────────────────────────── */

if (FAIL.length) {
  console.error(
    `\n[operating-space-archive-physical-delivery-v1] ${FAIL.length} failed, ${PASS.length} passed${SKIP.length ? `, ${SKIP.length} skipped` : ''}`
  );
  process.exitCode = 1;
} else {
  console.log(
    `\n[operating-space-archive-physical-delivery-v1] all ${PASS.length} checks passed${SKIP.length ? ` (${SKIP.length} scoped check(s) skipped)` : ''}`
  );
}
