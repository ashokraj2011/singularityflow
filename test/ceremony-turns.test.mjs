/**
 * Ceremony cuts 2, 9 and 10 (owner, 2026-11-19: "too many jargons and too many confusing loops"), at the agent's view:
 *   - a ready review is submitted in the turn that wrote the version, never a separate /sf-submit turn;
 *   - the review's findings on a version only the reviewer has seen start the next version on their own, with an undo;
 *   - the outcome review is one optional line, never a question.
 * Journey B (journey-stories.test.mjs) walks the same through a real Story.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { agentAct } from '../src/agent-output.mjs';
import { inTurnSubmitCommand, reviewFindingsOpenCommand } from '../src/action-command-map.mjs';
import { reviewerAloneSaw } from '../src/source-review-continuation.mjs';
import { reraisedRoute, SETTLED_KINDS } from '../src/settled-decisions.mjs';
import { plainSettled } from '../src/decision-plain.mjs';

const W = 'CUT-1';
const story = (phase = {}, extra = {}) => ({ workItem: { id: W }, currentPhase: 'implement', phaseOrder: ['implement'],
  phases: { implement: { id: 'implement', label: 'Implement', status: 'in_progress', generation: 1, ...phase } }, ...extra });
const correction = (extra = {}) => ({ status: 'correction-required', generation: 1, reportSha256: 'b'.repeat(64), findings: [{ code: 'reviewer-blocker', message: 'Say why the value is 2.' }],
  decisions: [], carriedDecisions: [], pendingDispositions: [], ...extra });

test('only the reviewer has seen a version: no answer on its review, no approval, no submission, no undone start', () => {
  const workflow = story();
  assert.equal(reviewerAloneSaw(workflow, workflow.phases.implement, correction()), true);
  assert.equal(reviewerAloneSaw(workflow, workflow.phases.implement, { ...correction(), status: 'ready' }), false, 'a ready review asks for nothing');
  assert.equal(reviewerAloneSaw(workflow, workflow.phases.implement, correction({ generation: 2 })), false, 'a review of another version');
  assert.equal(reviewerAloneSaw(workflow, workflow.phases.implement, correction({ reportSha256: null })), false, 'no retained report');
  assert.equal(reviewerAloneSaw(workflow, workflow.phases.implement, correction({ decisions: [{ id: 'D-1' }] })), false, 'a person answered the review');
  assert.equal(reviewerAloneSaw(workflow, workflow.phases.implement, correction({ pendingDispositions: [{ id: 'F-1' }] })), false, 'a person is owed a decision');
  for (const phase of [{ approvals: [{ generation: 1 }] }, { submittedAt: '2026-11-19T00:00:00Z' }, { rejectedAt: '2026-11-19T00:00:00Z' }, { status: 'awaiting_approval' }]) {
    const seen = story(phase);
    assert.equal(reviewerAloneSaw(seen, seen.phases.implement, correction()), false, JSON.stringify(phase));
  }
  const undone = story({}, { settledDecisions: [{ id: 'STL-001', kind: 'review-corrections', phase: 'implement' }, { id: 'STL-002', undoes: 'STL-001' }] });
  assert.equal(reviewerAloneSaw(undone, undone.phases.implement, correction()), false, 'a person undid an earlier start: asked from then on');
  const standing = story({}, { settledDecisions: [{ id: 'STL-001', kind: 'review-corrections', phase: 'implement' }] });
  assert.equal(reviewerAloneSaw(standing, standing.phases.implement, correction()), true);
});

test('the settlement is a kind of its own, said plainly, and its undo hands the question back', () => {
  assert.ok(SETTLED_KINDS.includes('review-corrections'));
  const entry = { id: 'STL-001', kind: 'review-corrections', phase: 'implement', effect: { generation: 1, toGeneration: 2 } };
  const route = reraisedRoute(story(), entry);
  assert.match(route.words, /^SFlow asks you before it starts another version of implement for a review's findings\./u);
  assert.equal(route.copilotCommand, '/sf-phase-documents implement');
  assert.equal(plainSettled(story(), entry), 'SFlow started version 2 of Implement to fix the review\'s findings because only the reviewer had seen version 1. Undo if wrong.');
});

test('a ready review is submitted in the author\'s turn; a review turn of its own still ends on the next step for the person', () => {
  const inTurn = { command: inTurnSubmitCommand(W), skill: '/sf-submit', reason: 'Submit the ready version now, in the turn that wrote it.' };
  assert.equal(inTurn.command, `singularity-flow status ${W} --submission-readiness --for-agent --json --submit-if-ready`);
  const act = agentAct({ resultType: 'source-review-status', phase: 'implement', generation: 1, status: 'ready', reportSha256: 'a'.repeat(64),
    continuation: { classification: 'submission-required', inTurn, presentation: 'Now — Submit the Implement for approval',
      actions: [{ skill: '/sf-submit', command: `singularity-flow submit implement --work-id ${W}`, copilotCommand: '/sf-submit' }] } });
  assert.equal(act.state, 'submit');
  assert.equal(act.do.shell, inTurn.command);
  assert.equal(act.show, 'Now — Submit the Implement for approval');
  assert.match(act.said, /submits it now: run do\.shell once/u);
  assert.match(act.said, /never a separate submit turn, never an approval/u);
});

test('the review\'s findings on an unseen version: the entry runs the start itself, and its result is said in one line', () => {
  const command = reviewFindingsOpenCommand('implement');
  assert.equal(command, 'singularity-flow phase rollover implement --review-findings --json');
  const entry = agentAct({ resultType: 'sflow-phase-entry', status: 'retained-generation', phase: 'implement',
    next: [{ timing: 'now', command, skill: '/sf-code', label: 'Fix the review\'s findings (version 2)' }] });
  assert.equal(entry.state, 'next');
  assert.equal(entry.do.shell, command);
  assert.match(entry.said, /run do\.shell now, in this turn/u);
  assert.match(entry.said, /Ask the person nothing about it/u);
  assert.equal(entry.ask, undefined);
  const line = `Only the reviewer had seen version 1 of Implement, so SFlow started version 2 to fix its findings; undo it on the decisions card (/sf-decide ${W}).`;
  const opened = agentAct({ resultType: 'sflow-generation-rollover', kind: 'review-corrections', mutates: true, line, settled: { id: 'STL-001' },
    nextAction: { command: 'singularity-flow prepare implement', skill: '/sf-code', reason: 'Write version 2.' } });
  assert.equal(opened.state, 'next');
  assert.equal(opened.show, line);
  assert.equal(opened.do.shell, 'singularity-flow prepare implement');
  assert.match(opened.said, /fix the review's findings in this same turn; ask the person nothing about it/u);
});

test('after an approval in a kept chat, the one next step is the next step\'s own command', () => {
  const act = agentAct({ resultType: 'sflow-approval-agent-result', outcome: { status: 'succeeded' }, turnBoundary: 'end',
    nextStep: { copilotCommand: '/sf-phase', phase: 'requirements' } });
  assert.equal(act.state, 'end-turn');
  assert.match(act.said, /^Approved\. End this turn; the one next step is \/sf-phase \(requirements\), in this same chat: VS Code puts it in the chat input for one Enter\./u);
  assert.doesNotMatch(act.said, /\/clear/u);
});
