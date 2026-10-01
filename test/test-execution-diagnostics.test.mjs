import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyRequiredTestFailure, requiredTestExecutionForRefusal
} from '../src/test-execution-diagnostics.mjs';

const observed = (tests) => ({ status: 'observed', tests });

test('required test failures distinguish runtime, report, test, and process causes', () => {
  const cases = [
    ['missing-launcher', 'CODE_TEST_FAILED', { status: 'blocked', stderr: 'Unable to run quality command: spawn pytest ENOENT' }, { status: 'unavailable' }],
    ['missing-dependency', 'CODE_TEST_FAILED', { status: 'failed', stderr: 'No module named pytest' }, { status: 'unavailable' }],
    ['timeout', 'CODE_TEST_FAILED', { status: 'blocked', stderr: 'Command exceeded its 30000ms timeout.' }, { status: 'unavailable' }],
    ['source-mutation', 'QUALITY_COMMAND_SOURCE_MUTATION', { status: 'failed' }, observed({ failed: 1 })],
    ['failed-tests', 'CODE_TEST_FAILED', { status: 'failed', exitCode: 1 }, observed({ failed: 2 })],
    ['process-failed-with-passing-report', 'CODE_TEST_FAILED', { status: 'failed', exitCode: 1 }, observed({ discovered: 2, passed: 2, failed: 0, skipped: 0 })],
    ['invalid-or-missing-report', 'CODE_TEST_FAILED', { status: 'failed', exitCode: 1 }, observed({ discovered: 0, passed: 0, failed: 0, skipped: 0 })],
    ['invalid-or-missing-report', 'CODE_TEST_FAILED', { status: 'failed', exitCode: 1 }, observed({ discovered: 2, passed: 0, failed: 0, skipped: 2 })],
    ['invalid-or-missing-report', 'CODE_TEST_RESULT_REQUIRED', { status: 'passed', exitCode: 0 }, { status: 'unavailable' }],
    ['generic', 'CODE_TEST_FAILED', { status: 'failed', exitCode: 2 }, { status: 'unavailable' }]
  ];
  for (const [kind, code, check, report] of cases) {
    const classification = classifyRequiredTestFailure(code, check, report);
    assert.equal(classification.kind, kind);
    assert.ok(classification.guidance);
    assert.ok(classification.retryCondition);
  }
  assert.equal(classifyRequiredTestFailure('CODE_TEST_FAILED', {
    status: 'failed', stderr: 'No module named pytest'
  }, { status: 'unavailable' }).retryCondition, 'runtime-changed');
});

test('required test execution is a bounded allowlist, never gate evidence', () => {
  const sha256 = 'a'.repeat(64);
  const execution = {
    commandId: 'unit', provenance: 'configured', argv: ['node', '--token', 'private-argv'],
    cwd: '/repo', workingDirectory: '.', resultPath: '/repo/report.xml',
    configuredResultPath: 'report.xml', resultAdapter: 'junit-xml',
    status: 'failed', exitCode: 1,
    stderr: { text: `token=private-stderr ${'x'.repeat(5000)}`, bytes: 5021 },
    stdout: { text: 'tests failed', bytes: 12 },
    report: { status: 'observed', tests: { discovered: 2, passed: 1, failed: 1, skipped: 0,
      hostile: 'private-count' }, sha256, bytes: 391,
    failedTestcases: [{ name: 'suite::case', status: 'failed', secret: 'private-case' }],
    secret: 'private-report' },
    failure: { kind: 'failed-tests', guidance: 'private-guidance', retryCondition: 'private-retry' },
    secret: 'private-execution'
  };
  const error = Object.assign(new Error('failed'), { code: 'CODE_TEST_FAILED',
    details: { requiredTestExecution: execution, secret: 'private-details' } });
  const projected = requiredTestExecutionForRefusal(error);
  assert.equal(projected.argv, null);
  assert.equal(projected.argvWithheld, true);
  assert.equal(projected.report.gateEligible, false);
  assert.equal(projected.report.sha256, sha256);
  assert.deepEqual(projected.report.tests,
    { discovered: 2, passed: 1, failed: 1, skipped: 0 });
  assert.deepEqual(projected.report.failedTestcases, [{ name: 'suite::case', status: 'failed' }]);
  assert.equal(projected.failure.kind, 'failed-tests');
  assert.match(projected.failure.guidance, /Repair the reported failing tests/u);
  assert.ok(projected.stderr.text.length <= 2012);
  assert.doesNotMatch(JSON.stringify(projected), /private-/u);
});

test('source mutation retains bounded diagnostics but ignores arbitrary attached fields', () => {
  const error = Object.assign(new Error('source changed'), {
    code: 'QUALITY_COMMAND_SOURCE_MUTATION', details: { requiredTestExecution: {
      commandId: 'unit', provenance: 'configured', argv: ['private-argv'],
      cwd: '/repo', resultPath: '/repo/report.xml',
      stdout: { text: 'changed source' }, stderr: { text: 'mutation detected' },
      report: { status: 'unavailable', reason: 'report missing' },
      failure: { kind: 'source-mutation' }
    }, sourcePreview: 'private-source' }
  });
  const projected = requiredTestExecutionForRefusal(error);
  assert.equal(projected.failure.kind, 'source-mutation');
  assert.equal(projected.report.gateEligible, false);
  assert.equal(projected.report.reason, 'report missing');
  assert.doesNotMatch(JSON.stringify(projected), /private-/u);
});
