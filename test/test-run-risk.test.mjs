import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptedTestRunSummaries, boundTestRunRiskActive, coveringTestRunRisk, lapsedTestRunRiskRenewals, noTestExecuted, recordTestRunRisk, recordTestRunRiskRevocation,
  testRunRiskBinding, testRunRiskCoverageProblem, testRunRiskIneligibility, testRunRiskRefusalDetails, testRunRiskRoute,
  testRunRiskState, testsExecuted
} from '../src/test-run-risk.mjs';

const AT = '2026-10-16T10:00:00.000Z';
const ARGV = 'a'.repeat(64);
const REGISTRY = { category: 'environment', class: 'registry-unreachable', basis: 'process', signal: 'artifact transfer' };
const DATABASE = { category: 'environment', class: 'service-unreachable', basis: 'tests', signal: 'ECONNREFUSED', failedTests: 2 };
const COMPILE = { category: 'code', class: 'compile-error', basis: 'process', signal: 'error TS', file: 'src/value.ts' };
const attempt = (extra = {}) => ({
  attemptId: 'TA-0123456789abcdef0123', commandId: 'module-tests', argvSha256: ARGV,
  status: 'failed', exitCode: 1, tests: null, cause: REGISTRY, ...extra
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

test('only a run whose cause is the environment can be accepted, with a cause, reason and bounded expiry [TCE:REQ-041, REQ-043]', () => {
  assert.match(testRunRiskIneligibility(null), /no run of this command is recorded/u);
  assert.match(testRunRiskIneligibility(attempt({ status: 'passed', exitCode: 0 })), /passed/u);
  const asserted = attempt({ tests: { discovered: 1, passed: 0, failed: 1, skipped: 0 },
    cause: { category: 'code', class: 'assertion-failure', basis: 'tests', signal: 'assertion', failedTests: 1 } });
  assert.match(testRunRiskIneligibility(asserted), /stopped on a code cause, tests ran and failed \(assertion-failure, assertion\); 1 test\(s\) executed.*never accepted/u);
  assert.throws(() => recordTestRunRisk(story(), { phaseId: 'code', attempt: asserted,
    cause: 'x'.repeat(20), reason: 'y'.repeat(30), expires: '2026-11-01', actor: 'a', authorityGroup: 'g', at: AT }),
  { code: 'TEST_RUN_RISK_NOT_ELIGIBLE' });
  // A compile error before any test ran is the code's, not the environment's.
  assert.match(testRunRiskIneligibility(attempt({ cause: COMPILE })), /stopped on a code cause, the code does not compile in src\/value\.ts \(compile-error, error TS\); a code fault is fixed/u);
  // A hang and an output that names nothing are not known to be the environment.
  assert.match(testRunRiskIneligibility(attempt({ status: 'blocked', cause: { category: 'unknown', class: 'timeout', basis: 'process', signal: 'timeout' } })),
    /nothing in its latest run says the environment stopped it: the run timed out/u);
  // Tests ran, and every one that failed failed from a refused database connection: eligible.
  const refused = attempt({ tests: { discovered: 3, passed: 1, failed: 2, skipped: 0 }, cause: DATABASE });
  assert.equal(testRunRiskIneligibility(refused), null);
  assert.deepEqual(accept(story(), { attempt: refused }).observation, { attemptId: 'TA-0123456789abcdef0123', status: 'failed', exitCode: 1, testsExecuted: 3 });
  assert.throws(() => accept(story(), { cause: 'proxy' }), { code: 'TEST_RUN_RISK_INVALID' });
  assert.throws(() => accept(story(), { reason: 'fine' }), { code: 'TEST_RUN_RISK_INVALID' });
  assert.throws(() => accept(story(), { expires: '2026-10-15' }), /after today/u);
  assert.throws(() => accept(story(), { expires: '2027-03-01' }), /at most 90 days/u);
  assert.throws(() => accept(story(), { causeClass: 'service-unreachable' }), (error) =>
    error.code === 'TEST_RUN_RISK_NOT_ELIGIBLE' && /cannot be accepted as service-unreachable: its latest run stopped on a package registry/u.test(error.message));
  const workflow = story();
  const decision = accept(workflow);
  assert.equal(decision.id, 'TRR-001');
  assert.equal(decision.causeClass, 'registry-unreachable', 'the decision records the class it accepted');
  assert.deepEqual(decision.observation, { attemptId: 'TA-0123456789abcdef0123', status: 'failed', exitCode: 1, testsExecuted: 0 });
  assert.equal(decision.expiresAt, '2026-11-01T23:59:59.999Z');
  assert.equal(workflow.testRunRisks.length, 1);
});

test('a decision covers later runs of the same command with the same environment cause, until it expires or is revoked [TCE:REQ-042]', () => {
  const workflow = story();
  const decision = accept(workflow);
  const later = attempt({ attemptId: 'TA-ffffffffffffffffffff', status: 'blocked', exitCode: null });
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'code', attempt: later, at: AT })?.id, 'TRR-001');
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'review', attempt: later, at: AT }), null, 'another step');
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'code', attempt: { ...later, argvSha256: 'b'.repeat(64) }, at: AT }), null,
    'a changed command needs a new decision');
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'code',
    attempt: { ...later, status: 'failed', tests: { discovered: 2, passed: 1, failed: 1, skipped: 0 },
      cause: { category: 'code', class: 'assertion-failure', basis: 'tests', signal: 'assertion', failedTests: 1 } }, at: AT }), null,
  'a run in which tests executed and failed is never covered');
  // A compile error the change introduced, a hang and another environment cause are not what was accepted.
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'code', attempt: { ...later, cause: COMPILE }, at: AT }), null);
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'code', attempt: { ...later, cause: { category: 'unknown', class: 'timeout', basis: 'process', signal: 'timeout' } }, at: AT }), null);
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'code', attempt: { ...later, cause: DATABASE }, at: AT }), null);
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'code', attempt: later, at: '2026-11-02T00:00:00.000Z' }), null, 'expired');
  assert.equal(testRunRiskState(workflow, { phaseId: 'code', commandId: 'module-tests', argvSha256: ARGV, causeClass: 'registry-unreachable' },
    { at: '2026-11-02T00:00:00.000Z' }).state, 'expired');

  const binding = testRunRiskBinding(decision);
  assert.equal(boundTestRunRiskActive(workflow, binding, { at: AT }), true);
  assert.equal(boundTestRunRiskActive(workflow, { ...binding, sha256: `sha256:${'0'.repeat(64)}` }, { at: AT }), false,
    'a binding to other bytes is not this decision');
  assert.equal(testRunRiskCoverageProblem(workflow, binding, { phaseId: 'code', attempt: later, at: AT }), null);
  assert.match(testRunRiskCoverageProblem(workflow, binding, { phaseId: 'code', attempt: { ...later, commandId: 'other' }, at: AT }),
    /another step or command/u);
  assert.match(testRunRiskCoverageProblem(workflow, binding, { phaseId: 'code', attempt: { ...later, cause: COMPILE }, at: AT }),
    /this run stopped on the code does not compile in src\/value\.ts .*which no test-run risk decision covers/u, 'replay re-reads the cause too');
  assert.match(testRunRiskCoverageProblem(workflow, binding, { phaseId: 'code', attempt: { ...later, cause: DATABASE }, at: AT }),
    /not on the cause TRR-001 accepted \(registry-unreachable\)/u);

  // Another environment cause of the same command is decided on its own and stands beside the first.
  const database = accept(workflow, { attempt: attempt({ tests: { discovered: 2, passed: 0, failed: 2, skipped: 0 }, cause: DATABASE }) });
  assert.equal(database.causeClass, 'service-unreachable');
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'code', attempt: later, at: AT })?.id, 'TRR-001');
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'code', attempt: { ...later, status: 'failed', tests: { discovered: 2, passed: 0, failed: 2, skipped: 0 }, cause: DATABASE }, at: AT })?.id, 'TRR-002');

  recordTestRunRiskRevocation(workflow, { riskId: 'TRR-001', reason: 'The repository is reachable again from the office.',
    actor: 'lead@example.invalid', authorityGroup: 'code-approvers', at: AT });
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'code', attempt: later, at: AT }), null, 'revoked');
  assert.equal(boundTestRunRiskActive(workflow, binding, { at: AT }), false);
  assert.match(testRunRiskCoverageProblem(workflow, binding, { phaseId: 'code', attempt: later, at: AT }),
    /is revoked; a person who approves code must accept it again: .*--command module-tests --cause-class registry-unreachable /u);
  assert.throws(() => recordTestRunRiskRevocation(workflow, { riskId: 'TRR-001', reason: 'x'.repeat(30), actor: 'a', authorityGroup: 'g', at: AT }),
    { code: 'TEST_RUN_RISK_REVOKED' });

  // A renewal on the same command and cause carries the runs an earlier decision let through.
  const renewal = accept(workflow, { expires: '2026-11-10' });
  assert.equal(renewal.id, 'TRR-003');
  assert.equal(boundTestRunRiskActive(workflow, binding, { at: AT }), true,
    'the renewal now governs the command, so runs TRR-001 let through stay carried');
  assert.equal(boundTestRunRiskActive(workflow, testRunRiskBinding(renewal), { at: AT }), true);
});

