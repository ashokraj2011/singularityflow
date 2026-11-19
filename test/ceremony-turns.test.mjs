/**
 * Ceremony cuts 2, 9 and 10 (owner, 2026-11-19: "too many jargons and too many confusing loops"), at the agent's view:
 *   - a ready review is submitted in the turn that wrote the version, never a separate /sf-submit turn, unless the submission
 *     records decision values, which are the person's: then /sf-submit's route, never a guess;
 *   - a submission that completes its step ends the turn: the next step is named for the person, never started [decision 7];
 *   - the review's findings on a version only the reviewer has seen start the next version on their own, at most 2 in a row,
 *     and never again for a finding that came back after the fix; the undo is forward only;
 *   - the outcome review is one optional line, never a question;
 *   - the shipped chat policy stays `new` (a /clear after each approval); `keep` is a team's own choice, and its approval
 *     turn still ends, naming the next step for the person.
 * Journey B (journey-stories.test.mjs) walks the same through a real Story.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { agentAct } from '../src/agent-output.mjs';
import { inTurnSubmitCommand, reviewFindingsOpenCommand } from '../src/action-command-map.mjs';
import { reviewerAloneSaw, reviewFindingsHold, sourceReviewContinuation } from '../src/source-review-continuation.mjs';
import { phaseAuthoringEntry } from '../src/phase-authoring-entry.mjs';
import { reraisedRoute, SETTLED_KINDS } from '../src/settled-decisions.mjs';
import { plainSettled } from '../src/decision-plain.mjs';
import { approvalAgentResult } from '../src/approval-agent-result.mjs';
import { clarificationCheckpoint, renderClarificationProtocol } from '../src/clarifications.mjs';
import { sourceReviewDecisionPacket } from '../src/source-review-decision.mjs';

const W = 'CUT-1';
const story = (phase = {}, extra = {}) => ({ workItem: { id: W }, currentPhase: 'implement', phaseOrder: ['implement'],
  phases: { implement: { id: 'implement', label: 'Implement', status: 'in_progress', generation: 1, ...phase } }, ...extra });
const correction = (extra = {}) => ({ status: 'correction-required', generation: 1, reportSha256: 'b'.repeat(64), findings: [{ code: 'reviewer-blocker', message: 'Say why the value is 2.' }],
  decisions: [], carriedDecisions: [], pendingDispositions: [], ...extra });

/** A code step at `generation`, reviewed, with the kernel's own records: what sourceReviewContinuation and the entry read. */
function codeStory({ generation = 1, settled = [], opening = null, decisions = null } = {}) {
  const id = 'implementation';
  const phase = { id, label: 'Implementation', status: 'in_progress', generation,
    generationPolicy: { requirement: 'required', defaultProducer: 'governed-agent', task: 'code' },
    requiredArtifact: { path: `artifacts/${id}/summary.md` }, generationIntent: { status: 'consumed', generation },
    generationPublications: Array.from({ length: generation }, (_, index) => ({ generation: index + 1, record: { path: `context/${id}-gen${index + 1}.json` } })),
    ...(opening ? { versionOpening: opening } : {}) };
  return { workItem: { id: 'BIN-1', workType: 'custom' }, status: 'in_progress', currentPhase: id, phaseOrder: [id], phases: { [id]: phase }, history: [],
    settledDecisions: settled,
    resolution: { sourceReview: { mode: 'enforce', level: 2, phases: [id], kinds: { [id]: 'code' }, reviewerAgent: 'sflow-source-reviewer' }, ...(decisions ? { decisions } : {}) } };
}
const reviewOf = (generation, ids = ['F-1']) => ({ status: 'correction-required', generation, reportSha256: 'a'.repeat(64), pendingDispositions: [], decisions: [], carriedDecisions: [],
  findings: ids.map((id) => ({ code: 'reviewer-blocker', reviewFindingId: id, message: `Reviewer finding '${id}': fix it.` })) });
// A start SFlow made for a review's findings, as review-findings-opening.mjs records it: the version it came from, the one it
// opened, and the reviewer's findings it was started for.
const startOf = (n, from, to, findings = ['F-0']) => ({ id: `STL-00${n}`, kind: 'review-corrections', phase: 'implementation', by: 'sflow',
  effect: { generation: from, toGeneration: to, findings } });
const settledOpening = (version) => ({ version, consent: { settled: 'STL-002', surface: 'settled' } });

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

