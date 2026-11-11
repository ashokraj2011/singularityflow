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
  // The author delivers the clause first; the pilot risk a person may accept follows (owner policy 2026-11-10).
  assert.equal(result.choices[0].kind, 'author-correction');
  assert.equal(result.choices[0].owner, 'ship-feature');
  const risk = result.choices[1];
  assert.equal(risk.kind, 'pilot-risk-review');
  assert.equal(risk.automatic, false);
  assert.equal(risk.commandGuidance?.skill, '/sf-appeal');
  assert.match(risk.copilotCommand ?? '', /^\/sf-appeal/);
  assert.match(risk.detail, /soft mode alone is no waiver/);
  assert.ok(result.choices.some(choice => /^\/sf-recover/.test(choice.copilotCommand ?? '')));
  const integrity = phaseResolutionChoices(workflow, phase, { code: 'SPECIFICATION_CLAIM_MAP_BINDING_STALE' });
  assert.equal(integrity.choices.some(choice => choice.kind === 'pilot-risk-review'), false);
});
