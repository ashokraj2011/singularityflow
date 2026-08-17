import assert from 'node:assert/strict';
import test from 'node:test';

import { consumeRepairAttempt } from '../src/repair-budget.mjs';

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
