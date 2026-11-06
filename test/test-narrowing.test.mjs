/**
 * Narrowed test runs [TCE:REQ-020]: what counts as narrowing, the gate rule, what a decision covers
 * and how it replays. The whole-Story walks are test/test-narrowing-flow.
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  addedPathNarrowing, commandFilters, focusedDeclarations, gateNarrowing, narrowingCovers, narrowingFacts, narrowingWords, observedNarrowing, pathNarrowingWords, pathOperands, recordTestNarrowing,
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

test('the paths a command names are read per runner, and an option\'s value is not one', () => {
  const read = (...tokens) => { const { runner, operands, unsure } = pathOperands(tokens); return [runner, operands, unsure]; };
  assert.deepEqual(read('vitest', 'run', 'src'), ['vitest', ['src'], []]);
  assert.deepEqual(read('vitest', 'run', '--reporter', 'verbose', '--config=x.js'), ['vitest', [], []]);
  assert.deepEqual(read('vitest', '--dir', 'src'), ['vitest', ['src'], []]);
  assert.deepEqual(read('jest', 'src/one', '--json', '--outputFile', 'r.json'), ['jest', ['src/one'], []]);
  assert.deepEqual(read('jest', '--bail', '1'), ['jest', [], ['1']], 'an option this cannot read may be taking the word');
  assert.deepEqual(read('vitest', 'run', '--project', 'unit', '-t', 'adds'), ['vitest', [], []], 'a selecting option\'s value is its own, and read as a filter');
  assert.deepEqual(read('npx', '--no-install', 'playwright', 'test', 'e2e/login'), ['playwright', ['e2e/login'], []]);
  assert.deepEqual(read('python3', '-B', '-m', 'pytest', '-p', 'no:cacheprovider', 'tests/unit', '--junitxml=r.xml'), ['pytest', ['tests/unit'], []]);
  assert.deepEqual(read('go', 'test', '-json', './...'), ['go', [], []], './... is every package');
  assert.deepEqual(read('go', 'test', './pkg/...'), ['go', ['pkg/...'], []]);
  assert.deepEqual(read('node', '--test', 'test/unit'), ['node', ['test/unit'], []]);
  assert.equal(pathOperands(['node', 'scripts/run.js']), null);
  assert.equal(pathOperands(['npm', 'test']), null);
  assert.equal(pathOperands(['eslint', 'src']), null);
});

/** A repository with the base commit's scripts and tests, then the Story's script. */
async function pathRepository(t, files, script) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q'], { cwd: root });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  run('git', ['add', '.'], { cwd: root });
  run('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base'], { cwd: root });
  const baseCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  const manifest = JSON.parse(files['package.json'] ?? '{}');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ ...manifest, scripts: { ...manifest.scripts, ...script } }));
  const scripts = Object.entries(script).map(([name, text]) => ({ source: `package.json#scripts.${name}`, text }));
  return { root, baseCommit, scripts };
}
const unitCommand = { id: 'unit', kind: 'test', argv: ['npm', 'test', '--', '--reporter=json'], workingDirectory: '.', affectedRoots: ['.'], result: { adapter: 'vitest-json', path: 'r.json' } };

