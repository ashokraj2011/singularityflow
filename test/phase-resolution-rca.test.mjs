import assert from 'node:assert/strict';
import test from 'node:test';
import { phaseResolutionChoices } from '../src/phase-resolution.mjs';

test('coverage risk guidance exposes the registered Copilot route in any custom code phase', () => {
  const workflow = { workItem: { id: 'CUSTOM-1' }, resolution: { qualityGateMode: 'soft' } };
  const phase = { id: 'ship-feature', generationPolicy: { task: 'code' }, status: 'in_progress' };
  const finding = { code: 'code.delivery.incomplete', details: {
    sourceCode: 'SPEC_COVERAGE_INCOMPLETE', qualityRisk: { eligible: true }, coverage: { unimplemented: ['CUSTOM-1:AC-001'] }
  } };
  const result = phaseResolutionChoices(workflow, phase, finding);
  const risk = result.choices[0];
  assert.equal(risk.kind, 'pilot-risk-review');
  assert.equal(risk.automatic, false);
  assert.equal(risk.commandGuidance?.skill, '/sf-appeal');
  assert.match(risk.copilotCommand ?? '', /^\/sf-appeal/);
  assert.match(risk.detail, /soft mode alone is no waiver/);
  assert.match(result.choices[1].copilotCommand, /^\/sf-recover/);
  const integrity = phaseResolutionChoices(workflow, phase, { code: 'SPECIFICATION_CLAIM_MAP_BINDING_STALE' });
  assert.equal(integrity.choices.some(choice => choice.kind === 'pilot-risk-review'), false);
});
