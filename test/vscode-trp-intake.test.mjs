import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_INTAKE_FORM, intakeCommand, intakeHtml, intakePlanInputKey,
  intakeProblems, storyPreflightCommand
} from '../apps/vscode/src/views/intake-form.ts';
import {
  testRecoveryArguments, testRecoveryCanConfirm, testRecoveryChoiceSupported, testRecoveryConfirmation,
  testRecoveryHtml, testRecoveryProblems
} from '../apps/vscode/src/views/test-recovery-intake.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const capability = (overrides = {}) => ({
  schemaVersion: 1, enabled: true, ready: true, planDigest: digest,
  supportedBaselineDispositions: ['fix'],
  supportedExecutionModes: ['changed-and-affected', 'all-configured'],
  supportedBaselineScopes: ['reuse'],
  route: 'feature-coding',
  repositories: [{
    repository: 'service', baseCommit: 'base-123', baselineStatus: 'passed',
    baselineScope: 'all-configured', environment: 'macOS / Node',
    requestedScope: 'changed-and-affected', effectiveScope: 'selected-tests',
    commands: ['test-service'], selectedTests: ['test/payment.test.mjs'],
    reasons: ['changed executable test'], exclusions: [], unknowns: [],
    tools: [{ id: 'unit', framework: 'Node', runner: 'node', interpreter: '/usr/local/bin/node',
      cwd: '/service', adapter: 'node-tap', reportPath: '.sflow/results/unit.tap',
      source: 'explicitly-configured', status: 'available' }]
  }],
  mandatoryChecks: ['release: all configured unit tests'],
  legalActions: [{ id: 'inspect-plan', label: 'Inspect exact plan', command: 'story', args: ['test-policy', 'plan'] }],
  ...overrides
});
const story = (overrides = {}) => ({
  ...EMPTY_INTAKE_FORM, shape: 'story', tracker: 'none',
  id: 'TRP-1', title: 'Implement test policy', description: 'Preserve exact evidence.',
  workType: 'feature', storyWorkflows: [{ id: 'feature', label: 'Feature', phases: ['code'] }],
  baseBranch: 'main', basePreflightPassed: true, targetRepository: '/service',
  ...overrides
});

test('legacy, disabled and unsupported-version engines keep existing intake unchanged', () => {
  for (const testRecovery of [null, capability({ enabled: false }), capability({ schemaVersion: 2 })]) {
    const form = story({ testRecovery });
    assert.deepEqual(testRecoveryArguments(form, true), []);
    assert.deepEqual(testRecoveryProblems(form), []);
    assert.doesNotMatch(intakeHtml(form), /data-test-recovery/);
    assert.ok(!intakeCommand(form).includes('--test-policy-confirm'));
    assert.deepEqual(intakeProblems(form), []);
  }
});

test('default selections do not authorize Start, and a digest is sent only after exact confirmation', () => {
  const form = story({ testRecovery: capability() });
  assert.equal(testRecoveryCanConfirm(form), true);
  assert.match(intakeProblems(form).join(' '), /Explicitly confirm/);
  assert.ok(!intakeCommand(form).includes('--test-policy-confirm'));
  assert.match(intakeHtml(form), /data-test-recovery-confirm="sha256:[a-f0-9]{64}">/);
  assert.match(intakeHtml(form), /data-submit="start" disabled/);
  const confirmed = { ...form, testRecoveryConfirmedDigest: digest };
  assert.deepEqual(intakeProblems(confirmed), []);
  const argv = intakeCommand(confirmed);
  assert.equal(argv[argv.indexOf('--test-policy-confirm') + 1], digest);
  assert.ok(!storyPreflightCommand(confirmed).includes('--test-policy-confirm'), 'a read cannot carry consent');
  assert.ok(storyPreflightCommand(confirmed).includes('--test-baseline-disposition'));
});

test('existing-failure disposition, ongoing execution scope and baseline scope stay independent', () => {
  const form = story({ testRecovery: capability() });
  const all = { ...form, testExecutionMode: 'all-configured' };
  assert.equal(all.testBaselineDisposition, 'fix');
  assert.equal(all.testBaselineScope, 'reuse');
  assert.deepEqual(testRecoveryArguments(all), [
    '--test-baseline-disposition', 'fix', '--test-execution-mode', 'all-configured',
    '--test-baseline-scope', 'reuse'
  ]);
  const html = intakeHtml(all);
  assert.match(html, /name="testBaselineDisposition"/);
  assert.match(html, /name="testExecutionMode"/);
  assert.match(html, /name="testBaselineScope"/);
  assert.match(html, /value="targeted" disabled/);
  assert.match(html, /name="testBaselineScope"[^>]+value="all-configured" disabled/);
});

test('unsupported or unreviewable failure acceptance is visibly unavailable and cannot confirm', () => {
  const form = story({ testRecovery: capability() });
  assert.equal(testRecoveryChoiceSupported(form, 'testBaselineDisposition', 'accept-known-failures'), false);
  assert.equal(testRecoveryChoiceSupported(form, 'testRecoveryConfirmedDigest', digest), false);
  assert.match(intakeHtml(form), /value="accept-known-failures" disabled/);
  const forged = { ...form, testBaselineDisposition: 'accept-known-failures', testRecoveryConfirmedDigest: digest };
  assert.equal(testRecoveryCanConfirm(forged), false);
  assert.ok(!intakeCommand(forged).includes('--test-policy-confirm'));
  const missingEligibility = { ...form, testRecovery: capability({ supportedBaselineDispositions: ['fix', 'accept-known-failures'] }) };
  assert.equal(testRecoveryChoiceSupported(missingEligibility, 'testBaselineDisposition', 'accept-known-failures'), false);
});

