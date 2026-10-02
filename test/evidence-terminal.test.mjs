import assert from 'node:assert/strict';
import test from 'node:test';

import { printCompletionVerdict, recordedCompletion } from '../src/completion-verdict.mjs';
import {
  applicabilityStatus, endpointTaken, omissionAuthorities, recordApplicabilityDecision
} from '../src/evidence/applicability.mjs';
import { evaluateEvidence } from '../src/evidence/evaluate.mjs';
import { evidenceGraph } from '../src/evidence/graph.mjs';
import { COMPLETION_LABELS } from '../src/evidence/labels.mjs';
import { terminalRefusalMessage } from '../src/evidence/terminal.mjs';

const W = 'POC-1';
const REASON = 'This Story demonstrates the lifecycle on one local change and has no requirements.';
const omitScope = { responsibility: 'scope', reason: 'Lifecycle demonstrations define no requirement clauses.', authority: 'quality-reviewers' };
const human = { mode: 'required', minimum: 1, authorities: ['quality-reviewers'], requiredAuthorities: [] };
const none = { mode: 'none' };
const approvals = [{ decision: 'approved', actor: { login: 'qa' }, authorityGroup: 'quality-reviewers', at: '2026-10-02T00:00:00Z' }];

function pocStory({ finalize = 'approved', status = 'in_progress', applicability = undefined, endpoints = undefined, decisionLog = undefined } = {}) {
  return {
    workItem: { id: W, title: 'Lifecycle demonstration' },
    status,
    currentPhase: status === 'closed' ? null : 'finalize',
    phaseOrder: ['plan', 'act', 'verify', 'finalize'],
    ...(applicability ? { applicability } : {}),
    ...(decisionLog ? { decisionLog } : {}),
    resolution: {
      plannedClaims: { mode: 'omitted', clausePhases: [], owners: {} },
      obligationGraph: {
        nodes: [
          { id: 'plan', responsibilities: ['plan'] },
          { id: 'act', responsibilities: ['implement', 'verify'] },
          { id: 'verify', responsibilities: ['verify'] },
          { id: 'finalize', responsibilities: ['review'] }
        ],
        endpoints: endpoints ?? [{
          from: 'finalize', decision: null, route: null,
          guaranteed: ['plan', 'implement', 'verify', 'review'], missing: ['scope'], omits: [omitScope]
        }]
      }
    },
    phases: {
      plan: { id: 'plan', label: 'Plan', status: 'approved', generation: 1, approvalPolicy: none, approvals: [], requiredArtifact: { kind: 'delivery-plan' } },
      act: {
        id: 'act', label: 'Act', status: 'approved', generation: 1, approvalPolicy: none, approvals: [],
        generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'implementation-summary' }
      },
      verify: { id: 'verify', label: 'Verify', status: 'approved', generation: 1, approvalPolicy: none, approvals: [], requiredArtifact: { kind: 'test-evidence' } },
      finalize: {
        id: 'finalize', label: 'Finalize', status: finalize, generation: 1, approvalPolicy: human,
        approvals: finalize === 'approved' ? approvals : [], requiredArtifact: { kind: 'release-notes' }
      }
    }
  };
}

const delivery = {
  phaseId: 'act', generation: 1,
  receipt: { status: 'ready', traceability: { bindings: [] } },
  executions: [{ commandId: 'unit', kind: 'test-execution', status: 'passed', record: { status: 'passed', tests: { discovered: 1, passed: 1, failed: 0, skipped: 0 } } }]
};
const noRecords = { indexes: [], planned: [], observed: [] };
const evaluate = (workflow, extra = {}) => evaluateEvidence(
  evidenceGraph({ workflow, records: noRecords, deliveries: [delivery], ...extra }), { boundary: 'terminal', mode: 'decision' }
);
const decide = (workflow, extra = {}) => recordApplicabilityDecision(workflow, {
  responsibility: 'scope', reason: REASON, actor: 'qa@example.test', authorityGroup: 'quality-reviewers', at: '2026-10-02T01:00:00Z', ...extra
});

