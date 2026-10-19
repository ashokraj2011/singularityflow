import assert from 'node:assert/strict';
import test from 'node:test';

import { refusalDetails, refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { SingularityFlowError } from '../src/util.mjs';

const renewal = 'singularity-flow decision test-risk implementation --command unit --work-id ENG-7 --reason "Database still unavailable" --expires 2026-11-01';

function lapsed(code) {
  return new SingularityFlowError('The accepted test-run risk for implementation lapsed.', {
    code, details: { workId: 'ENG-7', phase: 'verification', nextAction: { command: renewal }, recoveryCommands: [renewal] }
  });
}

test('an approval turn names the lapsed test-run risk renewal first, before the approval-turn boundary', () => {
  const plan = refusalRemediationPlan(lapsed('PHASE_VALIDATION_FAILED'), ['approve', 'verification', '--work-id', 'ENG-7']);
  assert.equal(plan.steps[0].id, 'renew-test-run-risk');
  assert.equal(plan.steps[0].command, renewal);
  assert.ok(plan.steps.some((entry) => entry.id === 'leave-approval-turn'), 'the approval-only boundary still holds');
});

test('a renewal is kept even when the plan is longer than its usual three steps', () => {
  const plan = refusalRemediationPlan(lapsed('PRIOR_CODE_TEST_EVIDENCE_REQUIRED'), ['submit', 'verification', '--work-id', 'ENG-7']);
  assert.ok(plan.steps.some((entry) => entry.id === 'renew-test-run-risk' && entry.command === renewal));
});

test('JSON refusal details carry the producer\'s safe next command, and drop an unsafe one', () => {
  assert.equal(refusalDetails({ nextAction: { command: renewal } }).nextAction, renewal);
  assert.equal(refusalDetails({ nextAction: 'rm -rf build' })?.nextAction, undefined);
});