test('SFlow starts at most 2 versions in a row for a review\'s findings; the third asks the person, saying why', () => {
  // Versions 2 and 3 open on their own.
  for (const workflow of [codeStory(), codeStory({ generation: 2, settled: [startOf(1, 1, 2)], opening: settledOpening(2) })]) {
    const phase = workflow.phases.implementation;
    assert.equal(reviewFindingsHold(workflow, phase, reviewOf(phase.generation)), null);
    assert.equal(sourceReviewContinuation(workflow, phase, reviewOf(phase.generation)).nextCommand, reviewFindingsOpenCommand('implementation'));
  }
  // Version 3's review asks for corrections again: the third in a row is the person's question.
  const third = codeStory({ generation: 3, settled: [startOf(1, 1, 2), startOf(2, 2, 3)], opening: settledOpening(3) });
  const phase = third.phases.implementation;
  const review = reviewOf(3);
  assert.deepEqual(reviewFindingsHold(third, phase, review), { reason: 'rounds', words: 'The reviewer has asked for corrections 3 times in a row.' });
  assert.equal(reviewerAloneSaw(third, phase, review), false, 'one rule for the continuation, the entry and the opening');
  const next = sourceReviewContinuation(third, phase, review);
  assert.equal(next.nextCommand, 'singularity-flow phase rollover implementation --json', 'the preview that asks');
  assert.match(next.actions[0].reason, /^The reviewer has asked for corrections 3 times in a row\. \/sf-code asks the person "Start version 4 of Implementation to fix the review's findings\?"/u);
  const entry = phaseAuthoringEntry(third, phase, { review });
  assert.equal(entry.status, 'successor-confirmation-required');
  assert.equal(entry.successor.because, 'The reviewer has asked for corrections 3 times in a row.');
  assert.match(entry.successor.question, /^Start version 4 of Implementation to fix the review's findings\?/u);
  const act = agentAct({ resultType: 'sflow-phase-entry', phase: 'implementation', ...entry, next: entry.actions });
  assert.equal(act.state, 'confirm');
  assert.match(act.said, /^The reviewer has asked for corrections 3 times in a row\. The review of implementation asked for corrections: ask the person whether to start version 4/u);
  assert.match(act.ask.how, /^Say successor\.because first\./u);
});

test('a person\'s yes on a version resets the count: only starts in a row since then count', () => {
  // Version 3 opened on the person's yes after SFlow started version 2: version 4 starts on its own again.
  const workflow = codeStory({ generation: 3, settled: [startOf(1, 1, 2)], opening: { version: 3, consent: { receiptId: 'VCR-1', surface: 'cli' } } });
  const phase = workflow.phases.implementation;
  assert.equal(reviewFindingsHold(workflow, phase, reviewOf(3)), null);
  assert.equal(reviewerAloneSaw(workflow, phase, reviewOf(3)), true);
  // A start whose opening never happened (no version 3 on the record) counts for nothing either.
  const dangling = codeStory({ generation: 2, settled: [startOf(1, 2, 3)], opening: settledOpening(2) });
  assert.equal(reviewFindingsHold(dangling, dangling.phases.implementation, reviewOf(2)), null);
});

test('a finding that comes back after SFlow\'s fix asks the person at once', () => {
  const workflow = codeStory({ generation: 2, settled: [startOf(1, 1, 2, ['F-1', 'F-2'])], opening: settledOpening(2) });
  const phase = workflow.phases.implementation;
  // A new finding is fixed on its own again.
  assert.equal(reviewFindingsHold(workflow, phase, reviewOf(2, ['F-3'])), null);
  // F-2 survived the fix: a disagreement or a specification problem, so the person decides.
  const back = reviewOf(2, ['F-2', 'F-3']);
  assert.deepEqual(reviewFindingsHold(workflow, phase, back), { reason: 'repeated', findings: ['F-2'], words: 'The reviewer\'s finding F-2 came back after SFlow\'s fix.' });
  const entry = phaseAuthoringEntry(workflow, phase, { review: back });
  assert.equal(entry.status, 'successor-confirmation-required');
  assert.equal(entry.successor.because, 'The reviewer\'s finding F-2 came back after SFlow\'s fix.');
});

test('the settlement is a kind of its own, said plainly, and its undo says it is forward only', () => {
  assert.ok(SETTLED_KINDS.includes('review-corrections'));
  const entry = { id: 'STL-001', kind: 'review-corrections', phase: 'implement', effect: { generation: 1, toGeneration: 2 } };
  const route = reraisedRoute(story(), entry);
  assert.match(route.words, /^From now on SFlow asks you before it starts another version of implement for a review's findings\. An undo does not withdraw the version it started: that stays open/u);
  // The person's real say on the findings: their words to the author, or a return at approval. No route withdraws an open version.
  assert.match(route.words, /tell the author while it writes that version, or return the step when you approve it\.$/u);
  assert.equal(route.copilotCommand, '/sf-phase-documents implement');
  assert.equal(plainSettled(story(), entry), 'SFlow started version 2 of Implement to fix the review\'s findings because only the reviewer had seen version 1. Undo only makes SFlow ask you first next time; version 2 stays open.');
  assert.doesNotMatch(plainSettled(story(), entry), /Undo if wrong/u);
  // Why the undo names no dispute: a reviewer's blocking finding has none, before a start or after it. A person decides only a
  // review's pending dispositions (an exclusion, a not-applicable test); an approver who still disagrees returns the step.
  // Owner item (2026-11-19): whether a person may dispute a reviewer's blocking finding at all.
  const status = { status: 'correction-required', generation: 1, reportSha256: 'b'.repeat(64), pendingDispositions: [],
    findings: [{ code: 'reviewer-blocker', reviewFindingId: 'explain-the-value', message: 'Say why the value is 2.' }] };
  assert.throws(() => sourceReviewDecisionPacket({ workflow: story(), phaseId: 'implement', status, findingId: 'explain-the-value', reason: 'The comment is enough.',
    actor: { email: 'approver@example.test' }, authority: { authorityGroup: 'engineering-reviewers' } }), { code: 'SOURCE_REVIEW_DISPOSITION_NOT_PENDING' });
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
  // Decision values are the person's: never asked or guessed in the author's turn.
  assert.match(act.said, /If it submits nothing because it names decisionInputs, those values are the person's: end the turn on its \/sf-submit route, never ask them here\./u);
  assert.doesNotMatch(act.said, /asking the person only for a decisionInputs value/u);
});

test('a submission that records decision values is never run in the author\'s turn: its route is /sf-submit', () => {
  const ready = { status: 'ready', generation: 1, reportSha256: 'a'.repeat(64), findings: [], pendingDispositions: [], decisions: [], carriedDecisions: [] };
  const plain = codeStory();
  assert.equal(sourceReviewContinuation(plain, plain.phases.implementation, ready).inTurn?.command, inTurnSubmitCommand('BIN-1'));
  const decided = codeStory({ decisions: [{ id: 'risk-route', label: 'Risk route', after: 'implementation', mode: 'auto', inputs: [{ name: 'risk', type: 'string' }], routes: [] }] });
  const next = sourceReviewContinuation(decided, decided.phases.implementation, ready);
  assert.equal(next.classification, 'submission-required');
  assert.equal(next.inTurn, undefined, 'no in-turn submission: the person gives the values in /sf-submit');
  assert.equal(next.nextCommand, 'singularity-flow submit implementation --work-id BIN-1 --decision risk=<risk>');
  // The author's turn ends its reply on that route, for the person: never runs it.
  const act = agentAct({ resultType: 'source-review-status', phase: 'implementation', generation: 1, status: 'ready', reportSha256: 'a'.repeat(64), continuation: next });
  assert.notEqual(act.state, 'submit');
  assert.equal(act.show, next.presentation);
  assert.match(act.show, /- Copilot: `\/sf-submit/u);
});

test('a submission that completes its step ends the turn and names the next step for the person, never starts it', () => {
  const next = { instruction: 'Submitted. End the reply with this next action.', reason: 'Write the Verify.',
    contextBoundary: { mode: 'new', commands: ['/clear', '/sf-phase'] },
    commandGuidance: { copilotCommand: '/sf-phase verify', command: 'singularity-flow prepare verify', modelFreeCommand: null } };
  const act = agentAct({ resultType: 'sflow-submission-readiness', classification: 'ready-to-attempt',
    submitIfReady: { submitted: true, next, result: { phase: 'implement', generation: 2, status: 'completed' } } });
  assert.equal(act.state, 'end-turn');
  assert.match(act.said, /^Submitted, and that completed implement\. End this turn\. Name the next step for the person: \/clear, then \/sf-phase, in a new turn; never start it here\.$/u);
  assert.deepEqual([act.do.copilot, act.do.shell, act.do.turn], ['/sf-phase verify', 'singularity-flow prepare verify', 'new-turn']);
  // Submitted for approval: the approval is a person's, as before.
  const awaiting = agentAct({ resultType: 'sflow-submission-readiness', classification: 'ready-to-attempt',
    submitIfReady: { submitted: true, next, result: { phase: 'implement', generation: 2, status: 'submitted' } } });
  assert.equal(awaiting.state, 'next');
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
  const line = `Only the reviewer had seen version 1 of Implement, so SFlow started version 2 to fix its findings. Version 2 stays open; an undo on the decisions card (/sf-decide ${W}) only makes SFlow ask you before it starts another.`;
  const opened = agentAct({ resultType: 'sflow-generation-rollover', kind: 'review-corrections', mutates: true, line, settled: { id: 'STL-001' },
    nextAction: { command: 'singularity-flow prepare implement', skill: '/sf-code', reason: 'Write version 2.' } });
  assert.equal(opened.state, 'next');
  assert.equal(opened.show, line);
  assert.equal(opened.do.shell, 'singularity-flow prepare implement');
  assert.match(opened.said, /fix the review's findings in this same turn; ask the person nothing about it/u);
});

test('the shipped policy keeps /clear; a team that keeps the chat gets the next step named for the person, never run', () => {
  // `new` (shipped): the approval's boundary, /clear then the next step's own command.
  const fresh = approvalAgentResult({ outcome: { status: 'succeeded' }, data: { contextBoundary: { mode: 'new', commands: ['/clear', '/sf-phase'], nextPhase: 'requirements', complete: false } } });
  assert.deepEqual(fresh.contextBoundary.commands, ['/clear', '/sf-phase']);
  assert.equal(fresh.nextStep, undefined);
  assert.equal(fresh.turnBoundary, 'end');
  // `keep` (a team's own): the approval turn still ends; it only names the next step [the 11-17 approval-turn rule].
  const kept = approvalAgentResult({ outcome: { status: 'succeeded' }, data: { contextBoundary: { mode: 'keep', commands: ['/sf-phase'], nextPhase: 'requirements', complete: false } } });
  assert.equal(kept.turnBoundary, 'end');
  assert.equal(kept.instruction, 'End this turn. Name the next step for the person: /sf-phase. Do not repeat approval or author the next phase here.');
  const act = agentAct({ resultType: 'sflow-approval-agent-result', outcome: { status: 'succeeded' }, turnBoundary: 'end',
    nextStep: { copilotCommand: '/sf-phase', phase: 'requirements' } });
  assert.equal(act.state, 'end-turn');
  assert.equal(act.do, null);
  assert.equal(act.said, 'Approved. End this turn. Name the next step for the person: /sf-phase (requirements). Offer no other route.');
  assert.doesNotMatch(act.said, /same chat|one Enter/u);
});

test('intake clarification is required and never stalls: with nothing open, one question names the assumptions, "Go ahead" recommended', () => {
  const policy = { mode: 'required', maxQuestions: 5, topics: ['scope'] };
  const protocol = renderClarificationProtocol(policy, 'intake');
  assert.match(protocol, /Pause for at least one human response before authoring\./u);
  assert.match(protocol, /When the request leaves nothing open, ask one question naming the assumptions this step will build on, with "Go ahead" recommended, and record that answer\./u);
  assert.doesNotMatch(protocol, /confirm your concise interpretation/u);
  const checkpoint = clarificationCheckpoint(policy, { recordState: 'missing', errors: [] });
  assert.equal(checkpoint.stage, 'derive-questions');
  assert.match(checkpoint.instruction, /When it leaves nothing open, ask one question naming the assumptions this step will build on, with "Go ahead" recommended, and record that answer\./u);
  // Later steps ask only when something is truly unclear, and keep their way to ask and record a question mid-step.
  const later = renderClarificationProtocol({ mode: 'when-needed', maxQuestions: 5, topics: [] }, 'design');
  assert.match(later, /Ask only when a material ambiguity remains/u);
  assert.match(later, /intent-amendment draft/u);
  assert.doesNotMatch(later, /Go ahead/u);
});
