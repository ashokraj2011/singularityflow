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
  assert.equal(actions[0].command, 'singularity-flow prepare design', 'the draft is prepared first, then published');
  // The in-place route is the one prepublish offers for the prepared draft; importing is the alternative.
  const publications = actions.filter((item) => item.command.startsWith('singularity-flow phase publish'));
  assert.deepEqual(publications.map((item) => [item.timing, item.command]), [
    ['then', 'singularity-flow phase publish design --authored human --channel manual-in-place --no-model'],
    ['alternative', 'singularity-flow phase publish design --authored human --channel manual-import --from <FILE> --no-model']
  ]);
  assert.ok(publications.every((item) => item.modelPolicy === 'never'));
  assert.equal(actions.some((item) => /governed-agent|copilot-host/.test(item.command)), false);
});

test('a planner called without a model mode follows the run\'s own mode, never assuming a model', async () => {
  const { withOperationContext } = await import('../src/operation-context.mjs');
  const state = workflow(['governed-agent', 'human']);
  const offModel = await withOperationContext({ operation: { id: 'nextsteps', modelPolicy: 'never' },
    modelMode: { enabled: false } }, async () => workflowNextSteps(state));
  assert.equal(offModel.some((item) => /--authored governed-agent/.test(item.command)), false);
  assert.ok(offModel.some((item) => item.command === 'singularity-flow phase publish design --authored human --channel manual-in-place --no-model'));
  assert.ok(workflowNextSteps(state).some((item) => /--authored governed-agent --channel copilot-host$/.test(item.command)),
    'outside an operation the configured producer is still named');
});

test('nextsteps explains a model-only generation block instead of returning no actions', () => {
  const actions = workflowNextSteps(workflow(['governed-agent']), { modelMode: { enabled: false } });
  assert.ok(actions.length);
  assert.equal(actions[0].availability, 'blocked');
  assert.match(actions[0].reason, /no configured model-free producer/);
});

test('nextsteps gives deterministic phases their exact model-free publication command', () => {
  const state = workflow(['deterministic']);
  state.phases.design.generationPolicy.defaultProducer = 'deterministic';
  const actions = workflowNextSteps(state, { modelMode: { enabled: false } });
  const publication = actions.find((item) => item.command.startsWith('singularity-flow phase publish'));
  assert.equal(publication.command,
    'singularity-flow phase publish design --authored deterministic --channel kernel-generator --no-model');
  assert.equal(actions.some((item) => item.command.includes('--authored human')), false);
});

test('a deterministic convergence policy routes through projection preparation', () => {
  const state = workflow(['deterministic']);
  state.currentPhase = 'convergence';
  state.phaseOrder = ['convergence'];
  state.phases = {
    convergence: {
      id: 'convergence', label: 'Convergence', status: 'in_progress', generation: 0,
      requiredArtifact: { path: 'artifacts/convergence/convergence.md', kind: 'convergence-report' },
      generationPolicy: {
        requirement: 'required', defaultProducer: 'deterministic',
        allowedProducers: ['deterministic']
      }
    }
  };
  state.resolution.phases = [{ id: 'convergence', inputs: [] }];
  const actions = workflowNextSteps(state, { modelMode: { enabled: false } });
  assert.equal(actions[0].skill, '/sf-converge');
  assert.equal(actions[0].command, 'singularity-flow prepare convergence --no-model');
  assert.equal(actions.some((item) => item.command.startsWith('singularity-flow phase publish')), false);
  assert.equal(actions.some((item) => /singularity-flow (?:submit|approve) convergence/.test(item.command)), false);
  assert.equal(actions.some((item) => item.availability === 'blocked'), false);
});
