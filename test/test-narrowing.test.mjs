/**
 * Narrowed test runs [TCE:REQ-020]: what counts as narrowing, the gate rule, what a decision covers
 * and how it replays. The whole-Story walks are test/test-narrowing-flow.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commandFilters, focusedDeclarations, gateNarrowing, narrowingCovers, observedNarrowing, recordTestNarrowing,
  recordTestNarrowingRevocation, testNarrowingBinding, testNarrowingReplayProblem
} from '../src/test-narrowing.mjs';

const at = '2026-10-25T10:00:00.000Z';
const pin = { sha256: `sha256:${'a'.repeat(64)}` };
const facts = (extra = {}) => ({ filters: [], focused: [], baseline: 3, ...extra });
const attempt = (narrowing, extra = {}) => ({ attemptId: 'TA-0123456789abcdef0123', commandId: 'unit', status: 'passed', pin, narrowing, ...extra });

test('filters are read per runner, from argv and the pinned scripts, and reporter arguments are not filters', () => {
  const scripts = [{ source: 'package.json#scripts.test', text: 'docker build -t app . && npm run unit' },
    { source: 'package.json#scripts.unit', text: 'jest --shard=1/3' }];
  assert.deepEqual(commandFilters(['npm', 'test', '--', '-t', 'adds'], scripts).map((entry) => `${entry.option}=${entry.value}@${entry.source}`),
    ['-t=adds@argv', '--shard=1/3@package.json#scripts.unit'], 'arguments after -- reach the runner at the end of the chain');
  assert.deepEqual(commandFilters(['python3', '-B', '-m', 'pytest', '-p', 'no:cacheprovider', '-m', 'fast', '--junitxml=r.xml']).map((entry) => entry.option), ['-m']);
  assert.deepEqual(commandFilters(['./mvnw', '-pl', 'api', '-Dtest=OneTest', 'test']).map((entry) => `${entry.option}=${entry.value}`), ['-Dtest=OneTest']);
  assert.deepEqual(commandFilters(['npm', 'test', '--', '--json', '--outputFile', '.sflow/results/node-tests.json'], [{ source: 'package.json#scripts.test', text: 'jest' }]), []);
  assert.deepEqual(commandFilters(['npx', 'playwright', 'test', '--project=chromium']), [], 'a project a person configured is their choice');
  assert.equal(commandFilters(['npx', 'playwright', 'test', '--project=chromium'], [], { inferred: true })[0].option, '--project');
});

test('focused declarations are found in code, not in comments or strings', () => {
  const found = focusedDeclarations("// test.only('no')\nconst s = 'it.only(';\ndescribe.only('suite', () => {\n  fit('one', () => {});\n  obj.fit('no');\n});\n");
  assert.deepEqual(found, [{ line: 3, name: 'suite' }, { line: 4, name: 'one' }]);
});

test('a narrowed run is refused naming each reason, unless an acceptance covers the same or a smaller narrowing', () => {
  const workflow = { workItem: { id: 'W-1' }, testNarrowings: [] };
  const phase = { id: 'implement' };
  assert.equal(gateNarrowing(workflow, phase, attempt(observedNarrowing(facts(), { discovered: 3, skipped: 0 })), { at }), null, 'not narrowed');
  const skipped = attempt(observedNarrowing(facts(), { discovered: 3, skipped: 1 }));
  assert.throws(() => gateNarrowing(workflow, phase, skipped, { at }), (error) => {
    assert.equal(error.code, 'CODE_TEST_NARROWED');
    assert.deepEqual(error.details.testNarrowing.reasons, ['skipped']);
    assert.match(error.details.testNarrowing.command, /^singularity-flow decision test-narrowing W-1 --phase implement --command unit /u);
    return true;
  });
  assert.equal(gateNarrowing(workflow, phase, skipped, { at, skippedAccepted: true }), null, 'a skip the test-policy agreement accepted is its own');
  const decision = recordTestNarrowing(workflow, { phaseId: 'implement', attempt: skipped, reason: 'The device case cannot run on laptops.',
    actor: 'lead', authorityGroup: 'engineering-reviewers', at });
  assert.deepEqual(gateNarrowing(workflow, phase, skipped, { at }), testNarrowingBinding(decision));
  // Wider: one more skipped test, a new filter, a larger shortfall, or another pin.
  for (const wider of [observedNarrowing(facts(), { discovered: 3, skipped: 2 }),
    observedNarrowing(facts({ filters: [{ option: '-k', value: 'fast', source: 'argv' }] }), { discovered: 3, skipped: 1 }),
    observedNarrowing(facts(), { discovered: 2, skipped: 1 })]) {
    assert.throws(() => gateNarrowing(workflow, phase, attempt(wider), { at }), /TNR-001 accepted a smaller narrowing of this pin/u);
  }
  assert.throws(() => gateNarrowing(workflow, phase, { ...skipped, pin: { sha256: `sha256:${'b'.repeat(64)}` } }, { at }), { code: 'CODE_TEST_NARROWED' });
  assert.ok(narrowingCovers(decision.narrowing, observedNarrowing(facts(), { discovered: 4, skipped: 0 })), 'a smaller narrowing is covered');
  recordTestNarrowingRevocation(workflow, { narrowingId: 'TNR-001', reason: 'The device case runs on CI again now.', actor: 'lead', authorityGroup: 'g', at });
  assert.throws(() => gateNarrowing(workflow, phase, skipped, { at }), /TNR-001 was revoked/u);
});

test('only a passing narrowed run can be accepted, with a reason and an expiry from today on', () => {
  const workflow = { testNarrowings: [] };
  const common = { phaseId: 'implement', reason: 'The device case cannot run on laptops.', actor: 'lead', authorityGroup: 'g', at };
  assert.throws(() => recordTestNarrowing(workflow, { ...common, attempt: attempt(observedNarrowing(facts(), { discovered: 3, skipped: 1 }), { status: 'failed' }) }),
    { code: 'TEST_NARROWING_NOT_ELIGIBLE' });
  assert.throws(() => recordTestNarrowing(workflow, { ...common, attempt: attempt(observedNarrowing(facts(), { discovered: 3, skipped: 0 })) }),
    /was not narrowed/u);
  const narrowed = attempt(observedNarrowing(facts(), { discovered: 3, skipped: 1 }));
  assert.throws(() => recordTestNarrowing(workflow, { ...common, attempt: narrowed, reason: 'short' }), { code: 'TEST_NARROWING_INVALID' });
  assert.throws(() => recordTestNarrowing(workflow, { ...common, attempt: narrowed, expires: '2026-10-24' }), { code: 'TEST_NARROWING_INVALID' });
  assert.equal(recordTestNarrowing(workflow, { ...common, attempt: narrowed, expires: '2026-10-25' }).expiresAt, '2026-10-25T23:59:59.999Z');
});

test('a narrowed run replays only with the acceptance it was let through by, while it governs', () => {
  const workflow = { testNarrowings: [] };
  const narrowed = attempt(observedNarrowing(facts(), { discovered: 3, skipped: 1 }));
  const options = { phaseId: 'implement', at };
  assert.match(testNarrowingReplayProblem(workflow, {}, narrowed, options), /ran narrowed \(1 test\(s\) skipped\) and no test-narrowing decision covers it/u);
  const decision = recordTestNarrowing(workflow, { phaseId: 'implement', attempt: narrowed, reason: 'The device case cannot run on laptops.',
    expires: '2026-10-26', actor: 'lead', authorityGroup: 'g', at });
  const execution = { testNarrowing: testNarrowingBinding(decision) };
  assert.equal(testNarrowingReplayProblem(workflow, execution, narrowed, options), null);
  assert.match(testNarrowingReplayProblem(workflow, execution, narrowed, { ...options, at: '2026-10-27T00:00:00.000Z' }), /TNR-001 is expired/u);
  assert.match(testNarrowingReplayProblem(workflow, { testNarrowing: { ...execution.testNarrowing, sha256: `sha256:${'0'.repeat(64)}` } }, narrowed, options),
    /not recorded on the Story with these bytes/u);
  assert.equal(testNarrowingReplayProblem(workflow, {}, attempt(observedNarrowing(facts(), { discovered: 3, skipped: 0 })), options), null);
  // Every test skipped: no test executed, so the run is a test-run risk's to judge, never a narrowed pass.
  const none = attempt(observedNarrowing(facts(), { discovered: 3, skipped: 3 }), { status: 'failed' });
  assert.equal(testNarrowingReplayProblem(workflow, { testRunRisk: { id: 'TRR-001' } }, none, options), null);
  assert.equal(gateNarrowing({ testNarrowings: [] }, { id: 'implement' }, none, { at }), null);
});
