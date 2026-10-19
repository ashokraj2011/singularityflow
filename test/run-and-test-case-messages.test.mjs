import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { CASE_MESSAGE_LIMIT, testCaseMessages } from '../src/test-case-messages.mjs';
import { buildTestSummary } from '../src/test-summary.mjs';

import { repository } from './helpers/run-and-test-fixture.mjs';

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>${body}</testsuites>`;

test('junit-xml: the failure or error message and the first lines of its text, in occurrence order', () => {
  const surefire = xml(`<testsuite name="com.example.PaymentTest" tests="4" failures="1" errors="1" skipped="1">
  <testcase classname="com.example.PaymentTest" name="refunds" time="0.01"/>
  <testcase classname="com.example.PaymentTest" name="rounds" time="0.02">
    <failure message="expected: &lt;2&gt; but was: &lt;1&gt;" type="org.opentest4j.AssertionFailedError"><![CDATA[org.opentest4j.AssertionFailedError: expected: <2> but was: <1>
	at org.junit.jupiter.api.AssertionUtils.fail(AssertionUtils.java:55)
	at com.example.PaymentTest.rounds(PaymentTest.java:21)
]]></failure>
  </testcase>
  <testcase classname="com.example.PaymentTest" name="connects" time="0.03"><error type="java.net.ConnectException">Connection refused
	at java.base/sun.nio.ch.Net.connect0(Native Method)</error></testcase>
  <testcase classname="com.example.PaymentTest" name="later"><skipped/></testcase>
</testsuite>`);
  const pytest = xml(`<testsuite name="pytest"><testcase classname="tests.test_pay" name="test_bare"><failure/></testcase></testsuite>`);
  assert.deepEqual(testCaseMessages('junit-xml', [Buffer.from(surefire), Buffer.from(pytest)], 5), [
    null,
    'expected: <2> but was: <1>\n\tat org.junit.jupiter.api.AssertionUtils.fail(AssertionUtils.java:55)\n\tat com.example.PaymentTest.rounds(PaymentTest.java:21)',
    'Connection refused\n\tat java.base/sun.nio.ch.Net.connect0(Native Method)',
    null,
    null
  ]);
  // A count that does not match the kept occurrences gives no messages rather than misplaced ones.
  assert.equal(testCaseMessages('junit-xml', [Buffer.from(surefire)], 5), null);
  assert.equal(testCaseMessages('junit-xml', [Buffer.from('<testsuites><testcase')], 1), null);
});

test('jest-json and vitest-json: failureMessages without terminal colours, bounded', () => {
  const report = (status, failureMessages) => JSON.stringify({ numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, numPendingTests: 0, testResults: [{
    assertionResults: [
      { ancestorTitles: ['cart'], title: 'adds', fullName: 'cart adds', status: 'passed', failureMessages: [] },
      { ancestorTitles: ['cart'], title: 'totals', fullName: 'cart totals', status, failureMessages }
    ] }] });
  const jest = report('failed', ['\u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m\u001b[2m).toBe(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m)\u001b[22m\n\nExpected: \u001b[32m3\u001b[39m\nReceived: \u001b[31m2\u001b[39m\n    at Object.<anonymous> (cart.test.js:9:20)']);
  assert.deepEqual(testCaseMessages('jest-json', [Buffer.from(jest)], 2),
    [null, 'expect(received).toBe(expected)\n\nExpected: 3\nReceived: 2\n    at Object.<anonymous> (cart.test.js:9:20)']);
  const long = report('failed', ['AssertionError: '.padEnd(CASE_MESSAGE_LIMIT * 2, 'x'), 'second retry']);
  const [, bounded] = testCaseMessages('vitest-json', [Buffer.from(long)], 2);
  assert.equal(bounded.length, CASE_MESSAGE_LIMIT);
  assert.ok(bounded.endsWith('…'));
  assert.deepEqual(testCaseMessages('vitest-json', [Buffer.from(report('failed', []))], 2), [null, null], 'a failure with no message has none');
});

test('node-tap: the error the repository\'s node:test observer records for a failed case, from a real node --test run', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-case-messages-node-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'cart.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "test('adds', () => assert.equal(1 + 1, 2));\ntest('totals', () => assert.equal(1 + 1, 3, 'the cart total is wrong'));\n"
    + "test('later', { skip: true }, () => {});\n");
  const reporter = pathToFileURL(path.resolve('src/verification/node-test-reporter.mjs')).href;
  const env = { ...process.env, SINGULARITY_FLOW_NODE_TEST_ROOT: directory, SINGULARITY_FLOW_NODE_TEST_TAP: '1' };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const run = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, 'cart.test.mjs'], { cwd: directory, env, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(testCaseMessages('node-tap', [Buffer.from(run.stdout)], 3), [null, 'the cart total is wrong\n\n2 !== 3', null]);
  // An older report, written before the observer kept messages, has its cases and no messages.
  assert.equal((run.stdout.match(/^# sflow-node-observation-v1 .*$/mu)[0]).includes('message'), false, 'the occurrences an attempt keeps are unchanged');
  const older = run.stdout.replace(/^# sflow-node-messages-v1 .*\n/mu, '');
  assert.deepEqual(testCaseMessages('node-tap', [Buffer.from(older)], 3), [null, null, null]);
  assert.equal(testCaseMessages('node-tap', [Buffer.from('TAP version 13\nok 1 - x\n')], 1), null, 'a TAP report without identities gives none');
});

test('the summary gives a failed case its message (or null) and other cases none; totals-only commands list no cases', () => {
  const receipt = (commandId, adapter, occurrences, tests) => ({ commandId, adapter, status: 'failed', exitCode: 1, tests, occurrences });
  const summary = buildTestSummary({ scope: { kind: 'capability', capability: 'web' }, run: { id: 'RUN-1', label: 'x' }, entries: [
    { receipt: receipt('unit', 'junit-xml', [{ className: 'a', name: 'one', outcome: 'passed' }, { className: 'a', name: 'two', outcome: 'failed' },
      { className: 'a', name: 'three', outcome: 'failed' }], { discovered: 3, passed: 1, failed: 2, skipped: 0 }),
    messages: ['ignored for a passed case', 'off by one', null] },
    { receipt: receipt('older', 'junit-xml', [{ className: 'b', name: 'four', outcome: 'failed' }], { discovered: 1, passed: 0, failed: 1, skipped: 0 }) },
    { receipt: receipt('karma', 'karma-text', [], { discovered: 3, passed: 3, failed: 0, skipped: 0 }) }
  ] });
  assert.deepEqual(summary.cases.map((entry) => [entry.name, entry.outcome, entry.message]), [
    ['one', 'passed', undefined], ['two', 'failed', 'off by one'], ['three', 'failed', null], ['four', 'failed', null]]);
  assert.equal(Object.hasOwn(summary.cases[0], 'message'), false);
  assert.equal(summary.cases.some((entry) => entry.command === 'karma'), false);
});

const SECRET = 'case-message-secret-4d1f';
const SECRET_JUNIT = `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('.sflow/results', { recursive: true });
writeFileSync('.sflow/results/secret.xml', '<?xml version="1.0"?><testsuites><testsuite name="api">'
  + '<testcase classname="api.Login" name="accepts" file="tests/login.py" line="3"/>'
  + '<testcase classname="api.Login" name="rejects" file="tests/login.py" line="9"><failure message="token ' + process.env.API_TOKEN + ' was rejected">'
  + 'HTTP 401 for token ' + process.env.API_TOKEN + '</failure></testcase></testsuite></testsuites>');
