import assert from 'node:assert/strict';
import test from 'node:test';
import { modelFreedomSnapshot } from '../src/model-freedom.mjs';

function activeWorkflow(qualityCommands = [], allowedProducers = ['human']) {
  return {
    currentPhase: 'intake', phaseOrder: ['intake'],
    phases: { intake: { id: 'intake', qualityCommands, generationPolicy: { requirement: 'required', allowedProducers } } }
  };
}

test('doctor model-freedom reports unknown external commands as partial', () => {
  const report = modelFreedomSnapshot({ workflow: activeWorkflow(['legacy-validator']), definition: { noModel: { unknownExternalCommands: 'warn' } }, modelMode: { enabled: false } });
  assert.equal(report.currentWorkflow.status, 'partial');
  assert.equal(report.qualityCommands.unknown, 1);
  assert.equal(report.modelFreeLifecycleReady, true);
});

test('doctor model-freedom reports a model-only phase as blocked', () => {
  const report = modelFreedomSnapshot({ workflow: activeWorkflow([], ['governed-agent']), modelMode: { enabled: false } });
  assert.equal(report.currentWorkflow.status, 'blocked');
  assert.equal(report.modelFreeLifecycleReady, false);
});