test('a decision recorded before causes were classified covers only environment runs in which no test executed [TCE:REQ-044]', () => {
  const workflow = story();
  const { causeClass, ...legacy } = accept(workflow);
  assert.equal(causeClass, 'registry-unreachable');
  workflow.testRunRisks = [legacy];
  const later = attempt({ attemptId: 'TA-ffffffffffffffffffff', cause: { category: 'environment', class: 'docker-unavailable', basis: 'process', signal: 'Docker daemon' } });
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'code', attempt: later, at: AT })?.id, 'TRR-001', 'any environment cause, as it was accepted');
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'code', attempt: { ...later, cause: COMPILE }, at: AT }), null, 'never a code cause');
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'code', at: AT,
    attempt: { ...later, tests: { discovered: 2, passed: 0, failed: 2, skipped: 0 }, cause: DATABASE } }), null, 'nor tests that ran');
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'code', attempt: later, at: '2026-11-02T00:00:00.000Z' }), null, 'until it expires');
  // A receipt recorded before causes were classified replays as it was judged then.
  const recorded = { ...later };
  delete recorded.cause;
  assert.equal(testRunRiskCoverageProblem(workflow, testRunRiskBinding(legacy), { phaseId: 'code', attempt: recorded, at: AT }), null);
  assert.match(testRunRiskCoverageProblem(workflow, testRunRiskBinding(legacy), { phaseId: 'code', at: AT,
    attempt: { ...recorded, tests: { discovered: 1, passed: 0, failed: 1, skipped: 0 } } }), /tests executed in this run/u);
  // Once it expires, the refusal says so beside the route for the run's own cause.
  assert.match(testRunRiskRoute(workflow, { phaseId: 'code', attempt: later, at: '2026-11-02T00:00:00.000Z' }).guidance, /TRR-001 expired on 2026-11-01\./u);
});

