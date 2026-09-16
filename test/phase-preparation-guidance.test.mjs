import test from 'node:test';
import assert from 'node:assert/strict';

import { phasePreparationCommandLines } from '../src/phase-preparation-guidance.mjs';

test('custom document phases keep their shell id and use the generic Copilot phase skill', () => {
  const phase = { id: 'poc-impact-analysis', generationPolicy: { task: 'analyze' } };
  assert.deepEqual(phasePreparationCommandLines(phase), [
    'Run:',
    'Shell: singularity-flow prepare poc-impact-analysis',
    'Copilot: /sf-phase'
  ]);
});

test('custom code phases keep their shell id and use the policy-selected Copilot code skill', () => {
  const phase = { id: 'poc-test-generation', generationPolicy: { task: 'code' } };
  assert.deepEqual(phasePreparationCommandLines(phase, 'Next'), [
    'Next:',
    'Shell: singularity-flow prepare poc-test-generation',
    'Copilot: /sf-code'
  ]);
});
