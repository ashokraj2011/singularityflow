import assert from 'node:assert/strict';
import test from 'node:test';

import { consumeRepairAttempt, normalizeReworkLoops, repairBudgetPhaseForRejection } from '../src/repair-budget.mjs';

test('declared rework loops are unique bounded backward edges with compatible target budgets', () => {
  const phases = ['specification', 'implementation', 'testing', 'conformance'];
  const options = { workTypeId: 'delivery', phases };
  assert.deepEqual(normalizeReworkLoops([
    { from: 'testing', to: 'implementation', maxAttempts: 3, resetOnPhase: 'specification' }
  ], options)[0], {
    from: 'testing', to: 'implementation', maxAttempts: 3, resetOnPhase: 'specification'
  });
  for (const invalid of [
    [{ from: 'implementation', to: 'testing', maxAttempts: 2 }],
    [{ from: 'testing', to: 'unknown', maxAttempts: 2 }],
    [{ from: 'testing', to: 'implementation', maxAttempts: 0 }],
    [{ from: 'testing', to: 'implementation', maxAttempts: 2, resetOnPhase: 'implementation' }],
    [{ from: 'testing', to: 'implementation', maxAttempts: 2, resetOnPhase: 'testing' }],
    [{ from: 'testing', to: 'implementation', maxAttempts: 2 },
      { from: 'testing', to: 'implementation', maxAttempts: 2 }],
    [{ from: 'testing', to: 'implementation', maxAttempts: 2 },
      { from: 'conformance', to: 'implementation', maxAttempts: 3 }]
  ]) assert.throws(() => normalizeReworkLoops(invalid, options));
});

test('an exact declared edge charges its target, not an unrelated later budget in the span', () => {
  const phases = {
    specification: { id: 'specification', repairBudget: { maxAttempts: 2, resetOnPhase: null } },
    implementation: { id: 'implementation', repairBudget: { maxAttempts: 3, resetOnPhase: 'specification' } },
    testing: { id: 'testing' }, conformance: { id: 'conformance' }
  };
  const workflow = {
    phaseOrder: Object.keys(phases), phases,
    resolution: { reworkLoops: [
      { from: 'testing', to: 'implementation', maxAttempts: 3, resetOnPhase: 'specification' },
      { from: 'conformance', to: 'specification', maxAttempts: 2 }
    ] }
  };
  assert.equal(repairBudgetPhaseForRejection(workflow, phases.testing, 'implementation'), phases.implementation);
  assert.equal(repairBudgetPhaseForRejection(workflow, phases.conformance, 'specification'), phases.specification);
  phases.specification.repairBudget.maxAttempts = 1;
  assert.throws(() => repairBudgetPhaseForRejection(workflow, phases.conformance, 'specification'), {
    code: 'REWORK_LOOP_POLICY_MISMATCH'
  });
});

test('repair budgets stop a third repair and reset only on a new intent generation', () => {
  const workflow = {
    phases: { 'poc-intake': { generation: 1 } },
    repairBudgets: {}
  };
  const phase = { id: 'poc-validation', repairBudget: { maxAttempts: 2, resetOnPhase: 'poc-intake' } };
  for (let number = 1; number <= 2; number += 1) {
    const state = consumeRepairAttempt(workflow, phase, {
      targetPhase: 'poc-test-generation', actor: { email: 'reviewer@example.test' },
      at: `2026-08-17T00:00:0${number}.000Z`, changeRequestId: `CR-00${number}`
    });
    assert.equal(state.attempts.length, number);
  }
  assert.throws(() => consumeRepairAttempt(workflow, phase, {
    targetPhase: 'poc-validation', actor: {}, at: '2026-08-17T00:00:03.000Z', changeRequestId: 'CR-003'
  }), (error) => error.code === 'REPAIR_BUDGET_EXHAUSTED');

  const intentReset = consumeRepairAttempt(workflow, phase, {
    targetPhase: 'poc-intake', actor: {}, at: '2026-08-17T00:00:03.500Z', changeRequestId: 'CR-RESET'
  });
  assert.equal(intentReset.resetRequested, true);
  assert.equal(intentReset.attempts.length, 2);

  workflow.phases['poc-intake'].generation = 2;
  const reset = consumeRepairAttempt(workflow, phase, {
    targetPhase: 'poc-test-generation', actor: {}, at: '2026-08-17T00:00:04.000Z', changeRequestId: 'CR-004'
  });
  assert.equal(reset.resetGeneration, 2);
  assert.equal(reset.attempts.length, 1);
});

test('repair budgets follow the reopened validation boundary without counting passing review edits', () => {
  const workflow = {
    phaseOrder: ['poc-intake', 'poc-test-generation', 'poc-validation', 'poc-publication-review'],
    phases: {
      'poc-intake': { id: 'poc-intake' },
      'poc-test-generation': { id: 'poc-test-generation' },
      'poc-validation': {
        id: 'poc-validation', validationVerdict: 'passed',
        repairBudget: { maxAttempts: 2, resetOnPhase: 'poc-intake' }
      },
      'poc-publication-review': { id: 'poc-publication-review' }
    }
  };
  assert.equal(repairBudgetPhaseForRejection(
    workflow, workflow.phases['poc-validation'], 'poc-validation'
  ), null, 'a passing validation review correction is not a failed-test repair');
  workflow.phases['poc-validation'].validationVerdict = 'failed';
  assert.equal(repairBudgetPhaseForRejection(
    workflow, workflow.phases['poc-validation'], 'poc-test-generation'
  )?.id, 'poc-validation');
  assert.equal(repairBudgetPhaseForRejection(
    workflow, workflow.phases['poc-publication-review'], 'poc-test-generation'
  )?.id, 'poc-validation', 'publication rejection cannot bypass the validation budget');
});
