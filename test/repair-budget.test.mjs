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

// A person may grant one more rework round past a spent budget, as decision rounds allow [owner, 2026-11-20, decision 3]: the
// refusal names their return with --beyond-budget, and the round is recorded as beyond the budget.
test('a person grants one more rework round past a spent budget, recorded as beyond it', async () => {
  const { refusalRemediationPlan } = await import('../src/refusal-remediation.mjs');
  const workflow = { workItem: { id: 'W-1' }, phaseOrder: ['impl', 'test'], phases: { impl: { generation: 1 } }, repairBudgets: {} };
  const phase = { id: 'impl', repairBudget: { maxAttempts: 1, resetOnPhase: null } };
  const sourcePhase = { id: 'test', status: 'awaiting_approval' };
  const attempt = (changeRequestId, extra = {}) => consumeRepairAttempt(workflow, phase, { targetPhase: 'impl', actor: {}, at: '2026-11-20T00:00:00.000Z', changeRequestId, sourcePhase, ...extra });
  attempt('CR-1');
  let refused;
  try { attempt('CR-2'); } catch (error) { refused = error; }
  assert.equal(refused?.code, 'REPAIR_BUDGET_EXHAUSTED');
  const grant = 'singularity-flow reject test --work-id W-1 --to impl --reason "<why one more round>" --beyond-budget';
  assert.equal(refused.details.oneMoreRound, grant);
  const plan = refusalRemediationPlan(refused, ['reject', 'test', '--work-id', 'W-1', '--to', 'impl', '--reason', 'Again.']);
  assert.deepEqual(plan.steps.slice(0, 2).map((entry) => [entry.id, entry.command, entry.changes ?? null]), [
    ['grant-one-more-round', grant, 'a person grants one more round past the budget (--beyond-budget)'],
    ['approve-as-it-stands', 'singularity-flow approve test --work-id W-1', null]]);
  assert.deepEqual(attempt('CR-2', { beyondBudget: true }).attempts.map((entry) => entry.beyondBudget ?? false), [false, true]);
  assert.throws(() => attempt('CR-3'), (error) => error.code === 'REPAIR_BUDGET_EXHAUSTED', 'each further round needs its own grant');
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

// An upstream issue's return usually comes from a step still in progress, where reject is refused, yet
// the exhausted budget named that reject as the way out (2026-10-28).
test('an exhausted budget names the reset return only from a submitted step', () => {
  const workflow = {
    workItem: { id: 'BUDGET-1' }, phaseOrder: ['intake', 'implementation', 'testing'],
    phases: {
      intake: { id: 'intake', generation: 1 },
      implementation: { id: 'implementation', repairBudget: { maxAttempts: 1, resetOnPhase: 'intake' } },
      testing: { id: 'testing', status: 'in_progress', approvalPolicy: { rejectTo: ['intake', 'implementation'] } }
    }
  };
  const phase = workflow.phases.implementation;
  const sourcePhase = workflow.phases.testing;
  consumeRepairAttempt(workflow, phase, { targetPhase: 'implementation', sourcePhase, actor: 'reviewer', at: '2026-10-28T00:00:00.000Z', changeRequestId: 'CR-001' });
  const refusal = (status) => {
    sourcePhase.status = status;
    try { consumeRepairAttempt(workflow, phase, { targetPhase: 'implementation', sourcePhase, actor: 'reviewer', at: '2026-10-28T01:00:00.000Z', changeRequestId: 'CR-002' }); }
    catch (error) { return error; }
    assert.fail('the budget is exhausted');
  };
  const inProgress = refusal('in_progress');
  assert.equal(inProgress.details.resetCommand, null);
  assert.match(inProgress.message, /Once 'testing' is submitted, its approvers may return it to 'intake'/u);
  assert.match(refusal('awaiting_approval').details.resetCommand, /^singularity-flow reject testing --work-id BUDGET-1 --to intake/u);
});
