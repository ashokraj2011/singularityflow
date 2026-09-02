import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';

import { resolveWorkType, validateDefinition } from '../src/config.mjs';
import { workflowGuide } from '../src/guide.mjs';
import {
  assertProducerAllowed, normalizeAuthorshipOptions, phasePublicationContract
} from '../src/manual-authorship.mjs';
import { workflowNextSteps } from '../src/nextsteps.mjs';
import { sequenceGuidance } from '../src/sequence.mjs';

function runtimeWorkflow(workTypeId, phaseDefinition) {
  const phase = {
    ...structuredClone(phaseDefinition),
    generationPolicy: structuredClone(phaseDefinition.generation),
    approvalPolicy: structuredClone(phaseDefinition.approval),
    requiredArtifact: structuredClone(phaseDefinition.artifact),
    generation: 0,
    status: 'in_progress'
  };
  return {
    workItem: { id: 'GUIDANCE-1', workType: workTypeId, workTypeLabel: workTypeId },
    status: 'in_progress',
    currentPhase: phase.id,
    phaseOrder: [phase.id],
    phases: { [phase.id]: phase },
    resolution: { phases: [structuredClone(phaseDefinition)] },
    history: []
  };
}

function assertValidPublicationAction(action, phase, label) {
  const match = String(action.command).match(
    /^singularity-flow phase publish \S+ --authored (\S+) --channel (\S+)$/
  );
  assert.ok(match, `${label} emitted a malformed publication command: ${action.command}`);
  const [, producer, channel] = match;
  assert.doesNotThrow(() => assertProducerAllowed(phase, producer), `${label} emitted a forbidden producer`);
  assert.doesNotThrow(
    () => normalizeAuthorshipOptions({ producer, channel }),
    `${label} emitted an incompatible producer/channel pair`
  );
}

test('every shipped and example workflow routes publication through its phase contract', async () => {
  const definitions = [
    ['starter', new URL('../templates/workflow.yml', import.meta.url)],
    ['quality-example', new URL('../examples/workflow-with-quality-gates.yml', import.meta.url)]
  ];
  let checked = 0;

  for (const [catalog, url] of definitions) {
    const definition = YAML.parse(await readFile(url, 'utf8'));
    validateDefinition(definition);
    for (const workTypeId of Object.keys(definition.workTypes).sort()) {
      for (const resolvedPhase of resolveWorkType(definition, workTypeId).phases) {
        const workflow = runtimeWorkflow(workTypeId, resolvedPhase);
        const phase = workflow.phases[resolvedPhase.id];
        if (phase.generationPolicy.requirement === 'none') continue;
        checked += 1;
        const label = `${catalog}:${workTypeId}/${phase.id}`;
        const contract = phasePublicationContract(phase);

        const sequence = sequenceGuidance(workflow).actions;
        if (phase.id === 'convergence' && contract.producer === 'deterministic') {
          assert.equal(sequence.length, 1, `${label} offered publication before convergence projection`);
        } else assert.equal(sequence[1].command, contract.command, `${label} sequence drifted`);
        const nextActions = workflowNextSteps(workflow).filter((entry) =>
          entry.command.startsWith('singularity-flow phase publish ')
        );
        if (phase.id === 'convergence' && contract.producer === 'deterministic') {
          assert.equal(nextActions.length, 0, `${label} offered publication before convergence projection`);
          assert.equal(workflowNextSteps(workflow).some((entry) => /singularity-flow (?:submit|approve) convergence/.test(entry.command)), false,
            `${label} skipped the projection's required intermediate human branch`);
        } else assert.ok(nextActions.length > 0, `${label} omitted its publication action`);
        for (const action of nextActions) assertValidPublicationAction(action, phase, label);

        assert.equal(workflowGuide(workflow).nextActions[0].command, `singularity-flow prepare ${phase.id}`);
        if (contract.producer === 'deterministic') {
          assert.equal(contract.channel, 'kernel-generator', `${label} deterministic output escaped the kernel`);
          assert.ok(nextActions.every((entry) => !entry.command.includes('--authored human')),
            `${label} offered human publication for a deterministic phase`);
        }
      }
    }
  }

  assert.ok(checked >= 50, `workflow inventory unexpectedly shrank to ${checked} generated phases`);
});

test('every published convergence route stops at explicit human advancement', async () => {
  const definition = YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
  const resolved = resolveWorkType(definition, 'spec-driven-standard');
  const convergence = resolved.phases.find((phase) => phase.id === 'convergence');
  const workflow = runtimeWorkflow('spec-driven-standard', convergence);
  workflow.phases.convergence.generation = 1;

  const surfaces = {
    guide: workflowGuide(workflow).nextActions,
    sequence: sequenceGuidance(workflow).actions,
    nextsteps: workflowNextSteps(workflow)
  };
  for (const [surface, actions] of Object.entries(surfaces)) {
    assert.ok(actions.some((entry) => entry.command === 'singularity-flow story advance --work-id GUIDANCE-1'),
      `${surface} omitted the explicit convergence review boundary`);
    assert.equal(actions.some((entry) => entry.command === 'singularity-flow submit convergence'), false,
      `${surface} still offered the generic convergence submission dead end`);
  }
});
