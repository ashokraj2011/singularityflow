import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boundTestRunRiskActive, coveringTestRunRisk, noTestExecuted, recordTestRunRisk, recordTestRunRiskRevocation,
  testRunRiskBinding, testRunRiskCoverageProblem, testRunRiskIneligibility, testRunRiskRoute, testRunRiskState, testsExecuted
} from '../src/test-run-risk.mjs';

const AT = '2026-10-16T10:00:00.000Z';
const ARGV = 'a'.repeat(64);
const attempt = (extra = {}) => ({
  attemptId: 'TA-0123456789abcdef0123', commandId: 'module-tests', argvSha256: ARGV,
  status: 'failed', exitCode: 1, tests: null, ...extra
});
const story = () => ({ workItem: { id: 'ENV-1' }, testRunRisks: [] });
const accept = (workflow, extra = {}) => recordTestRunRisk(workflow, {
  phaseId: 'code', attempt: attempt(), cause: 'Maven cannot reach the company repository from this laptop',
  reason: 'The CI pipeline runs the same tests against the repository before merge.', expires: '2026-11-01',
  actor: 'dev@example.invalid', authorityGroup: 'code-approvers', at: AT, ...extra
});

test('a run counts as not executed only when it failed or was blocked and no test passed or failed', () => {
  assert.equal(testsExecuted(attempt()), 0);
  assert.equal(testsExecuted(attempt({ tests: { discovered: 4, passed: 1, failed: 2, skipped: 1 } })), 3);
  assert.equal(noTestExecuted(attempt()), true);
  assert.equal(noTestExecuted(attempt({ status: 'blocked', exitCode: null })), true);
  assert.equal(noTestExecuted(attempt({ tests: { discovered: 3, passed: 0, failed: 0, skipped: 3 } })), true,
    'skipped tests did not run');
  assert.equal(noTestExecuted(attempt({ tests: { discovered: 2, passed: 0, failed: 2, skipped: 0 } })), false,
    'tests that ran and failed are a real failure');
  assert.equal(noTestExecuted(attempt({ status: 'passed', exitCode: 0 })), false);
  assert.equal(noTestExecuted(attempt({ status: 'unavailable' })), false);
  assert.equal(noTestExecuted(null), false);
});

test('only a recorded run with no executed test can be accepted, with a cause, reason and bounded expiry', () => {
  assert.match(testRunRiskIneligibility(null), /no run of this command is recorded/u);
  assert.match(testRunRiskIneligibility(attempt({ status: 'passed', exitCode: 0 })), /passed/u);
  assert.match(testRunRiskIneligibility(attempt({ tests: { discovered: 1, passed: 0, failed: 1, skipped: 0 } })),
    /1 test\(s\) executed.*never accepted/u);
  assert.throws(() => recordTestRunRisk(story(), { phaseId: 'code', attempt: attempt({ tests: { discovered: 1, passed: 0, failed: 1, skipped: 0 } }),
    cause: 'x'.repeat(20), reason: 'y'.repeat(30), expires: '2026-11-01', actor: 'a', authorityGroup: 'g', at: AT }),
  { code: 'TEST_RUN_RISK_NOT_ELIGIBLE' });
  assert.throws(() => accept(story(), { cause: 'proxy' }), { code: 'TEST_RUN_RISK_INVALID' });
  assert.throws(() => accept(story(), { reason: 'fine' }), { code: 'TEST_RUN_RISK_INVALID' });
  assert.throws(() => accept(story(), { expires: '2026-10-15' }), /after today/u);
  assert.throws(() => accept(story(), { expires: '2027-03-01' }), /at most 90 days/u);
  const workflow = story();
  const decision = accept(workflow);
  assert.equal(decision.id, 'TRR-001');
  assert.deepEqual(decision.observation, { attemptId: 'TA-0123456789abcdef0123', status: 'failed', exitCode: 1, testsExecuted: 0 });
  assert.equal(decision.expiresAt, '2026-11-01T23:59:59.999Z');
  assert.equal(workflow.testRunRisks.length, 1);
});