test('changed engine plan, malformed digest and missing readiness never reuse confirmation', () => {
  for (const preview of [
    capability({ planDigest: `sha256:${'b'.repeat(64)}` }),
    capability({ planDigest: 'not-a-digest' }), capability({ ready: false }),
    capability({ ready: undefined })
  ]) {
    const form = story({ testRecovery: preview, testRecoveryConfirmedDigest: digest });
    assert.ok(intakeProblems(form).length > 0);
    assert.ok(!intakeCommand(form).includes('--test-policy-confirm'));
  }
});

test('a delayed checkbox event cannot confirm the current plan or manufacture consent', () => {
  const form = story({ testRecovery: capability() });
  assert.equal(testRecoveryConfirmation(form, digest, true), digest);
  for (const value of [false, 'true', 1, null, undefined]) {
    assert.equal(testRecoveryConfirmation(form, digest, value), null);
  }
  assert.equal(testRecoveryConfirmation(form, `sha256:${'b'.repeat(64)}`, true), null);
  assert.equal(testRecoveryConfirmation({ ...form, testRecovery: null }, digest, true), null);
  assert.equal(testRecoveryConfirmation({ ...form, testRecovery: capability({ ready: false }) }, digest, true), null);
});

test('every relevant form edit changes the host confirmation binding', () => {
  const form = story({ testRecovery: capability(), testRecoveryConfirmedDigest: digest });
  for (const change of [
    { id: 'TRP-2' }, { baseBranch: 'release' }, { workType: 'bugfix' },
    { targetRepository: '/another' }, { targetWorkspace: '/workspace' },
    { tracker: 'jira' }, { key: 'JIRA-2' }, { description: 'Changed scope' },
    { acceptanceCriteria: 'More required behavior' }, { title: 'Changed title' },
    { referenceRepositories: [{ id: 'ref', repository: 'https://example.test/ref.git', branch: 'main' }] },
    { storyAttachments: [{ sourcePath: '/brief.md', name: 'Brief', displayName: 'brief.md' }] },
    { testExecutionMode: 'all-configured' }, { testBaselineDisposition: 'accept-known-failures' },
    { testBaselineScope: 'targeted' }
  ]) assert.notEqual(intakePlanInputKey(form), intakePlanInputKey({ ...form, ...change }));
  assert.equal(intakePlanInputKey(form), intakePlanInputKey({ ...form, busy: true }), 'render state is not a policy edit');
});

test('preview shows selected cohort, tools, later requirements, unknowns and read-only legal actions safely', () => {
  const html = testRecoveryHtml(story({ testRecovery: capability({ repositories: [{
    ...capability().repositories[0], baselineStatus: 'Existing failures unknown',
    unknowns: ['integration coverage'], failures: [{ id: '<script>alert(1)</script>', suite: 'legacy' }],
    decisionExpiry: '2026-10-30T00:00:00Z'
  }], legalActions: [{ id: 'repair', label: '<img onerror=alert(1)>', command: 'recover', args: ['TRP-1'] }] }) }));
  for (const expected of ['Existing failures unknown', 'integration coverage', 'test/payment.test.mjs',
    '/usr/local/bin/node', 'node-tap', 'explicitly-configured', 'release: all configured unit tests',
    '2026-10-30T00:00:00Z', '&lt;script&gt;', '&lt;img onerror=alert(1)&gt;']) assert.ok(html.includes(expected));
  assert.doesNotMatch(html, /<script>|<img|data-command|data-action/);
});

test('accepted failures and observed unaccepted failures are not rendered as passing or unknown', () => {
  for (const [disposition, expected] of [
    ['accepted-pre-existing-test-failures', /Accepted pre-existing test failures — observed tests remain failed/],
    ['pre-existing-test-failures-require-decision', /Observed pre-existing test failures require repair/],
    ['not-verified', /Existing failures unknown/]
  ]) {
    const html = intakeHtml(story({ baseTestReadiness: { schemaVersion: 1, repositories: [{
      repository: 'service', baseCommit: 'abc', status: 'failing-tests', scope: 'dependency-test',
      testToolStatus: 'available', disposition,
      tools: [{ id: 'unit', launcher: 'node', adapter: 'tap', status: 'available',
        counts: { discovered: 8, passed: 7, failed: 1, skipped: 0 } }]
    }] } }));
    assert.match(html, expected);
    assert.match(html, /7 passed, 1 failed/);
    assert.doesNotMatch(html, /The selected test run had no observed failures/);
  }
});

test('non-Story intake does not expose or apply a Story test policy', () => {
  const form = story({ shape: 'epic', testRecovery: capability(), goal: 'Improve delivery' });
  assert.doesNotMatch(intakeHtml(form), /data-test-recovery/);
  assert.ok(!intakeCommand(form).includes('--test-baseline-disposition'));
});
