// @version 1.1.0
//
// L-EXTENSION-INTERNAL-CHAT regression: a mounted answer whose turn is already committed
// must not be published as a second logical turn.
//
// Windowing can mount an answer whose question shell sits behind a gap. The
// cross-gap fix (f1489c8f) deliberately emits that draft unpaired rather than
// rebinding it to whichever question happens to precede it. commitTurnDrafts()
// then appended it as a new turn, so one answer message was claimed by two
// logical turns and logical membership followed the mounted window instead of
// the conversation. These fixtures pin the suppression and, just as important,
// pin the cross-gap protection it must not weaken.
//
// commitTurnDrafts() has since moved to canonical-membership-only commitment
// (f2633474). The unmatched-live loop now hydrates an existing canonical record
// or suppresses, and creates no logical member at all, so unowned live evidence
// has no append path to reach. The source pins below assert that wall directly
// instead of ordering a creation call that no longer exists.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const SOURCE_REL = "src-runtime-base/0A1a.⬛️🧠 H2O Core 🧠.js";
const SOURCE_PATH = path.join(REPO_ROOT, SOURCE_REL);
const source = fs.readFileSync(SOURCE_PATH, "utf8");

/* The production helpers are function declarations inside the module IIFE, so
   the `const` statement anchor used elsewhere does not apply. Brace-match the
   declaration instead and fail closed on an ambiguous or unterminated name. */
