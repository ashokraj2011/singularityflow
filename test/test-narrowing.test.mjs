/**
 * Narrowed test runs [TCE:REQ-020]: what counts as narrowing, the gate rule, what a decision covers
 * and how it replays. The whole-Story walks are test/test-narrowing-flow.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  commandFilters, focusedDeclarations, gateNarrowing, narrowingCovers, narrowingFacts, observedNarrowing, recordTestNarrowing,
  recordTestNarrowingRevocation, testNarrowingBinding, testNarrowingReplayProblem
} from '../src/test-narrowing.mjs';
import { run } from '../src/util.mjs';

const at = '2026-10-25T10:00:00.000Z';
const pin = { sha256: `sha256:${'a'.repeat(64)}` };
// The pin's first passing run discovered 3 and skipped none.
const facts = (extra = {}) => ({ filters: [], focused: [], baseline: 3, baselineSkipped: 0, ...extra });
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

test('skips the team already had are no narrowing; skip markers the Story added, or more skipped than the baseline, are', () => {
  // Before any passing run there is no baseline: skipped tests with no skip marker added are the team's own.
  assert.deepEqual(observedNarrowing(facts({ baselineSkipped: null }), { discovered: 5, skipped: 2 }).reasons, []);
  assert.deepEqual(observedNarrowing(facts({ baseline: 5, baselineSkipped: 2 }), { discovered: 5, skipped: 2 }).reasons, [], 'as many as the baseline');
  assert.deepEqual(observedNarrowing(facts({ baseline: 5, baselineSkipped: 2 }), { discovered: 5, skipped: 3 }).reasons, ['skipped'], 'one more than it');
  const added = observedNarrowing(facts({ baselineSkipped: null, addedSkips: [{ path: 'test/a.test.mjs', added: 1 }] }), { discovered: 3, skipped: 1 });
  assert.deepEqual([added.reasons, added.addedSkips], [['skipped'], [{ path: 'test/a.test.mjs', added: 1 }]]);
  // A filter or focused test already on the base commit is recorded as standing, never as a reason.
  const standing = { filters: [{ option: '--project', value: 'chromium', source: 'web/package.json#scripts.e2e:ci' }], focused: [] };
  const team = observedNarrowing(facts({ standing }), { discovered: 3, skipped: 0 });
  assert.deepEqual([team.reasons, team.standing], [[], standing]);
});

test('a guessed command that carries its script\'s filter in argv is the team\'s narrowing when a script on the base commit has it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-narrowing-argv-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const commit = (scripts) => {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts }));
    run('git', ['add', '-A'], { cwd: root });
    run('git', ['-c', 'user.name=Narrowing Test', '-c', 'user.email=narrowing@example.test', 'commit', '-qm', 'fixture'], { cwd: root });
    return run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  };
  const command = { workingDirectory: '.', affectedRoots: ['.'], argv: ['npx', '--no-install', 'playwright', 'test', '--project=chromium', '--reporter=json'] };
  const whole = commit({ 'test:e2e': 'npx playwright test' });
  const beside = commit({ 'test:e2e': 'npx playwright test', 'e2e:one': 'npx playwright test --project=chromium' });
  const carried = commit({ 'test:e2e': 'npx playwright test --project=chromium' });
  const on = (baseCommit, inferred = true) => narrowingFacts(root, command, { inferred, baseCommit });
  const standing = await on(carried);
  assert.deepEqual(standing.filters, [], 'already on the base commit');
  assert.deepEqual(standing.standing.filters.map((filter) => [filter.option, filter.value]), [['--project', 'chromium']]);
  assert.deepEqual((await on(whole)).filters.map((filter) => [filter.option, filter.value, filter.source]), [['--project', 'chromium', 'argv']], 'added since the base commit');
  assert.deepEqual((await on(beside)).filters.map((filter) => filter.option), ['--project'], 'another script having it does not make this one the team\'s');
  assert.deepEqual((await on(null)).filters.map((filter) => filter.option), ['--project'], 'no base commit, nothing stands');
  assert.deepEqual((await narrowingFacts(root, { ...command, argv: [...command.argv, '-g', 'cart'] }, { inferred: true, baseCommit: carried })).filters.map((filter) => filter.option),
    ['-g'], 'only what the base commit had stands');
  assert.deepEqual((await narrowingFacts(root, { ...command, argv: ['npx', '--no-install', 'playwright', 'test', '-g', 'cart'] }, { inferred: false, baseCommit: carried })).filters.map((filter) => filter.option),
    ['-g'], 'a written command stands for itself');
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
