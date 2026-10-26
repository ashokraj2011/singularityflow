/**
 * Where test refusals go next when no test-recovery agreement exists: a run in which no test
 * executed (every test skipped, or the build never reached them) goes to the step approvers'
 * test-run risk decision, which an approver on another machine can bind by the command digest; a
 * lapsed decision names its renewal; a runner that cannot be inferred goes to test setup; a model
 * skip says how to run the command. None of these marks a test passed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateExternalCommandForModelMode } from '../src/external-command-policy.mjs';
import { phaseResolutionChoices } from '../src/phase-resolution.mjs';
import { classifyRequiredTestFailure } from '../src/test-execution-diagnostics.mjs';
import {
  boundTestRunRiskActive, coveringTestRunRisk, lapsedTestRunRiskRenewals, recordTestRunRisk, recordTestRunRiskRevocation,
  testRunRiskBinding, testRunRiskCoverageProblem, testRunRiskDecisionCommand, testRunRiskRoute
} from '../src/test-run-risk.mjs';

const AT = '2026-10-16T10:00:00.000Z';
const ARGV = 'c'.repeat(64);
const skippedRun = (extra = {}) => ({
  attemptId: 'TA-00000000000000000001', commandId: '.-node-tests', argvSha256: ARGV, status: 'failed', exitCode: 0,
  tests: { discovered: 3, passed: 0, failed: 0, skipped: 3 }, ...extra
});
const story = () => ({ workItem: { id: 'ENV-2' }, testRunRisks: [] });
const decide = (workflow, extra = {}) => recordTestRunRisk(workflow, {
  phaseId: 'implement', attempt: null, commandId: '.-node-tests', argvSha256: ARGV, causeClass: 'all-tests-skipped',
  cause: 'The integration tests skip themselves without a Docker daemon here',
  reason: 'The pipeline runs them against a real database before merge.', expires: '2026-11-01',
  actor: 'lead@example.invalid', authorityGroup: 'implement-approvers', at: AT, ...extra
});

test('an all-skipped run that exited 0 is an environment cause; a model skip says how to run the command', () => {
  const skipped = classifyRequiredTestFailure('CODE_TEST_FAILED', { status: 'passed', exitCode: 0 },
    { status: 'observed', tests: { discovered: 3, passed: 0, failed: 0, skipped: 3 } });
  assert.equal(skipped.kind, 'all-tests-skipped');
  assert.match(skipped.guidance, /Docker daemon, database or service.*A skipped test is not a pass/u);
  assert.equal(skipped.retryCondition, 'runtime-changed');
  // A failing process with skipped tests keeps its existing reading.
  assert.equal(classifyRequiredTestFailure('CODE_TEST_FAILED', { status: 'failed', exitCode: 1 },
    { status: 'observed', tests: { discovered: 2, passed: 0, failed: 0, skipped: 2 } }).kind, 'invalid-or-missing-report');

  const policy = evaluateExternalCommandForModelMode({ id: 'suite', kind: 'test', argv: ['make', 'test'] }, { modelEnabled: false });
  assert.equal(policy.action, 'skip');
  assert.match(policy.reason, /declares no modelPolicy.*Rerun with the model enabled, or have configuration declare modelPolicy: never/u);
  const model = classifyRequiredTestFailure('CODE_TEST_SKIPPED',
    { status: 'skipped-warning', externalModelPolicy: 'unknown', exitCode: null, stderr: policy.reason }, { status: 'unavailable' });
  assert.equal(model.kind, 'model-policy-skipped');
  assert.match(model.guidance, /Rerun with the model enabled, or have configuration declare modelPolicy: never/u);
  assert.doesNotMatch(model.guidance, /reporter/u);
});

test('an approver with no recorded run binds the command by the digest its refusal named', () => {
  const workflow = story();
  const route = testRunRiskRoute(workflow, { phaseId: 'implement', attempt: skippedRun(), at: AT });
  assert.match(route.command, new RegExp(`--expires <YYYY-MM-DD> --argv-sha256 ${ARGV}$`, 'u'));
  assert.equal(testRunRiskDecisionCommand(workflow, { phaseId: 'implement', commandId: 'x', argvSha256: 'not-a-digest' }).includes('--argv-sha256'), false);

  // Without a run or a digest there is nothing to bind.
  assert.throws(() => decide(story(), { argvSha256: null }), (error) =>
    error.code === 'TEST_RUN_RISK_NOT_ELIGIBLE' && /--argv-sha256/u.test(error.message));
  // Bound by digest, the decision names the cause class the refusal gave.
  assert.throws(() => decide(story(), { causeClass: null }), { code: 'TEST_RUN_RISK_INVALID' });
  assert.throws(() => decide(story(), { causeClass: 'compile-error' }), { code: 'TEST_RUN_RISK_INVALID' });
  const decision = decide(workflow);
  assert.equal(decision.boundBy, 'command-digest');
  assert.equal(decision.causeClass, 'all-tests-skipped');
  assert.equal(decision.observation, undefined, 'no run was observed by this decision');
  assert.equal(decision.argvSha256, ARGV);
  // Every run it lets through is still checked: no executed test, same command and argv.
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'implement', attempt: skippedRun(), at: AT })?.id, 'TRR-001');
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'implement', at: AT,
    attempt: skippedRun({ tests: { discovered: 3, passed: 2, failed: 1, skipped: 0 } }) }), null);
  assert.equal(coveringTestRunRisk(workflow, { phaseId: 'implement', attempt: skippedRun({ argvSha256: 'd'.repeat(64) }), at: AT }), null);
  // A recorded run that executed tests is never accepted, digest or not.
  assert.throws(() => decide(story(), { attempt: skippedRun({ tests: { discovered: 1, passed: 0, failed: 1, skipped: 0 } }) }),
    { code: 'TEST_RUN_RISK_NOT_ELIGIBLE' });
});

test('a lapsed decision names its renewal; an active one names nothing', () => {
  const workflow = story();
  const decision = decide(workflow);
  const carried = [{ id: '.-node-tests', status: 'failed', testRunRisk: testRunRiskBinding(decision) }, { id: 'lint', status: 'passed' }];
  assert.deepEqual(lapsedTestRunRiskRenewals(workflow, carried, { at: AT }), []);
  const expired = lapsedTestRunRiskRenewals(workflow, carried, { at: '2026-11-03T00:00:00.000Z' });
  assert.equal(expired.length, 1);
  assert.equal(expired[0].state, 'expired');
  assert.match(expired[0].command, /^singularity-flow decision test-risk ENV-2 --phase implement --command \.-node-tests .*--expires <YYYY-MM-DD> --argv-sha256 c{64}$/u);
  assert.match(expired[0].words, /TRR-001 expired on 2026-11-01, so the run of \.-node-tests it let through .* is no longer carried/u);
  assert.match(testRunRiskCoverageProblem(workflow, testRunRiskBinding(decision),
    { phaseId: 'implement', attempt: skippedRun(), at: '2026-11-03T00:00:00.000Z' }), /must accept it again: singularity-flow decision test-risk ENV-2/u);

  recordTestRunRiskRevocation(workflow, { riskId: 'TRR-001', reason: 'The pipeline database is unavailable this week.',
    actor: 'lead@example.invalid', authorityGroup: 'implement-approvers', at: AT });
  const revoked = lapsedTestRunRiskRenewals(workflow, [...carried, carried[0]], { at: AT });
  assert.equal(revoked.length, 1, 'one renewal per command');
  assert.equal(revoked[0].state, 'revoked');
  decide(workflow, { expires: '2026-11-10' });
  assert.deepEqual(lapsedTestRunRiskRenewals(workflow, carried, { at: AT }), [], 'the renewal carries the run again');
  assert.equal(boundTestRunRiskActive(workflow, carried[0].testRunRisk, { at: AT }), true);
});

test('test findings route to what can act without a test-recovery agreement', () => {
  const workflow = { workItem: { id: 'ENV-2' } };
  const phase = { id: 'implement' };
  const first = (finding, story = workflow) => phaseResolutionChoices(story, phase, finding).choices[0];
  // Observed-risk inspection exists only under an agreement.
  assert.equal(first({ code: 'CODE_TEST_FAILED' }, { ...workflow, testRecovery: { id: 'TRA-1' } }).kind, 'risk-inspection');
  const failing = first({ code: 'code.delivery.incomplete', details: { sourceCode: 'CODE_TEST_FAILED' } });
  assert.equal(failing.kind, 'test-repair');
  assert.equal(failing.command, 'singularity-flow recover ENV-2 --phase implement --json');
  assert.doesNotMatch(JSON.stringify(phaseResolutionChoices(workflow, phase, { code: 'CODE_TEST_FAILED' }).choices), /test-policy risks/u);

  const route = testRunRiskRoute(story(), { phaseId: 'implement', attempt: skippedRun(), at: AT });
  const risk = first({ code: 'code.delivery.incomplete', details: { sourceCode: 'CODE_TEST_FAILED', testRunRisk: route } });
  assert.equal(risk.kind, 'test-run-risk');
  assert.equal(risk.owner, 'phase-approval-authority');
  assert.equal(risk.command, `singularity-flow decision test-risk ENV-2 --phase implement --command .-node-tests --cause-class all-tests-skipped --cause <cause> --reason <reason> --expires <YYYY-MM-DD> --argv-sha256 ${ARGV}`);
  // A person runs it in their own terminal: no turn records a test-run risk, so no skill is its route.
  assert.equal(risk.skill, null);
  assert.equal(phaseResolutionChoices(workflow, phase, { code: 'CODE_TEST_FAILED', details: { testRunRisk: route } }).status, 'needs-human');

  // A downstream refusal of a lapsed decision routes to its renewal, not to repair.
  const lapsedStory = story();
  const lapsed = decide(lapsedStory);
  const renewals = lapsedTestRunRiskRenewals(lapsedStory, [{ testRunRisk: testRunRiskBinding(lapsed) }], { at: '2026-11-03T00:00:00.000Z' });
  const renew = first({ code: 'PRIOR_CODE_TEST_EVIDENCE_REQUIRED', details: { testRunRiskRenewals: renewals } });
  assert.equal(renew.kind, 'test-run-risk');
  assert.match(renew.detail, /the decision that let it through lapsed/u);
  assert.match(renew.command, new RegExp(`--argv-sha256 ${ARGV}$`, 'u'));
  for (const sourceCode of ['TEST_MODULE_AMBIGUOUS', 'TEST_MODULE_UNCOVERED', 'GRADLE_TEST_TARGET_REQUIRED', 'XCODE_TEST_TARGET_REQUIRED']) {
    const setup = first({ code: 'code.delivery.incomplete', details: { sourceCode } });
    assert.equal(setup.kind, 'runner-setup', sourceCode);
    assert.equal(setup.command, 'singularity-flow capability test-setup --json');
    assert.match(setup.detail, /story test-policy amend --reason <why>/u);
  }
  assert.equal(first({ code: 'code.delivery.incomplete', details: { sourceCode: 'CODE_TEST_RESULT_REQUIRED', configurationDependency: true } }).kind, 'runner-setup');
  assert.equal(first({ code: 'code.delivery.incomplete', details: { sourceCode: 'CODE_TEST_RESULT_REQUIRED' } }).kind, 'test-repair',
    'a repository-owned reporter is repaired by its author');
  assert.match(first({ code: 'CODE_TEST_SKIPPED', details: { requiredTestExecution: { failure: { kind: 'model-policy-skipped' } } } }).detail,
    /rerun with the model enabled, or have approved configuration declare modelPolicy: never/u);
  // Every test-configuration code has its catalog entry: the runner-setup section.
  assert.equal(phaseResolutionChoices(workflow, phase, { code: 'TEST_MODULE_AMBIGUOUS' }).documentation.section, 'CODE_DELIVERY_TEST_COMMAND_REQUIRED');

  // Evidence capture names the plan's tool, not only a browser on a port.
  const evidence = first({ code: 'code.delivery.retained-evidence-missing', path: 'evidence/home.png',
    details: { sourceCode: 'CODE_DELIVERY_RETAINED_EVIDENCE_MISSING' } });
  assert.match(evidence.detail, /with the tool the plan names \(a browser on a loopback port you confirmed free, a simulator or emulator, or a command-line run\)/u);
  assert.match(evidence.detail, /save the file at exactly that path/u);
  assert.doesNotMatch(evidence.detail, /repositoryPath with its own script/u);
});
