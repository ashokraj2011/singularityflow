import test from 'node:test';
import assert from 'node:assert/strict';

import { phasePreparationCommandLines } from '../src/phase-preparation-guidance.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';

test('custom document phases keep their shell id and use the generic Copilot phase skill', () => {
  const phase = { id: 'poc-impact-analysis', generationPolicy: { task: 'analyze' } };
  assert.deepEqual(phasePreparationCommandLines(phase), [
    'Run:',
    'Copilot: /sf-phase',
    'Shell: singularity-flow prepare poc-impact-analysis',
    'VS Code (model-free): not available for this action'
  ]);
});

test('custom code phases keep their shell id and use the policy-selected Copilot code skill', () => {
  const phase = { id: 'poc-test-generation', generationPolicy: { task: 'code' } };
  assert.deepEqual(phasePreparationCommandLines(phase, 'Next'), [
    'Next:',
    'Copilot: /sf-code',
    'Shell: singularity-flow prepare poc-test-generation',
    'VS Code (model-free): not available for this action'
  ]);
});

test('deterministic preparation may hand off prepublish to its actual publication skill', () => {
  const route = safeCommandGuidance({ command: 'singularity-flow phase prepublish custom-close --for-agent --json',
    skill: '/sf-publish', copilotCommand: '/sf-publish custom-close' });
  assert.equal(route.copilotCommand, '/sf-publish custom-close');
  assert.equal(route.skill, '/sf-publish');
  assert.equal(safeCommandGuidance({ command: route.command, skill: '/sf-approve' }), null,
    'a registered read must not manufacture approval authority');
});
