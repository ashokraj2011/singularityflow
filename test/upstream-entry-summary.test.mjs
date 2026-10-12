import assert from 'node:assert/strict';
import test from 'node:test';

import { endsStory, upstreamEntrySummary } from '../src/upstream-entry-summary.mjs';

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
