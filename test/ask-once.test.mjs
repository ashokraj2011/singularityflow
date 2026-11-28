/**
 * Ask once (owner, 2026-11-28: "no one should get stuck, and every decision should be easy for people to understand why
 * they are making that decision"). Pure checks of the question rules every step follows, whatever its workflow:
 *   - a person's send-back is the answer to "Start version N?": its version opens on it, and the line names that answer;
 *   - a version only the reviewer saw after an earlier send-back starts on its own for the review's findings;
 *   - a question that stays says why it is asked and what each answer does, and is asked once;
 *   - what a person already answered anywhere in the Story reaches the reviewer and the author, and SFlow's own notes in a
 *     request are shown as SFlow's.
 * The walks that drive these through the CLI are journeys F and Y (test/journey-stories.test.mjs).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { sentBackAnswer } from '../src/phase-generation-need.mjs';
import { decisionRoutes, stepDecisionOf } from '../src/step-decision.mjs';
import { reviewerAloneSaw, sourceReviewContinuation } from '../src/source-review-continuation.mjs';
import { phaseAuthoringEntry } from '../src/phase-authoring-entry.mjs';
import { agentAct } from '../src/agent-output.mjs';
import { versionProposal, versionQuestionWhy } from '../src/story-version-proposal.mjs';
import { SETTLED_OPENINGS, settledOpening } from '../src/story-version-opening.mjs';
import { reraisedRoute, SETTLED_KINDS } from '../src/settled-decisions.mjs';
import { answeredEarlier, sflowNotesIn } from '../src/answered-questions.mjs';
import { clarificationCheckpoint } from '../src/clarifications.mjs';
import { sentBackLine } from '../src/sent-back-opening.mjs';
import { sentBackOpenCommand } from '../src/action-command-map.mjs';

const PERSON = { name: 'Pat Approver', email: 'pat@example.test' };

/** A code step whose version 1 was published, submitted and returned to itself by a person with a reason. */
function returned({ automatic = false, reason = 'Say in the code why the value is 2.' } = {}) {
  const id = 'implement';
  const phase = { id, label: 'Implement', status: 'in_progress', generation: 1,
    generationPolicy: { requirement: 'required', defaultProducer: 'governed-agent', task: 'code' },
    generationIntent: { status: 'consumed', generation: 1 }, requiredArtifact: { path: `artifacts/${id}/implement.md` },
    generationPublications: [{ generation: 1, record: { path: `context/${id}-gen1.json` } }],
    reworkRevalidation: { generation: 1, invalidatedAt: '2026-11-28T10:00:00Z' }, rejectedAt: '2026-11-28T10:00:00Z' };
  return { workItem: { id: 'ASK-1', workType: 'custom' }, status: 'in_progress', currentPhase: id, phaseOrder: [id], phases: { [id]: phase },
    history: [{ at: '2026-11-28T09:00:00Z', phase: id, event: 'phase_generated' }],
    changeRequests: [{ id: 'CR-001', status: 'open', sourcePhase: id, sourceGeneration: 1, targetPhase: id, comment: reason,
      requestedBy: automatic ? { automatic: true } : PERSON, identityAssurance: automatic ? 'automatic' : 'git-identity',
      ...(automatic ? { automatic: { kind: 'failing-tests' } } : {}) }],
    resolution: {} };
}

test('a person\'s send-back is the answer to its next version: every surface names its start, and nobody is asked', () => {
  const workflow = returned(), phase = workflow.phases.implement;
  assert.deepEqual(sentBackAnswer(workflow, phase), { changeRequest: 'CR-001', from: { phase: 'implement', version: 1 }, reason: 'Say in the code why the value is 2.' });
  // The kernel still needs the person's yes; the send-back is that yes, so its route is the start on it, not the preview.
  const decision = stepDecisionOf(workflow, phase);
  assert.equal(decision.next.operation, 'open-version');
  assert.equal(decision.next.inputs.reason, 'rework');
  assert.equal(decisionRoutes(decision, workflow, phase)[0].command, sentBackOpenCommand('implement'));
  assert.equal(sourceReviewContinuation(workflow, phase).nextCommand, 'singularity-flow phase rollover implement --sent-back --json');
  const entry = phaseAuthoringEntry(workflow, phase);
  assert.equal(entry.status, 'retained-generation');
  assert.equal(entry.reason, 'sent-back-settle');
  // The agent runs it in this turn and asks nothing.
  const act = agentAct({ resultType: 'sflow-phase-entry', status: 'retained-generation', phase: 'implement',
    next: entry.actions.map((action) => ({ ...action, timing: 'now' })) });
  assert.equal(act.state, 'next', JSON.stringify(act));
  assert.equal(act.ask, undefined);
  assert.match(act.said, /Ask the person nothing/u);
  assert.match(act.do?.shell ?? '', /phase rollover implement --sent-back --json/u);
});