function sliceBracedRegion(text, start) {
  let depth = 0;
  let seenBody = false;
  let quote = "";
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") { depth += 1; seenBody = true; continue; }
    if (ch === "}") {
      depth -= 1;
      if (seenBody && depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function extractFunction(name) {
  const prefix = `  function ${name}(`;
  const start = source.indexOf(prefix);
  if (start < 0) throw new Error(`function-anchor-missing:${name}`);
  if (source.indexOf(prefix, start + 1) >= 0) throw new Error(`function-anchor-ambiguous:${name}`);
  const region = sliceBracedRegion(source, start);
  if (region === null) throw new Error(`function-boundary-invalid:${name}`);
  return region.trimStart();
}

/* The no-new-logical-turn pin must be scoped to the unmatched-live loop itself.
   A whole-file search would be worse than useless here: `createTurnRecord(` and
   `nextRecords.push(` both appear legitimately in the canonical-drafts
   membership path, so a global ban would condemn correct code and a global
   absence check would pass vacuously. Brace-match the loop and test its body. */
const UNMATCHED_LIVE_LOOP_ANCHOR = "for (const draft of unmatchedLiveDrafts) {";

function extractUnmatchedLiveLoop(text = source) {
  const start = text.indexOf(UNMATCHED_LIVE_LOOP_ANCHOR);
  if (start < 0) throw new Error("unmatched-live-loop-anchor-missing");
  if (text.indexOf(UNMATCHED_LIVE_LOOP_ANCHOR, start + 1) >= 0) {
    throw new Error("unmatched-live-loop-anchor-ambiguous");
  }
  const region = sliceBracedRegion(text, start);
  if (region === null) throw new Error("unmatched-live-loop-boundary-invalid");
  return region;
}

// Operations that would publish a new logical member out of live evidence.
const NEW_LOGICAL_MEMBER_OPERATIONS = [
  "createTurnRecord(",
  "nextRecords.push(",
  "nextRecords.splice(",
];

function newLogicalMemberOperationsIn(region) {
  return NEW_LOGICAL_MEMBER_OPERATIONS.filter((operation) => region.includes(operation));
}

/* Falsification harness: re-inject a creation path into a copy of the loop body
   so the pin is proven capable of failing, not merely observed absent. */
function sourceWithOperationInjectedIntoLoop(operation) {
  const region = extractUnmatchedLiveLoop();
  const start = source.indexOf(region);
  const injected = region.replace(/\}$/, `  ${operation}draft);\n    }`);
  if (injected === region) throw new Error("loop-injection-failed");
  return source.slice(0, start) + injected + source.slice(start + region.length);
}

const EXTRACTED = [
  "normalizeTurnAlias",
  "canonicalDraftAnswerIds",
  "canonicalRecordAnswerIds",
  "canonicalQIdsConflict",
  "refreshLegacyTurnCompat",
  "canonicalCommittedAnswerOwner",
  "bindLiveAnswerEvidenceToOwner",
];

const sandbox = {
  H2O: { msg: { normalizeId: (raw) => String(raw || "").trim().toLowerCase() } },
};
vm.createContext(sandbox);
vm.runInContext(EXTRACTED.map(extractFunction).join("\n\n"), sandbox, {
  filename: SOURCE_REL,
});
const {
  canonicalCommittedAnswerOwner,
  bindLiveAnswerEvidenceToOwner,
} = sandbox;

const Q = "11111111-1111-1111-1111-111111111111";
const A = "22222222-2222-2222-2222-222222222222";
const OTHER_Q = "33333333-3333-3333-3333-333333333333";
const UNOWNED_A = "44444444-4444-4444-4444-444444444444";

function ownedRecord(overrides = {}) {
  return {
    turnId: `turn:${Q}`,
    turnNo: 1,
    qId: Q,
    answerIds: [A],
    primaryAId: A,
    hasQuestion: true,
    hasAssistant: true,
    live: { qEl: { tag: "q" }, primaryAEl: null, answerEls: [], connected: true },
    ...overrides,
  };
}

// The assistant-only draft windowing produces: an answer identity, no question.
function assistantOnlyDraft(answerId = A, el = { tag: "a" }) {
  return {
    qId: null,
    answerIds: [answerId],
    structure: { unpairedAssistant: true },
    live: { qEl: null, primaryAEl: el, answerEls: [el], connected: true },
  };
}

const fixtures = [];
const record = (name, fn) => fixtures.push({ name, fn });

// TEST A — the proven case: the answer is already owned, so no turn is appended
// and the owner is the single claimant.
record("windowed-duplicate-answer-resolves-to-single-owner", () => {
  const owner = ownedRecord();
  const decision = canonicalCommittedAnswerOwner([owner], assistantOnlyDraft());
  assert.equal(decision.basis, "committed-answer-identity");
  assert.equal(decision.candidateCount, 1);
  assert.equal(decision.record, owner, "the question-anchored turn must own the answer");
});

// TEST A (binding) — the mounted answer element reaches the owner without
// disturbing the question element the owner already bound, or any identity.
record("owner-gains-answer-element-without-losing-question-element", () => {
  const owner = ownedRecord();
  const qEl = owner.live.qEl;
  const draft = assistantOnlyDraft();
  bindLiveAnswerEvidenceToOwner(owner, draft);
  assert.equal(owner.live.qEl, qEl, "question element must survive the bind");
  assert.equal(owner.live.primaryAEl, draft.live.primaryAEl, "answer element must be bound");
  assert.equal(owner.live.connected, true);
  assert.equal(owner.qId, Q, "identity must not be rewritten");
  assert.equal(owner.turnId, `turn:${Q}`, "turn id must not be rewritten");
  assert.deepEqual(owner.answerIds, [A], "answer set must not be rewritten");
});

// TEST B — remount: applying the same evidence twice must not duplicate the
// owner's element set, so membership cannot drift across mount cycles.
record("repeated-bind-is-idempotent", () => {
  const owner = ownedRecord();
  const el = { tag: "a" };
  bindLiveAnswerEvidenceToOwner(owner, assistantOnlyDraft(A, el));
  bindLiveAnswerEvidenceToOwner(owner, assistantOnlyDraft(A, el));
  assert.equal(owner.live.answerEls.length, 1, "answer elements must not accumulate");
  assert.equal(owner.live.primaryAEl, el);
});

// TEST C — cross-gap protection: an unpaired assistant whose answer nobody owns
// must NOT be attached to an unrelated question that merely precedes it.
record("unowned-assistant-is-not-rebound-to-preceding-question", () => {
  const preceding = ownedRecord({ turnId: `turn:${OTHER_Q}`, qId: OTHER_Q, answerIds: [A], primaryAId: A });
  const decision = canonicalCommittedAnswerOwner([preceding], assistantOnlyDraft(UNOWNED_A));
  assert.equal(decision.record, null, "proximity must never establish ownership");
  assert.equal(decision.basis, "unclaimed-answer-identity");
});

// TEST D — an unclaimed unpaired assistant yields no owner. Under
// canonical-membership-only commitment there is no append path to fall through
// to, so this evidence simply remains unappended.
record("unclaimed-answer-identity-remains-unappended", () => {
  const decision = canonicalCommittedAnswerOwner([ownedRecord()], assistantOnlyDraft(UNOWNED_A));
  assert.equal(decision.record, null);
  assert.equal(decision.candidateCount, 0);
  assert.equal(decision.basis, "unclaimed-answer-identity");
  assert.deepEqual(
    newLogicalMemberOperationsIn(extractUnmatchedLiveLoop()),
    [],
    "unclaimed live evidence must have no creation path to reach",
  );
});

// TEST E — ambiguity fails closed: more than one claimant must not be resolved
// by picking one, and the ambiguous evidence remains unappended.
record("ambiguous-answer-ownership-fails-closed-and-remains-unappended", () => {
  const first = ownedRecord();
  const second = ownedRecord({ turnId: `turn:${OTHER_Q}`, turnNo: 2, qId: OTHER_Q });
  const decision = canonicalCommittedAnswerOwner([first, second], assistantOnlyDraft());
  assert.equal(decision.record, null, "an owner must never be invented");
  assert.equal(decision.basis, "ambiguous-answer-owner");
  assert.equal(decision.candidateCount, 2);
  assert.deepEqual(
    newLogicalMemberOperationsIn(extractUnmatchedLiveLoop()),
    [],
    "ambiguous live evidence must have no creation path to reach",
  );
});

// Scope guard — a draft that carries its own question is not this repair's
// business; it stays on the existing matching path.
record("draft-with-its-own-question-is-out-of-scope", () => {
  const decision = canonicalCommittedAnswerOwner([ownedRecord()], {
    qId: OTHER_Q,
    answerIds: [A],
    live: { qEl: null, primaryAEl: { tag: "a" }, answerEls: [], connected: true },
  });
  assert.equal(decision.record, null);
  assert.equal(decision.basis, "draft-owns-question");
});

// A conflicting question identity must disqualify a candidate outright.
record("conflicting-question-identity-disqualifies-owner", () => {
  const owner = ownedRecord();
  const decision = canonicalCommittedAnswerOwner([owner], {
    qId: OTHER_Q,
    answerIds: [A],
    live: { qEl: null, primaryAEl: null, answerEls: [], connected: false },
  });
  assert.equal(decision.record, null, "cross-question answer overlap must not bind");
});

// Source-level pins: ordering, canonical-owner resolution, and the membership
// wall the unmatched-live loop must not cross.
record("unmatched-live-loop-resolves-owner-and-creates-no-turn", () => {
  const loop = extractUnmatchedLiveLoop();
  const suppression = loop.indexOf("chatAtlasBranchTransitionSuppressesLiveAppend()");
  const ownerCheck = loop.indexOf("canonicalCommittedAnswerOwner(nextRecords, draft)");
  const bind = loop.indexOf("bindLiveAnswerEvidenceToOwner(");
  assert.ok(suppression >= 0, "branch-transition suppression must remain in the loop");
  assert.ok(ownerCheck >= 0, "canonical owner must be resolved inside the loop");
  assert.ok(bind >= 0, "the resolved owner must receive the live answer evidence");
  assert.ok(suppression < ownerCheck, "branch-transition suppression must stay first");
  assert.ok(ownerCheck < bind, "ownership must be resolved before evidence is bound");

  // The membership wall: live evidence hydrates an existing canonical record and
  // never publishes a logical member of its own.
  assert.deepEqual(
    newLogicalMemberOperationsIn(loop),
    [],
    "unmatched live evidence must create no logical turn",
  );

  /* Not vacuous: both banned operations DO exist in this file, in the
     canonical-drafts membership path, which this pin must not condemn. Their
     absence from the loop is therefore a scoped fact, not a global one. */
  for (const operation of ["createTurnRecord(", "nextRecords.push("]) {
    assert.ok(source.includes(operation), `${operation} must still exist in the canonical-drafts path`);
    assert.ok(!loop.includes(operation), `${operation} must not appear in the unmatched-live loop`);
  }

  // Falsifiable: the same detector must fire when a creation path is inserted.
  for (const operation of NEW_LOGICAL_MEMBER_OPERATIONS) {
    const poisoned = extractUnmatchedLiveLoop(sourceWithOperationInjectedIntoLoop(operation));
    assert.deepEqual(
      newLogicalMemberOperationsIn(poisoned),
      [operation],
      `the pin must fail when ${operation} is inserted into the loop`,
    );
  }
});

record("cross-gap-unpaired-assistant-machinery-remains", () => {
  assert.match(source, /unpairedAssistant: true/, "unpaired assistant drafts must still be produced");
  assert.match(
    source,
    /if \(draft\?\.structure\?\.unpairedAssistant === true\) continue;/,
    "unpaired assistants must stay out of durable retention",
  );
  assert.doesNotMatch(
    source,
    /canonicalCommittedAnswerOwner[\s\S]{0,400}closest\(/,
    "ownership must never consult DOM neighbours",
  );
});

record("ownership-never-uses-proximity-or-ordinal", () => {
  const fn = extractFunction("canonicalCommittedAnswerOwner");
  for (const banned of ["turnNo", "closest", "previousElementSibling", "textContent", "indexOf("]) {
    assert.ok(!fn.includes(banned), `ownership must not rely on ${banned}`);
  }
});

let passed = 0;
const failures = [];
for (const fixture of fixtures) {
  try {
    fixture.fn();
    passed += 1;
  } catch (error) {
    failures.push({ name: fixture.name, error: String(error?.message || error) });
    process.stderr.write(`FAIL ${fixture.name}: ${error?.message || error}\n`);
  }
}

const summary = {
  ok: failures.length === 0,
  productionSourcePath: SOURCE_REL,
  fixtureCount: fixtures.length,
  passed,
  failures: failures.length,
  results: failures,
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
process.exit(failures.length === 0 ? 0 : 1);
