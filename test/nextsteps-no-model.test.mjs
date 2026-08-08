import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowNextSteps } from '../src/nextsteps.mjs';

function workflow(allowedProducers) {
  return {
    workItem: { id: 'MODEL-FREE-1' }, currentPhase: 'design', phaseOrder: ['design'], status: 'in_progress',
    phases: { design: { id: 'design', label: 'Design', status: 'in_progress', generation: 0, generationPolicy: { requirement: 'required', allowedProducers } } },
    resolution: { phases: [{ id: 'design', inputs: [] }], inputsMode: 'off' }
  };
}

test('nextsteps offers a human publication route when model mode is disabled', () => {
  const actions = workflowNextSteps(workflow(['governed-agent', 'human']), { modelMode: { enabled: false } });
  assert.ok(actions.length);
  assert.match(actions[0].command, /--authored human/);
  assert.equal(actions[0].modelPolicy, 'never');
});

test('nextsteps explains a model-only generation block instead of returning no actions', () => {
  const actions = workflowNextSteps(workflow(['governed-agent']), { modelMode: { enabled: false } });
  assert.ok(actions.length);
  assert.equal(actions[0].availability, 'blocked');
  assert.match(actions[0].reason, /no configured model-free producer/);
});