test('a path the Story adds that drops nothing is recorded and refused by nothing; one that drops tests is a filter a person decides', async (t) => {
  const base = { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), 'src/a.test.js': '', 'src/deep/b.test.js': '' };
  // bin-opr: every test under src. Recorded, shown, no reason to refuse.
  const fine = await pathRepository(t, base, { test: 'vitest run src' });
  const clean = await narrowingFacts(fine.root, unitCommand, { scripts: fine.scripts, baseCommit: fine.baseCommit, inferred: true });
  assert.deepEqual(clean.filters, []);
  assert.deepEqual(clean.paths.map((entry) => [entry.operands, entry.tests, entry.droppedCount]), [[['src'], 2, 0]]);
  const recorded = observedNarrowing(clean, { discovered: 2, passed: 2, skipped: 0 });
  assert.deepEqual(recorded.reasons, []);
  assert.deepEqual(recorded.paths.map((entry) => entry.operands), [['src']]);
  assert.match(pathNarrowingWords(recorded.paths[0]), /Every test file it ran at the base commit \(2\) is still selected, so none are dropped/u);

  // jest src/one: one file left out, which a person decides like any filter.
  const narrow = await pathRepository(t, { ...base, 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'src/one/c.test.js': '' }, { test: 'jest src/one' });
  const facts = await narrowingFacts(narrow.root, unitCommand, { scripts: narrow.scripts, baseCommit: narrow.baseCommit, inferred: true });
  assert.deepEqual(facts.filters.map((entry) => [entry.option, entry.value, entry.source, entry.droppedCount]), [['path', 'src/one', 'package.json#scripts.test', 2]]);
  const observed = observedNarrowing(facts, { discovered: 1, passed: 1, skipped: 0 });
  assert.deepEqual(observed.reasons, ['filter']);
  assert.match(narrowingWords(observed), /path src\/one \(package\.json#scripts\.test\) leaves out 2 of the 3 test files of the base commit: src\/a\.test\.js, src\/deep\/b\.test\.js/u);
  // The same paths in a re-pin a person accepted are not asked of them again; a further one is.
  const seen = await narrowingFacts(narrow.root, unitCommand, { scripts: narrow.scripts, baseCommit: narrow.baseCommit, inferred: true, acceptedPaths: [{ runner: 'jest', operands: ['src/one'] }] });
  assert.deepEqual(seen.filters, []);
  const further = await narrowingFacts(narrow.root, unitCommand, { scripts: narrow.scripts, baseCommit: narrow.baseCommit, inferred: true, acceptedPaths: [{ runner: 'jest', operands: ['src'] }] });
  assert.equal(further.filters.length, 1);
});

test('what is not a dropped test: a path already on the base, a suite the Story added, a browser spec, a test the Story removed, an option\'s value', async (t) => {
  const facts = async (files, script, command = unitCommand) => {
    const { root, baseCommit, scripts } = await pathRepository(t, files, script);
    return addedPathNarrowing(root, command, { scripts, baseCommit, inferred: true });
  };
  const manifest = (scripts) => JSON.stringify({ scripts });
  assert.deepEqual(await facts({ 'package.json': manifest({ test: 'vitest run src' }), 'lib/a.test.js': '' }, { test: 'vitest run src' }), [], 'the team\'s own path');
  assert.deepEqual(await facts({ 'package.json': manifest({ test: 'vitest run' }), 'src/a.test.js': '' }, { 'test:e2e': 'playwright test e2e' }), [], 'the Story added this suite');
  const browser = await facts({ 'package.json': manifest({ test: 'vitest run' }), 'src/a.test.js': '', 'e2e/x.spec.js': "import { test } from '@playwright/test';\n" }, { test: 'vitest run src' });
  assert.equal(browser[0].droppedCount, 0, 'Vitest never ran a Playwright spec, so it did not drop it');
  const option = await facts({ 'package.json': manifest({ test: 'jest' }), 'src/a.test.js': '' }, { test: 'jest --bail 1' });
  assert.deepEqual(option, []);
  // Moved by the Story: the file is gone from the checkout, so the path did not leave it out.
  const moved = await pathRepository(t, { 'package.json': manifest({ test: 'vitest run' }), 'lib/a.test.js': '', 'src/b.test.js': '' }, { test: 'vitest run src' });
  rmSync(path.join(moved.root, 'lib/a.test.js'));
  assert.equal(addedPathNarrowing(moved.root, unitCommand, { scripts: moved.scripts, baseCommit: moved.baseCommit, inferred: true })[0].droppedCount, 0);
  // Mocha looks in ./test by default, so a test file elsewhere was never its to drop.
  const mocha = await facts({ 'package.json': manifest({ test: 'mocha' }), 'test/unit/a.test.js': '', 'test/b.test.js': '', 'src/c.test.js': '' }, { test: 'mocha test/unit' });
  assert.deepEqual(mocha[0].dropped, ['test/b.test.js']);
  // With no base commit to read there is nothing to compare, and nothing is refused.
  const { root, scripts } = await pathRepository(t, { 'package.json': manifest({ test: 'vitest run' }), 'src/a.test.js': '' }, { test: 'vitest run src' });
  assert.deepEqual(addedPathNarrowing(root, unitCommand, { scripts, baseCommit: null, inferred: true }), []);
});

test('a guessed command carrying the path in its argv reads the same; SFlow\'s own node --test file list is no narrowing', async (t) => {
  const manifest = JSON.stringify({ scripts: { test: 'vitest run' } });
  const { root, baseCommit, scripts } = await pathRepository(t, { 'package.json': manifest, 'src/a.test.js': '', 'lib/b.test.js': '' }, { test: 'vitest run src' });
  const carried = { ...unitCommand, argv: ['npx', '--no-install', 'vitest', 'run', 'src', '--reporter=json', '--outputFile=r.json'] };
  const [entry] = addedPathNarrowing(root, carried, { scripts: [], baseCommit, inferred: true });
  assert.deepEqual([entry.source, entry.operands, entry.dropped], ['argv', ['src'], ['lib/b.test.js']]);
  assert.deepEqual(addedPathNarrowing(root, carried, { scripts: [], baseCommit, inferred: false }), [], 'a configured command is a person\'s');
  const nodeFiles = { ...unitCommand, argv: ['node', '--test', 'src/a.test.js'] };
  assert.deepEqual(addedPathNarrowing(root, nodeFiles, { scripts: [], baseCommit, inferred: true }), []);
  const scoped = { ...carried, testScope: { mode: 'new-and-changed', files: ['src/a.test.js'] } };
  assert.deepEqual(addedPathNarrowing(root, scoped, { scripts, baseCommit, inferred: true }), [], 'a person chose this Story\'s test scope');
  // A run the scope left whole is read as any other.
  const left = { ...carried, testScope: { mode: 'new-and-changed', whole: 'the Story changed no test here' } };
  assert.equal(addedPathNarrowing(root, left, { scripts: [], baseCommit, inferred: true })[0].droppedCount, 1);
});
