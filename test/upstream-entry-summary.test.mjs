import assert from 'node:assert/strict';
import test from 'node:test';

import { endsStory, upstreamEntrySummary } from '../src/upstream-entry-summary.mjs';
import { owedDecisionLines, stepsHolding, stepsThrough, witnessingSteps } from '../src/owed-decisions.mjs';

function story(overrides = {}) {
  return { workItem: { id: 'ENTRY-1' }, status: 'in_progress', currentPhase: 'build', phaseOrder: ['plan', 'build', 'check'],
    resolution: { phases: [{ id: 'build', inputs: ['plan'] }, { id: 'check', inputs: ['plan', 'build'] }] },
    phases: { plan: { id: 'plan', status: 'approved', generation: 1 }, build: { id: 'build', status: 'in_progress', generation: 1 },
      check: { id: 'check', status: 'not_started', generation: 0 } }, ...overrides };
}

test('entry names what earlier steps left open, with the command each owner runs', async () => {
  const workflow = story({
    upstreamIssues: [{ id: 'UPI-001', phase: 'plan', about: 'AC-002', problem: 'The plan has no row for AC-002 at all.' }],
    forwardAmendments: [{ id: 'FAM-001', phase: 'plan' }]
  });
  const calls = [];
  const summary = await upstreamEntrySummary('/unused', {}, workflow, workflow.phases.build,
    { evaluateTerminalReadiness: async () => { calls.push('evaluated'); return { blockers: [], recovery: [] }; } });
  assert.equal(summary.attention, true);
  assert.deepEqual(summary.inputs, [{ phase: 'plan', status: 'approved', generation: 1 }]);
  assert.match(summary.openIssues[0].decide, /^singularity-flow upstream-issue decide UPI-001 --work-id ENTRY-1 /u);
  assert.deepEqual(summary.amendments.map((entry) => entry.code), ['FORWARD_AMENDMENT_PENDING']);
  assert.equal(summary.finalGate, null, 'a middle step gets no final-gate preview');
  assert.deepEqual(calls, []);
  assert.match(summary.instruction, /never edit an earlier step/u);
  const quiet = await upstreamEntrySummary('/unused', {}, story(), story().phases.build);
  assert.equal(quiet.attention, false);
});

test('the closing step previews the final evaluation, advisory and never fatal', async () => {
  const workflow = story({ currentPhase: 'check' });
  workflow.phases.build = { ...workflow.phases.build, status: 'approved' };
  workflow.phases.check = { ...workflow.phases.check, status: 'in_progress', generation: 1 };
  assert.equal(endsStory(workflow, workflow.phases.check), true);
  assert.equal(endsStory(workflow, workflow.phases.build), false);
  const blocked = await upstreamEntrySummary('/unused', {}, workflow, workflow.phases.check, {
    evaluateTerminalReadiness: async (_root, _definition, _workflow, options) => {
      assert.equal(options.stage, 'submission');
      return { blockers: Array.from({ length: 10 }, (_, index) => `open ${index}`), recovery: ['singularity-flow gate --terminal'],
        gate: { findings: [{ phase: 'plan' }, { phase: 'plan' }, { phase: null }] } };
    }
  });
  assert.deepEqual({ ...blocked.finalGate, blockers: blocked.finalGate.blockers.length },
    { advisory: true, status: 'blocked', blockers: 8, more: 2, owners: ['plan'], recovery: ['singularity-flow gate --terminal'] });
  assert.equal(blocked.attention, true);
  const failed = await upstreamEntrySummary('/unused', {}, workflow, workflow.phases.check, {
    evaluateTerminalReadiness: async () => { const error = new Error('x'); error.code = 'GATE_BROKEN'; throw error; }
  });
  assert.deepEqual(failed.finalGate, { advisory: true, status: 'unavailable', reason: 'GATE_BROKEN' });
  // A later step that was skipped does not stop this one from closing the Story.
  workflow.phaseOrder.push('extra');
  workflow.phases.extra = { id: 'extra', status: 'skipped', generation: 0 };
  assert.equal(endsStory(workflow, workflow.phases.check), true);
});

test('a later step is told which sign-offs and scope decisions earlier steps still owe, with each command', async () => {
  const workflow = story({ currentPhase: 'check' });
  workflow.phases.build = { ...workflow.phases.build, status: 'approved' };
  workflow.phases.check = { ...workflow.phases.check, status: 'in_progress', generation: 1 };
  workflow.resolution.obligationGraph = { nodes: [{ id: 'plan', responsibilities: ['scope', 'plan'] },
    { id: 'build', responsibilities: ['implement', 'verify'] }, { id: 'check', responsibilities: ['review'] }] };
  assert.deepEqual(stepsThrough(workflow, 'check', { inclusive: false }), ['plan', 'build']);
  assert.deepEqual(witnessingSteps(workflow, ['plan', 'build', 'check']), ['build']);
  assert.deepEqual(stepsHolding(workflow, ['plan', 'build', 'check'], ['scope']), ['plan']);
  const owed = { advisory: true, status: 'owed', more: { witnesses: 0, scopeItems: 2 },
    scopeItems: [{ id: 'SRI-abc', source: 'story:4', text: 'The keypad must accept decimals.', humanRequired: true,
      command: 'singularity-flow decision scope ENTRY-1 --item SRI-abc --as <included|existing|excluded|deferred|informative|duplicate|superseded> --reason "<why>"' }],
    witnesses: [{ clauseId: 'ENTRY-1:AC-001', slot: 'screen', method: 'visual',
    status: 'missing', files: ['evidence/screen.png'], owners: ['build'], humanRequired: true,
    command: 'singularity-flow decision witness --work-id ENTRY-1 --criterion ENTRY-1:AC-001 --slot screen --file evidence/screen.png' }] };
  const asked = [];
  const summary = await upstreamEntrySummary('/unused', {}, workflow, workflow.phases.check, {
    evaluateTerminalReadiness: async () => ({ blockers: [], recovery: [], gate: { findings: [] } }),
    owedDecisions: async (_root, _definition, _workflow, phaseIds) => { asked.push(phaseIds); return owed; }
  });
  assert.deepEqual(asked, [['plan', 'build']], 'only earlier steps are asked; this step owes nothing yet');
  assert.equal(summary.owedDecisions, owed);
  assert.equal(summary.finalGate.status, 'ready', 'the submission preview defers witnesses, so the list is the only place they show');
  assert.equal(summary.attention, true);
  const lines = owedDecisionLines(owed);
  assert.match(lines[0], /^Owed sign-offs \(1, human only, not blocking this step\):/u);
  assert.match(lines[1], /ENTRY-1:AC-001 screen \(visual: evidence\/screen\.png\) — inspect it first/u);
  assert.equal(lines[2].trim(), owed.witnesses[0].command);
  assert.equal(lines[3], 'Open scope items (3, human only, not blocking this step):');
  assert.equal(lines[4], '  SRI-abc story:4: "The keypad must accept decimals."');
  assert.equal(lines[5].trim(), owed.scopeItems[0].command);
  assert.match(lines[6], /…and 2 more: singularity-flow evidence scope/u);
  assert.deepEqual(owedDecisionLines(null), []);
  assert.match(owedDecisionLines({ status: 'unavailable', reason: 'evidence-untrusted' })[0], /unavailable \(evidence-untrusted\)/u);
});