test('a step the send-back reopened after its target opens on the same answer when the Story reaches it', () => {
  // Release version 2 was sent back to Implement; Implement's fix was approved, and Release (reopened with it) is next.
  const workflow = returned();
  workflow.changeRequests[0] = { ...workflow.changeRequests[0], sourcePhase: 'release', sourceGeneration: 2, targetPhase: 'implement',
    status: 'resolved', requestedAt: '2026-11-28T10:00:00Z', comment: 'The release notes must name the new value.' };
  workflow.phases.implement.status = 'approved';
  workflow.phases.release = { ...structuredClone(workflow.phases.implement), id: 'release', label: 'Release', status: 'in_progress', generation: 2,
    generationPolicy: { requirement: 'required', defaultProducer: 'governed-agent' }, generationIntent: undefined, rejectedAt: undefined,
    generationPublications: [{ generation: 2, record: { path: 'context/release-gen2.json' } }],
    reworkRevalidation: { generation: 2, invalidatedAt: '2026-11-28T10:00:00Z' } };
  workflow.phaseOrder = ['implement', 'release'];
  workflow.currentPhase = 'release';
  const release = workflow.phases.release;
  assert.deepEqual(sentBackAnswer(workflow, release), { changeRequest: 'CR-001', from: { phase: 'release', version: 2 }, reason: 'The release notes must name the new value.' });
  assert.equal(phaseAuthoringEntry(workflow, release).reason, 'sent-back-settle');
  // A reopening at another moment is not this send-back's.
  release.reworkRevalidation.invalidatedAt = '2026-11-28T12:00:00Z';
  assert.equal(sentBackAnswer(workflow, release), null);
});

test('SFlow\'s own return, an undone start and a step not being worked on keep their own routes', () => {
  const own = returned({ automatic: true });
  assert.equal(sentBackAnswer(own, own.phases.implement), null, 'SFlow\'s return of failing tests is not a person\'s answer');
  assert.equal(phaseAuthoringEntry(own, own.phases.implement).status, 'successor-confirmation-required');
  const undone = returned();
  undone.settledDecisions = [{ id: 'STL-001', kind: 'sent-back', phase: 'implement', subject: 'x', answer: 'y', evidence: [], by: 'sflow' },
    { id: 'STL-002', undoes: 'STL-001', actor: 'pat' }];
  assert.equal(sentBackAnswer(undone, undone.phases.implement), null, 'after an undo the question is the person\'s again');
  const elsewhere = returned();
  elsewhere.currentPhase = 'verify';
  assert.equal(sentBackAnswer(elsewhere, elsewhere.phases.implement), null);
  // No reason given: it still opens, and the line says only that it was sent back.
  const bare = returned({ reason: 'Changes requested.' });
  assert.equal(sentBackAnswer(bare, bare.phases.implement).reason, null);
});