test('the end a Story takes is the decision route that finished it, or else the natural end after its last step', () => {
  const omitImplement = { responsibility: 'implement', reason: 'The behaviour already exists, so nothing is built.', authority: 'product-approvers' };
  const endpoints = [
    { from: 'finalize', decision: null, route: null, omits: [] },
    { from: 'plan', decision: 'stop', route: 'finish', omits: [omitImplement] },
    { from: 'plan', decision: 'free', route: 'any-step:end', omits: [] }
  ];
  assert.equal(endpointTaken(pocStory({ endpoints })).from, 'finalize');
  assert.equal(endpointTaken(pocStory({ endpoints, decisionLog: [{ decision: 'stop', route: 'finish', kind: 'end' }] })).route, 'finish');
  // An ask that allows any step records the step route; the graph checks it as one any-step end.
  assert.equal(endpointTaken(pocStory({ endpoints, decisionLog: [{ decision: 'free', route: 'step', kind: 'end' }] })).route, 'any-step:end');
  // Rework that re-ran a decision and took another route leaves the earlier ending behind.
  assert.equal(endpointTaken(pocStory({ endpoints, decisionLog: [
    { decision: 'stop', route: 'finish', kind: 'end' }, { decision: 'stop', route: 'continue', kind: 'next' }
  ] })).from, 'finalize');
  assert.deepEqual(omissionAuthorities(pocStory({ endpoints }), 'implement'), ['product-approvers']);
  assert.deepEqual(omissionAuthorities(pocStory({ endpoints }), 'verify'), []);
});

test('only the group an omission names may decide it, with a real reason, and a later decision replaces the earlier', () => {
  const workflow = pocStory();
  assert.throws(() => decide(workflow, { responsibility: 'verify' }), (error) => error.code === 'APPLICABILITY_NOT_OMITTED');
  assert.throws(() => decide(workflow, { authorityGroup: 'engineering-reviewers' }),
    (error) => error.code === 'APPLICABILITY_AUTHORITY_REQUIRED' && /Only quality-reviewers may decide/.test(error.message));
  assert.throws(() => decide(workflow, { reason: 'n/a' }), (error) => error.code === 'APPLICABILITY_REASON_REQUIRED');
  assert.equal(workflow.applicability, undefined, 'a refused decision records nothing');
  assert.deepEqual(applicabilityStatus(workflow).map((entry) => [entry.responsibility, entry.satisfied]), [['scope', false]]);

  decide(workflow);
  decide(workflow, { reason: `${REASON} Confirmed again.`, at: '2026-10-02T02:00:00Z' });
  assert.equal(workflow.applicability.length, 2, 'both decisions stay on the record');
  assert.equal(workflow.applicability[0].withdrawnAt, '2026-10-02T02:00:00Z');
  const [status] = applicabilityStatus(workflow);
  assert.equal(status.satisfied, true);
  assert.equal(status.decision.reason, `${REASON} Confirmed again.`);
  assert.equal(status.declaredReason, omitScope.reason);
});

test('an omitted responsibility nobody decided blocks the final evaluation; once decided it is not applicable', () => {
  const undecided = evaluate(pocStory({ status: 'closed' }));
  const scope = undecided.rows.find((row) => row.id === 'story:scope');
  assert.equal(scope.result, 'pending');
  assert.equal(scope.obligations[0].id, 'OBL:POC-1:scope:story');
  assert.deepEqual(scope.actions.map((action) => action.kind), ['decide']);
  assert.match(scope.actions[0].command, /decision applicability --responsibility scope --reason/);
  assert.ok(undecided.findings.some((entry) => entry.code === 'APPLICABILITY_DECISION_REQUIRED' && /quality-reviewers/.test(entry.message)));
  assert.equal(undecided.decision.gate, 'block');
  assert.ok(!undecided.findings.some((entry) => entry.code === 'EVIDENCE_NO_CRITERIA'), 'an omitted scope is not a missing one');

  const workflow = pocStory({ status: 'closed' });
  decide(workflow);
  const decided = evaluate(workflow);
  assert.equal(decided.rows.find((row) => row.id === 'story:scope').result, 'not-applicable');
  assert.deepEqual(decided.rows.map((row) => [row.id, row.result]), [
    ['story:scope', 'not-applicable'], ['story:plan', 'satisfied'], ['story:implement', 'satisfied'],
    ['story:verify', 'satisfied'], ['story:review', 'satisfied']
  ]);
  assert.equal(decided.decision.gate, 'allow');
  assert.equal(decided.summary.assuranceFloor, 'module-observed');
  assert.notEqual(decided.inputSha256, undecided.inputSha256, 'the decision is part of what the evaluation was made over');
});