test('a refused run names its cause: an environment cause with the approvers route, a code cause as never covered', () => {
  const workflow = story();
  const route = testRunRiskRoute(workflow, { phaseId: 'code', attempt: attempt(), at: AT });
  assert.equal(route.eligible, true);
  assert.equal(route.causeClass, 'registry-unreachable');
  assert.match(route.command, /^singularity-flow decision test-risk ENV-1 --phase code --command module-tests --cause-class registry-unreachable --cause /u);
  assert.match(route.guidance, /No test executed in this run, so the environment may be what stopped it: a package registry, the network or a proxy cannot be reached \(registry-unreachable, artifact transfer\)\..*a person who approves code can accept the risk in their own terminal \(an agent cannot\), for later runs with this same cause only/u);
  const tests = { discovered: 2, passed: 0, failed: 2, skipped: 0 };
  assert.match(testRunRiskRoute(workflow, { phaseId: 'code', attempt: attempt({ tests, cause: DATABASE }), at: AT }).guidance,
    /^Every failed test of this run failed from the environment: a service the tests connect to is not reachable \(service-unreachable, ECONNREFUSED\)/u);
  assert.equal(testRunRiskRoute(workflow, { phaseId: 'code', attempt: attempt({ tests: { discovered: 1, passed: 0, failed: 1, skipped: 0 }, cause: undefined }), at: AT }), null);
  assert.equal(testRunRiskRoute(workflow, { phaseId: 'code', attempt: attempt({ cause: COMPILE }), at: AT }), null);
  assert.deepEqual(testRunRiskRefusalDetails(workflow, { phaseId: 'code', attempt: attempt({ cause: COMPILE }), at: AT }), { testRunCause: {
    category: 'code', class: 'compile-error', file: 'src/value.ts',
    guidance: 'This run stopped on a code cause, the code does not compile in src/value.ts (compile-error, error TS): fix it in the step. A test-run risk decision never covers a code cause.' } });
  // A plain test failure says nothing more, unless a decision on the command might be expected to cover it.
  const asserted = attempt({ tests: { discovered: 1, passed: 0, failed: 1, skipped: 0 }, cause: { category: 'code', class: 'assertion-failure', basis: 'tests', signal: 'assertion', failedTests: 1 } });
  assert.equal(testRunRiskRefusalDetails(workflow, { phaseId: 'code', attempt: asserted, at: AT }).testRunCause.guidance, undefined);
  accept(workflow);
  assert.match(testRunRiskRefusalDetails(workflow, { phaseId: 'code', attempt: asserted, at: AT }).testRunCause.guidance, /never covers a code cause/u);
  assert.deepEqual(testRunRiskRefusalDetails(workflow, { phaseId: 'code', attempt: attempt({ status: 'passed' }), at: AT }), {});
  const lapsed = testRunRiskRoute(workflow, { phaseId: 'code', attempt: attempt(), at: '2026-11-05T00:00:00.000Z' });
  assert.equal(lapsed.lapsed, 'expired');
  assert.match(lapsed.guidance, /TRR-001 expired on 2026-11-01\./u);
});

