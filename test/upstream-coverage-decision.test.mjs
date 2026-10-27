/**
 * A code step's coverage gap that an open upstream issue names is that issue's approvers' to decide.
 * Every surface says so, so no route sends the coder back to /sf-code for it (office, 2026-10-27:
 * UPI-001 against planning named the clause, and /sf-code was told to run /sf-code again).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { agentAct } from '../src/agent-output.mjs';
import { approvalHoldOwner } from '../src/approval-check.mjs';
import { phaseFindingPolicy } from '../src/phase-finding-policy.mjs';
import { phaseResolutionChoices } from '../src/phase-resolution.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';

const decision = (complete) => ({ issues: [{ id: 'UPI-001', phase: 'planning', clauses: ['US-1:REQ-002'] }], complete });
const details = (complete, extra = {}) => ({ workId: 'US-1', phase: 'implementation', upstreamDecision: decision(complete),
  coverage: { unimplemented: complete ? ['US-1:REQ-002'] : ['US-1:REQ-001', 'US-1:REQ-002'] },
  diagnosticCommand: 'singularity-flow recover US-1 --phase implementation --json',
  ...(complete ? { nextAction: { command: 'singularity-flow decisions US-1 --json', skill: '/sf-decide', label: "planning's approvers decide UPI-001 in the decision list." } } : {}),
  ...extra });

test('the gap is never the producer\'s repair once every clause waits on an upstream decision', () => {
  const waiting = phaseFindingPolicy({ code: 'code.delivery.incomplete', details: { sourceCode: 'SPEC_COVERAGE_INCOMPLETE', ...details(true) } });
  assert.deepEqual([waiting.classification, waiting.repair, waiting.repairableByProducer], ['upstream-decision', 'decide-upstream-issue', false]);
  const own = phaseFindingPolicy({ code: 'code.delivery.incomplete', details: { sourceCode: 'SPEC_COVERAGE_INCOMPLETE', ...details(false) } });
  assert.equal(own.repairableByProducer, true, 'a clause no issue names is still the coder\'s to deliver');
});

test('prepublish, the refusal plan and the approval hold all route to the decision list', () => {
  const workflow = { workItem: { id: 'US-1' }, resolution: {} };
  const phase = { id: 'implementation', generationPolicy: { task: 'code' }, status: 'in_progress' };
  const choice = phaseResolutionChoices(workflow, phase, { code: 'code.delivery.incomplete', details: { sourceCode: 'SPEC_COVERAGE_INCOMPLETE', ...details(true) } }).choices[0];
  assert.equal(choice.kind, 'upstream-decision');
  assert.equal(choice.command, 'singularity-flow decisions US-1 --json');
  assert.match(choice.copilotCommand ?? '', /^\/sf-decide/u);
  assert.match(choice.detail, /More code from implementation cannot clear it/u);

  const plan = refusalRemediationPlan({ code: 'SPEC_COVERAGE_INCOMPLETE', message: 'incomplete', details: details(true) }, ['phase', 'publish', 'implementation']);
  assert.equal(plan.steps[0].id, 'open-decision-list');
  assert.equal(plan.steps[0].skill, '/sf-decide');
  assert.equal(plan.steps.some((entry) => entry.id === 'deliver-missing-clauses'), false, 'never more code for a clause that waits');
  const partial = refusalRemediationPlan({ code: 'SPEC_COVERAGE_INCOMPLETE', message: 'incomplete',
    details: details(false, { qualityRisk: { eligible: true } }) }, ['phase', 'publish', 'implementation']);
  assert.deepEqual(partial.steps.map((entry) => entry.id).slice(0, 3), ['deliver-missing-clauses', 'accept-quality-risk', 'inspect-coverage']);
  assert.match(partial.steps[0].label, /Leave US-1:REQ-002 to the open upstream issue's decision/u);

  assert.equal(approvalHoldOwner({ code: 'SPEC_COVERAGE_INCOMPLETE', details: details(true) }), 'someone-decides');
  assert.equal(approvalHoldOwner({ code: 'SPEC_COVERAGE_INCOMPLETE', details: details(false) }), 'author-repairs');
});

test('Copilot is told to ask the person with the decision list, never to correct or relay its own skill', () => {
  const result = { resultType: 'sflow-phase-prepublish', status: 'correction-required',
    findings: [{ code: 'code.delivery.incomplete', message: 'UPI-001 names US-1:REQ-002.', details: { sourceCode: 'SPEC_COVERAGE_INCOMPLETE', ...details(true) } }],
    correction: { class: 'phase-recovery', sameTurn: false, skill: '/sf-decide',
      guidance: "planning's approvers decide UPI-001 in the decision list. The clauses without delivery wait on it, not on implementation's code." },
    commands: { next: 'singularity-flow decisions US-1 --json', publish: null } };
  const act = agentAct(result);
  assert.equal(act.state, 'ask-person');
  assert.equal(act.do.shell, 'singularity-flow decisions US-1 --json');
  assert.match(act.do.copilot ?? '', /^\/sf-decide/u);
  assert.match(act.said, /never decide or record it for them/u);
  // Already published: the next step, not "fix the listed findings".
  const published = agentAct({ resultType: 'sflow-phase-prepublish', status: 'ready', findings: [],
    commands: { next: 'singularity-flow phase submit implementation --json', publish: null } });
  assert.equal(published.state, 'next');
  assert.equal(published.do.shell, 'singularity-flow phase submit implementation --json');
});