test('a Story without clauses still owes its route: unreviewed or untested work is not complete', () => {
  const unapproved = evaluate(pocStory({ finalize: 'awaiting_approval', applicability: [] }));
  assert.equal(unapproved.rows.find((row) => row.id === 'story:review').result, 'pending');
  assert.equal(unapproved.decision.gate, 'block');

  const workflow = pocStory({ status: 'closed' });
  decide(workflow);
  const failed = evaluateEvidence(evidenceGraph({
    workflow, records: noRecords,
    deliveries: [{ ...delivery, executions: [{ commandId: 'unit', kind: 'test-execution', status: 'failed', record: { status: 'failed', tests: { discovered: 1, passed: 0, failed: 1, skipped: 0 } } }] }]
  }), { boundary: 'terminal', mode: 'decision' });
  assert.equal(failed.rows.find((row) => row.id === 'story:verify').result, 'failed');
  assert.ok(failed.findings.some((entry) => entry.code === 'EVIDENCE_TEST_FAILED'));
  assert.equal(failed.decision.gate, 'block');
});

test('the recorded final evaluation labels a Story only while it still matches the evidence', () => {
  const workflow = pocStory({ status: 'closed' });
  decide(workflow);
  const first = evaluate(workflow);
  workflow.completion = {
    label: COMPLETION_LABELS.complete, kind: 'complete', mode: 'decision', boundary: 'terminal', decision: { gate: 'allow' },
    inputSha256: first.inputSha256, assuranceFloor: 'module-observed', evaluatedAt: '2026-10-02T03:00:00Z'
  };
  const view = evaluateEvidence(evidenceGraph({ workflow, records: noRecords, deliveries: [delivery] }));
  assert.equal(view.completion.label, COMPLETION_LABELS.complete);

  // Withdrawing the decision changes the inputs, so the stored evaluation no longer speaks for them.
  workflow.applicability[0].withdrawnAt = '2026-10-02T04:00:00Z';
  const stale = evaluateEvidence(evidenceGraph({ workflow, records: noRecords, deliveries: [delivery] }));
  assert.equal(stale.completion.label, COMPLETION_LABELS.notEvaluated);
});

test('completion reads the record the ending transition made, and a refusal says what to do', () => {
  assert.equal(recordedCompletion({ status: 'in_progress', completion: { evaluatedAt: 'x' } }), null);
  assert.equal(recordedCompletion({ status: 'closed' }), null, 'an ending without the evaluation is never reported as passed');
  const verdict = recordedCompletion({
    status: 'closed',
    completion: { label: COMPLETION_LABELS.completeWithExceptions, kind: 'complete-with-exceptions', assuranceFloor: 'module-observed', evaluatedAt: '2026-10-02T03:00:00Z' }
  });
  assert.equal(verdict.verified, true);
  assert.equal(verdict.label, COMPLETION_LABELS.completeWithExceptions);
  const lines = [];
  printCompletionVerdict(verdict, { write: (line) => lines.push(line), warn: (line) => lines.push(line) });
  assert.equal(lines[0], 'Final governance check passed: Complete with accepted exceptions.');

  const message = terminalRefusalMessage('POC-1', {
    blockers: Array.from({ length: 22 }, (_, index) => `open obligation ${index + 1}`),
    recovery: ['singularity-flow decision applicability --responsibility scope --reason "<why it does not apply>"']
  });
  assert.match(message, /^Story POC-1 cannot finish yet: its final evaluation found 22 open obligations\./);
  assert.match(message, /- open obligation 20\n- …and 2 more\nNothing was recorded; the Story stays where it was\.\nRecover:\n  singularity-flow decision applicability/);
  assert.match(terminalRefusalMessage('POC-1', { blockers: ['one'], recovery: [] }), /found an open obligation\.\n- one\nNothing was recorded/);
});
