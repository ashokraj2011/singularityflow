/**
 * The catalog of a person's steps: each table is a read of one row per decision [study 6.3].
 * test/person-step-golden.test.mjs pins what those readers answer; this pins that the rows join up.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { recordableInApproval } from '../src/approval-decisions.mjs';
import { OWN_TERMINAL_STEPS as routed } from '../src/command-skills.mjs';
import { adjudicationTableStep, ANSWER_BOUND_STEPS, ANSWER_BOUND_TURNS, DECIDE_SKILL_MUTATIONS, DECISION_LIST_CHAT_OPTIONS, IN_APPROVAL_EFFECTS, ISSUE_ONLY_OPTIONS, OWN_TERMINAL_STEPS, PERSON_DECISIONS, PERSON_STEP_FAMILIES, PERSON_STEP_REVIEW_EFFECTS, PERSON_STEPS } from '../src/person-step-catalog.mjs';
import { PERSON_STEP_FAMILIES as signed } from '../src/presence/person-steps.mjs';
import { REVIEW_EFFECTS } from '../src/state.mjs';

test('each row names a guard entry that exists, and each table reads the rows', () => {
  const own = new Set(OWN_TERMINAL_STEPS.map((step) => step.id));
  const decisions = new Set(PERSON_DECISIONS.map((step) => step.id));
  for (const row of PERSON_STEPS) {
    if (row.guard === null) continue;
    const [kind, id] = row.guard.split(':');
    assert.ok({ own, decision: decisions }[kind]?.has(id) || kind === 'turn', `${row.id}: ${row.guard}`);
  }
  assert.equal(new Set(PERSON_STEPS.map((row) => row.id)).size, PERSON_STEPS.length);
  assert.equal(new Set(PERSON_STEP_FAMILIES.map((family) => family.list)).size, PERSON_STEP_FAMILIES.length, 'one family per list');
  // The readers hold the catalog's own objects, so no copy can drift from it.
  assert.equal(routed, OWN_TERMINAL_STEPS);
  assert.equal(signed, PERSON_STEP_FAMILIES);
  for (const [key, entry] of Object.entries(PERSON_STEP_REVIEW_EFFECTS)) assert.equal(REVIEW_EFFECTS[key], entry, key);
  assert.deepEqual(Object.keys(REVIEW_EFFECTS).filter((key) => key.startsWith('decision-made:')), Object.keys(PERSON_STEP_REVIEW_EFFECTS));
  // No row's review kind is missing from what the review rules read.
  assert.deepEqual(PERSON_STEPS.filter((row) => row.review && !Object.hasOwn(PERSON_STEP_REVIEW_EFFECTS, `decision-made:${row.review.kind}`)), []);
});

test('the answer binding reads the catalog, and every step it holds is a guard entry', async () => {
  const { ANSWER_BOUND_SKILLS } = await import('../src/copilot-mutation-guard.mjs');
  const binding = await import('../src/copilot-answer-binding.mjs');
  assert.deepEqual([...ANSWER_BOUND_SKILLS], [...binding.ANSWER_BOUND_TURNS]);
  assert.equal(binding.ANSWER_BOUND_TURNS, ANSWER_BOUND_TURNS);
  const known = new Set([...OWN_TERMINAL_STEPS, ...PERSON_DECISIONS].map((step) => step.id));
  // The upstream decision is refused by the guard's own rule, not a table entry; see personStep.
  assert.deepEqual(ANSWER_BOUND_STEPS.filter((id) => !known.has(id)), ['upstream-issue-decision']);
  for (const id of ANSWER_BOUND_STEPS) assert.equal(binding.answerBoundStep({ id }), true, id);
  assert.equal(binding.answerBoundStep({ id: 'witness' }), false);
  // A person's whole table in their own terminal is an own-terminal entry too.
  assert.ok(OWN_TERMINAL_STEPS.some((step) => step.id === 'adjudication-table'));
  assert.equal(adjudicationTableStep(['story', 'adjudicate'], {}), true);
  assert.equal(adjudicationTableStep(['story', 'adjudicate', 'CF-1'], {}), false, 'naming an item stays /sf-converge\'s');
});

test('what a chat, an approval and a /sf-decide turn may record are read from the same rows', () => {
  assert.deepEqual([...ISSUE_ONLY_OPTIONS], [...DECISION_LIST_CHAT_OPTIONS]);
  assert.deepEqual([...IN_APPROVAL_EFFECTS].sort(), ['evidence-reuse', 'test-run-risk', 'upstream-issue', 'upstream-issue-decision', 'visual-profile']);
  for (const kind of IN_APPROVAL_EFFECTS) assert.equal(recordableInApproval({ effects: [{ kind }] }), true, kind);
  assert.equal(recordableInApproval({ effects: [{ kind: 'test-command' }] }), false, 'a test command changes what was reviewed');
  // A departure's decision is a /sf-decide turn's too, held to what the person answered [CQF:REQ-024].
  assert.deepEqual([...DECIDE_SKILL_MUTATIONS].sort(), ['applicability', 'choose', 'completeness', 'departure', 'plan', 'scope']);
});