process.exit(1);
`;
const JEST_REPORT = `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('.sflow/results', { recursive: true });
writeFileSync('.sflow/results/jest.json', JSON.stringify({ numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, numPendingTests: 0, testResults: [{
  assertionResults: [{ ancestorTitles: ['cart'], title: 'totals', fullName: 'cart totals', status: 'failed', duration: 4,
    failureMessages: ['\\u001b[31mExpected: 3\\nReceived: 2\\u001b[39m'] }] }] }));
process.exit(1);
`;

test('tests run and tests summary carry each failed case\'s message, redacted with the values a bound environment gave', { timeout: 300_000 }, async (t) => {
  const commands = [
    { id: 'login-tests', kind: 'test', argv: ['node', 'tools/secret-junit.mjs'], workingDirectory: '.', affectedRoots: ['tests'], modelPolicy: 'never',
      result: { adapter: 'junit-xml', path: '.sflow/results/secret.xml' } },
    { id: 'cart-tests', kind: 'test', argv: ['node', 'tools/jest-report.mjs'], workingDirectory: '.', affectedRoots: ['cart'], modelPolicy: 'never',
      result: { adapter: 'jest-json', path: '.sflow/results/jest.json' } }
  ];
  const repo = await repository(t, { implementQualityCommands: commands, files: { 'tools/secret-junit.mjs': SECRET_JUNIT, 'tools/jest-report.mjs': JEST_REPORT } });
  await writeFile(path.join(repo.root, 'singularity/environments.yml'),
    'schemaVersion: 1\nenvironments:\n  qa:\n    requires:\n      - { name: API_TOKEN, kind: secret }\n');
  await writeFile(path.join(repo.root, 'singularity/capabilities.yml'), JSON.stringify({ version: 1, capabilities: { web: {
    kind: 'delivery', repository: 'web', application: { tests: [{ use: 'login-tests', environments: ['qa'] }, { use: 'cart-tests' }] },
    policy: { localIntegrationEvidence: 'allowed' } } } }, null, 2));
  repo.must('git', ['add', '.']);
  repo.must('git', ['commit', '-q', '-m', 'Environment declaration']);
  const bind = spawnSync(process.execPath, [path.resolve('bin/singularity-flow.mjs'), 'env', 'bind', 'qa', '--stdin'], {
    cwd: repo.root, env: repo.env, encoding: 'utf8', input: JSON.stringify({ bindings: { API_TOKEN: { source: 'local', value: SECRET } } }) });
  assert.equal(bind.status, 0, bind.stderr);
  const ran = repo.sflowJson('tests', 'run');
  assert.equal(ran.status, 1, 'failed cases make the run exit non-zero');
  const summary = repo.sflowJson('tests', 'summary').value;
  assert.deepEqual(summary.cases.map((entry) => [entry.command, entry.name, entry.outcome, entry.message]), [
    ['login-tests', 'accepts', 'passed', undefined],
    ['login-tests', 'rejects', 'failed', 'token [redacted:API_TOKEN] was rejected\nHTTP 401 for token [redacted:API_TOKEN]'],
    ['cart-tests', 'totals', 'failed', 'Expected: 3\nReceived: 2']
  ]);
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(SECRET, 'u'));
  const runs = path.join(repo.root, '.git', 'singularity-flow', 'test-runs', 'web');
  for (const name of await readdir(runs)) assert.equal((await readFile(path.join(runs, name), 'utf8')).includes(SECRET), false, 'the private run record keeps redacted messages');
});