test('a decision covers later runs of the same command in which no test executed, until it expires or is revoked', () => {
  const workflow = story();
  const decision = accept(workflow);
  const later = attempt({ attemptId: 'TA-ffffffffffffffffffff', status: 'blocked', exitCode: null });
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'code', attempt: later, at: AT })?.id, 'TRR-001');
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'review', attempt: later, at: AT }), null, 'another step');
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'code', attempt: { ...later, argvSha256: 'b'.repeat(64) }, at: AT }), null,
    'a changed command needs a new decision');
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'code',
    attempt: { ...later, status: 'failed', tests: { discovered: 2, passed: 1, failed: 1, skipped: 0 } }, at: AT }), null,
  'a run in which tests executed and failed is never covered');
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'code', attempt: later, at: '2026-11-02T00:00:00.000Z' }), null, 'expired');
  assert.equal(testRunRiskState(workflow, { phaseId: 'code', commandId: 'module-tests', argvSha256: ARGV },
    { at: '2026-11-02T00:00:00.000Z' }).state, 'expired');

  const binding = testRunRiskBinding(decision);
  assert.equal(boundTestRunRiskActive(workflow, binding, { at: AT }), true);
  assert.equal(boundTestRunRiskActive(workflow, { ...binding, sha256: `sha256:${'0'.repeat(64)}` }, { at: AT }), false,
    'a binding to other bytes is not this decision');
  assert.equal(testRunRiskCoverageProblem(workflow, binding, { phaseId: 'code', attempt: later, at: AT }), null);
  assert.match(testRunRiskCoverageProblem(workflow, binding, { phaseId: 'code', attempt: { ...later, commandId: 'other' }, at: AT }),
    /another step or command/u);

  recordTestRunRiskRevocation(workflow, { riskId: 'TRR-001', reason: 'The repository is reachable again from the office.',
    actor: 'lead@example.invalid', authorityGroup: 'code-approvers', at: AT });
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'code', attempt: later, at: AT }), null, 'revoked');
  assert.equal(boundTestRunRiskActive(workflow, binding, { at: AT }), false);
  assert.match(testRunRiskCoverageProblem(workflow, binding, { phaseId: 'code', attempt: later, at: AT }), /is revoked/u);
  assert.throws(() => recordTestRunRiskRevocation(workflow, { riskId: 'TRR-001', reason: 'x'.repeat(30), actor: 'a', authorityGroup: 'g', at: AT }),
    { code: 'TEST_RUN_RISK_REVOKED' });

  // A renewal on the same command carries the runs an earlier decision let through.
  const renewal = accept(workflow, { expires: '2026-11-10' });
  assert.equal(renewal.id, 'TRR-002');
  assert.equal(boundTestRunRiskActive(workflow, binding, { at: AT }), true,
    'the renewal now governs the command, so runs TRR-001 let through stay carried');
  assert.equal(boundTestRunRiskActive(workflow, testRunRiskBinding(renewal), { at: AT }), true);
});

test('a refused run in which no test executed names the environment and the approvers route; one that ran tests does not', () => {
  const workflow = story();
  const route = testRunRiskRoute(workflow, { phaseId: 'code', attempt: attempt(), at: AT });
  assert.equal(route.eligible, true);
  assert.match(route.command, /^singularity-flow decision test-risk ENV-1 --phase code --command module-tests --cause /u);
  assert.match(route.guidance, /No test executed in this run.*a person who approves code can accept the risk in their own terminal \(an agent cannot\)/u);
  assert.equal(testRunRiskRoute(workflow, { phaseId: 'code', attempt: attempt({ tests: { discovered: 1, passed: 0, failed: 1, skipped: 0 } }), at: AT }), null);
  accept(workflow);
  const lapsed = testRunRiskRoute(workflow, { phaseId: 'code', attempt: attempt(), at: '2026-11-05T00:00:00.000Z' });
  assert.equal(lapsed.lapsed, 'expired');
  assert.match(lapsed.guidance, /TRR-001 expired on 2026-11-01\./u);
});