test('the start on a send-back is settled with an undo, and its line names the answer used', () => {
  assert.ok(SETTLED_KINDS.includes('sent-back'));
  assert.deepEqual([...SETTLED_OPENINGS['sent-back']], ['rework', 'rejected']);
  assert.equal(settledOpening({ kind: 'sent-back', settlement: {} }, { reason: 'rework' }), true);
  assert.equal(settledOpening({ kind: 'sent-back', settlement: {} }, { reason: 'review-corrections' }), false);
  const workflow = returned();
  const words = reraisedRoute(workflow, { kind: 'sent-back', phase: 'implement', effect: { toGeneration: 2 } }).words;
  assert.match(words, /asks you before it starts implement's next version after a send-back/u);
  const line = sentBackLine(workflow, workflow.phases.implement, sentBackAnswer(workflow, workflow.phases.implement), 2);
  assert.equal(line, 'Using your answer from Implement version 1: "Say in the code why the value is 2." SFlow started version 2 of Implement on it, so nothing is asked.');
});

test('a version only the reviewer saw after an earlier send-back starts on its own for the review\'s findings', () => {
  const workflow = returned(), phase = workflow.phases.implement;
  // Version 2 was written after the return and published; its review asks for corrections.
  phase.generation = 2;
  phase.generationIntent = { status: 'consumed', generation: 2 };
  phase.generationPublications.push({ generation: 2, record: { path: 'context/implement-gen2.json' } });
  workflow.history.push({ at: '2026-11-28T11:00:00Z', phase: 'implement', event: 'phase_generated' });
  workflow.changeRequests[0].status = 'resolved';
  const review = { status: 'correction-required', generation: 2, reportSha256: 'a'.repeat(64), findings: [{ code: 'reviewer-blocker', reviewFindingId: 'F-1' }] };
  assert.equal(reviewerAloneSaw(workflow, phase, review), true, 'the person returned version 1, not version 2');
  // Before version 2 was written, the return was of the published version itself: a person saw it.
  workflow.history.pop();
  assert.equal(reviewerAloneSaw(workflow, phase, review), false);
});

test('a version question that stays says why it is asked and what each answer does, in one line each', () => {
  for (const reason of ['review-corrections', 'requested-change', 'changed-after-publication', 'own-correction', 'amendment', 'watermark']) {
    const { why, yes, no } = versionQuestionWhy({ reason, version: 3, step: 'Release', from: { published: 2 } });
    for (const line of [why, yes, no]) {
      assert.ok(line.length > 20 && line.length < 200 && !/\n/u.test(line), `${reason}: ${line}`);
      assert.doesNotMatch(line, /sha256|digest|generation/u, `${reason}: plain words`);
    }
    assert.match(yes, /^Yes starts version 3/u);
    assert.match(no, /^No /u);
  }
  // A hold that made it the person's is the why itself.
  assert.equal(versionQuestionWhy({ reason: 'review-corrections', version: 4, step: 'X', from: { published: 3 } },
    { because: 'The reviewer has asked for corrections 3 times in a row.' }).why, 'The reviewer has asked for corrections 3 times in a row.');
  // The entry's question carries it, and the agent's act says it and each choice's does.
  const workflow = returned({ automatic: true }), phase = workflow.phases.implement;
  const entry = phaseAuthoringEntry(workflow, phase);
  assert.ok(entry.successor.why);
  assert.match(entry.successor.does.Yes, /^Yes starts version 2/u);
  assert.match(entry.successor.preview.reason, /once; on their Yes run this preview, then the confirmation it returns, without asking again/u);
  const act = agentAct({ resultType: 'sflow-phase-entry', status: 'successor-confirmation-required', phase: 'implement',
    successor: { ...entry.successor, targetGeneration: 2 }, next: entry.actions.map((action) => ({ ...action, timing: 'now' })) });
  assert.equal(act.state, 'confirm');
  assert.equal(act.ask.why, entry.successor.why);
  assert.deepEqual(act.ask.choices.map((choice) => Boolean(choice.does)), [true, true]);
  assert.match(act.ask.how, /^Say ask\.why first/u);
  assert.match(act.ask.how, /on that same Yes without asking again/u);
  // The preview's own question, once more in the same turn, is not asked twice.
  const { question, asked } = versionProposal(workflow, phase, { reason: 'rework' });
  const preview = agentAct({ resultType: 'sflow-generation-rollover', mutates: false, question, why: asked.why, does: { Yes: asked.yes, No: asked.no },
    nextAction: { command: 'singularity-flow phase rollover implement --confirm sha256:x', copilotCommand: '/sf-code implement' } });
  assert.match(preview.ask?.how ?? '', /If the person already said Yes to ask\.question in this turn, do not ask again/u, JSON.stringify(preview));
});

test('what the person already answered reaches the reader, and SFlow\'s own request notes are named as SFlow\'s', async () => {
  const notes = sflowNotesIn(['# Request', '', 'Plot a function.', '', 'Request copied from Story GP-1 at 0123456789abcdef0123456789abcdef01234567.', '',
    'Supporting documents were not copied. Attach needed documents and images to this new Story.'].join('\n'));
  assert.deepEqual(notes.map((note) => note.line), [5, 7]);
  assert.deepEqual(sflowNotesIn('Supporting documents are attached.'), []);
  const workflow = returned();
  workflow.upstreamIssues = [{ id: 'UPI-001', phase: 'implement', problem: 'The plan names no screenshot for the chart.' }];
  workflow.upstreamIssueDecisions = [{ issue: 'UPI-001', outcome: 'accept-risk', reason: 'Functional inspiration only; no picture is needed.' }];
  const answered = await answeredEarlier('/nonexistent-ask-once', {}, workflow);
  assert.deepEqual(answered.map((entry) => [entry.kind, entry.id]), [['send-back', 'CR-001'], ['upstream-issue', 'UPI-001']]);
  assert.match(answered[1].answer, /^accept-risk: Functional inspiration only/u);
  // SFlow's own return is not an answer.
  assert.deepEqual(await answeredEarlier('/nonexistent-ask-once', {}, returned({ automatic: true })), []);
  // The author is told never to ask them again.
  const checkpoint = clarificationCheckpoint({ mode: 'when-needed' }, { recordState: 'missing', errors: [] }, { answered: 2 });
  assert.match(checkpoint.instruction, /clarification\.answered, which the person already gave in this Story/u);
  assert.doesNotMatch(clarificationCheckpoint({ mode: 'when-needed' }, { recordState: 'missing', errors: [] }).instruction, /clarification\.answered/u);
});
