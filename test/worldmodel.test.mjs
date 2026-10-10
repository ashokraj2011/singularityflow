import test from 'node:test';
import assert from 'node:assert/strict';
import { phasePromptExecutionContract } from '../src/worldmodel.mjs';

test('phase prompts bind deterministic convergence to its exact publication and clarification contract', () => {
  const phase = {
    id: 'convergence',
    generationPolicy: {
      requirement: 'required',
      defaultProducer: 'deterministic',
      allowedProducers: ['deterministic'],
      producer: 'deterministic',
      task: 'analyze'
    }
  };
  const workflow = {
    resolution: {
      phases: [{ id: 'convergence', clarification: { mode: 'off' } }]
    }
  };
  const definition = {
    phases: { convergence: { generation: phase.generationPolicy, clarification: { mode: 'required' } } }
  };

  const contract = phasePromptExecutionContract(definition, workflow, phase);
  assert.equal(contract.deterministicOnly, true);
  assert.deepEqual(contract.publication, {
    producer: 'deterministic',
    channel: 'kernel-generator',
    allowedProducers: ['deterministic'],
    command: 'singularity-flow phase publish convergence --authored deterministic --channel kernel-generator'
  });
  assert.equal(contract.clarification.mode, 'off');
  assert.equal(
    contract.command,
    'singularity-flow phase publish convergence --authored deterministic --channel kernel-generator'
  );
  const rendered = contract.lines.join('\n');
  assert.match(rendered, /Default publication producer: `deterministic`/);
  assert.match(rendered, /Allowed publication producers: `deterministic`/);
  assert.match(rendered, /Required publication channel: `kernel-generator`/);
  assert.match(rendered, /Clarification mode: `off`; do not ask phase clarification questions/);
  assert.match(rendered, /pinned mode overrides generic skill, agent, and template guidance/);
  assert.match(rendered, /Exact publication command: `singularity-flow phase publish convergence --authored deterministic --channel kernel-generator`/);
  assert.match(rendered, /do not author or edit the phase artifact with a model, governed agent, or human/i);
});

test('evidence-planning instructions follow ownership for custom agents/phases, not a built-in planner name', () => {
  const phase = { id: 'team-solution', generationPolicy: { requirement: 'required', producer: 'governed-agent', allowedProducers: ['governed-agent'] } };
  const workflow = { phases: { 'team-solution': phase }, resolution: { phases: [], plannedClaims: { owners: { 'team-build': phase.id } } } };
  assert.match(phasePromptExecutionContract({ phases: {} }, workflow, phase).lines.join('\n'), /Fulfillment `evidence`/u);
  assert.match(phasePromptExecutionContract({ phases: {} }, workflow, phase).lines.join('\n'), /actual `## Verification contracts` table/u);
  workflow.resolution.plannedClaims.owners = {};
  assert.doesNotMatch(phasePromptExecutionContract({ phases: {} }, workflow, phase).lines.join('\n'), /Evidence planning/u);
});