test('the review and a lapsed renewal name the cause a decision accepted', () => {
  const workflow = story();
  const registry = accept(workflow);
  const database = accept(workflow, { attempt: attempt({ tests: { discovered: 2, passed: 0, failed: 2, skipped: 0 }, cause: DATABASE }),
    cause: 'The integration database is not running on this laptop' });
  const entries = [{ commandId: 'module-tests', status: 'failed', testRunRisk: testRunRiskBinding(registry) },
    { commandId: 'module-tests', status: 'failed', testRunRisk: testRunRiskBinding(database) }];
  const [first, second] = acceptedTestRunSummaries(workflow, 'code', entries, { at: AT });
  assert.equal(first.causeClass, 'registry-unreachable');
  assert.equal(first.words, 'No test ran for module-tests (a package registry, the network or a proxy cannot be reached): Maven cannot reach the company repository'
    + ' from this laptop. Accepted as TRR-001 by dev@example.invalid (code-approvers) until 2026-11-01. The run stays failed; it is not a pass.');
  assert.match(second.words, /^The failed tests of module-tests failed only from the environment \(a service the tests connect to is not reachable\): The integration database/u);
  const lapsed = lapsedTestRunRiskRenewals(workflow, entries, { at: '2026-11-03T00:00:00.000Z' });
  assert.equal(lapsed.length, 2, 'one renewal per command and cause');
  assert.match(lapsed[0].command, / --command module-tests --cause-class registry-unreachable --cause /u);
  assert.match(lapsed[1].words, /TRR-002 expired on 2026-11-01, so the run of module-tests it let through \(its failed tests failed from the environment\) is no longer carried/u);
});
