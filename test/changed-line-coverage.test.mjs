/**
 * Changed-line coverage [CQF:REQ-031]: of the lines a Story changed, those its tests' coverage reports
 * mark as run, per changed file and per clause, in the review packet and `tests summary`, which the
 * approval card reads. It warns below the minimum and refuses nothing unless a Story enforces it.
 *
 * The Stories here run Node's own test runner, which writes real lcov; no other tool is installed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { normalizeCodeDeliveryPolicy } from '../src/code-delivery-policy.mjs';
import { buildTestSummary, testSummaryText } from '../src/test-summary.mjs';
import { changedLineCoverage, changedLineCoveragePolicy } from '../src/verification/changed-line-coverage.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const W = 'COV-1';
const [AC1, AC2] = [`${W}:AC-001`, `${W}:AC-002`];

const attempt = (commandId, files, extra = {}) => ({ commandId, coverage: { status: 'measured', format: 'lcov', sourcePath: 'coverage/lcov.info', changed: { base: 'b', files } }, ...extra });
const file = (relative, coveredLines, uncoveredLines, inReport = true) => {
  const count = (ranges) => ranges.split(',').filter(Boolean).reduce((sum, part) => { const [from, to = from] = part.split('-').map(Number); return sum + to - from + 1; }, 0);
  return { path: relative, inReport, executable: count(coveredLines) + count(uncoveredLines), covered: count(coveredLines), coveredLines, uncoveredLines };
};

test('changed lines join across a step\'s runs, per file and per clause, and warn below the minimum', () => {
  const clauses = [{ clauseId: AC1, paths: ['src/cart.mjs'] }, { clauseId: AC2, paths: ['src/discount.mjs', 'src/rate.mjs'] }, { clauseId: `${W}:AC-003`, paths: ['docs/x.md'] }];
  const coverage = changedLineCoverage([
    attempt('unit', [file('src/cart.mjs', '1,3', ''), file('src/discount.mjs', '1-3', '4-5,7'), file('src/rate.mjs', '', '', false)]),
    // A second command ran line 7 of the same file: a line counts as run when any run ran it.
    attempt('integration', [file('src/discount.mjs', '7', '4-5')])
  ], { policy: changedLineCoveragePolicy({}), clauses });
  assert.equal(coverage.status, 'measured');
  assert.deepEqual([coverage.covered, coverage.executable, coverage.percent], [6, 8, 75]);
  assert.equal(coverage.below, true);
  assert.deepEqual(coverage.notInReport, ['src/rate.mjs']);
  assert.deepEqual(coverage.files.map((entry) => [entry.path, entry.covered, entry.executable, entry.uncoveredLines]),
    [['src/cart.mjs', 2, 2, ''], ['src/discount.mjs', 4, 6, '4-5'], ['src/rate.mjs', 0, 0, '']]);
  assert.deepEqual(coverage.clauses.map((entry) => [entry.clauseId, entry.covered, entry.executable, entry.below]), [[AC1, 2, 2, false], [AC2, 4, 6, true]]);
  assert.equal(coverage.words, 'Changed-line coverage: 6 of 8 changed lines ran (75%); no test loaded src/rate.mjs. Below the 80% wanted: it warns and refuses nothing.');
  assert.deepEqual(coverage.lines, ['src/cart.mjs: 2 of 2 changed lines ran (100%)', 'src/discount.mjs: 4 of 6 changed lines ran (66.6%); not run: lines 4-5',
    'src/rate.mjs: no test loaded it', `${AC1}: 2 of 2 changed lines ran (100%)`, `${AC2}: 4 of 6 changed lines ran (66.6%); no test loaded src/rate.mjs, below 80%`]);
  // At or above the minimum it says so; the setting may lower it, or turn it off.
  const met = changedLineCoverage([attempt('unit', [file('src/cart.mjs', '1-4', '5')])], { policy: { mode: 'warn', minimum: 80 } });
  assert.equal(met.below, false);
  assert.equal(met.words, 'Changed-line coverage: 4 of 5 changed lines ran (80%). At least the 80% wanted.');
  assert.equal(changedLineCoverage([attempt('unit', [file('src/cart.mjs', '1', '2-5')])], { policy: { mode: 'warn', minimum: 20 } }).below, false);
  assert.equal(changedLineCoverage([attempt('unit', [])], { policy: { mode: 'off', minimum: 80 } }), null);
  assert.equal(changedLineCoverage([], { policy: changedLineCoveragePolicy({}) }), null);
  assert.match(changedLineCoverage([attempt('unit', [file('src/cart.mjs', '1', '2-5')])], { policy: { mode: 'enforce', minimum: 80 } }).words, /publication refuses it\.$/u);
});

test('the setting is warn below 80% unless a workflow sets it, and only its own keys and modes are read', () => {
  assert.deepEqual(changedLineCoveragePolicy({}), { mode: 'warn', minimum: 80 });
  assert.equal(normalizeCodeDeliveryPolicy({}).changedLineCoverage, undefined);
  assert.deepEqual(normalizeCodeDeliveryPolicy({ changedLineCoverage: { mode: 'enforce' } }).changedLineCoverage, { mode: 'enforce', minimum: 80 });
  assert.deepEqual(normalizeCodeDeliveryPolicy({ changedLineCoverage: { minimum: 60 } }).changedLineCoverage, { mode: 'warn', minimum: 60 });
  assert.deepEqual(changedLineCoveragePolicy({ resolution: { codeDelivery: { changedLineCoverage: { mode: 'off', minimum: 80 } } } }), { mode: 'off', minimum: 80 });
  for (const value of [{ mode: 'block' }, { minimum: 101 }, { minimum: 50.5 }, { mode: 'warn', lines: 'all' }, 'warn']) {
    assert.throws(() => normalizeCodeDeliveryPolicy({ changedLineCoverage: value }), /changedLineCoverage/u);
  }
});

test('tests summary carries it in its JSON and its text, under the totals', () => {
  const coverage = changedLineCoverage([attempt('unit', [file('src/discount.mjs', '1-3', '4-5')])], { policy: changedLineCoveragePolicy({}), clauses: [{ clauseId: AC2, paths: ['src/discount.mjs'] }] });
  const summary = buildTestSummary({ scope: { kind: 'story', workId: W, phase: 'implement' }, run: { id: 'TA-1', label: 'Run by publication' },
    entries: [{ receipt: { commandId: 'unit', status: 'passed', tests: { discovered: 1, passed: 1, failed: 0, skipped: 0 } } }], changedLineCoverage: coverage });
  assert.equal(summary.changedLineCoverage.status, 'measured');
  const text = testSummaryText(summary);
  assert.match(text, /Changed-line coverage: 3 of 5 changed lines ran \(60%\)\. Below the 80% wanted: it warns and refuses nothing\.\n {2}src\/discount\.mjs: 3 of 5 changed lines ran \(60%\); not run: lines 4-5\n {2}COV-1:AC-002: 3 of 5/u);
  assert.equal('changedLineCoverage' in buildTestSummary({ scope: { kind: 'story', workId: W, phase: 'implement' }, run: null, entries: [] }), false);
});

/** A quick-fix Story at its code step whose npm test writes lcov through Node's own runner. */
async function storyAtCode(t, { codeDelivery = null, coverage = true } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-changed-lines-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...isolatedTestEnvironment(path.join(base, 'machine')), NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Coverage Tester',
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Coverage Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'coverage.tester@example.invalid' };
  delete env.NODE_TEST_CONTEXT;
  const run = (command, args, { cwd = root } = {}) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(180_000) });
  const must = (command, args, options) => {
    const result = run(command, args, options);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  const write = async (relative, text) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  };
  must('git', ['init', '-q', '-b', 'main', root], { cwd: base });
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: {
    test: coverage ? 'mkdir -p coverage && node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=coverage/lcov.info' : 'node --test' } }));
  await write('.gitignore', 'coverage/\n');
  await write('src/cart.mjs', 'export const items = (list) => list.length;\n');
  await write('test/cart.test.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { items } from '../src/cart.mjs';\ntest('counts items', () => assert.equal(items([1]), 1));\n");
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  config.repositoryReadiness = { ...(config.repositoryReadiness ?? {}), requiredBeforeStory: false };
  if (codeDelivery) config.codeDelivery = { ...(config.codeDelivery ?? {}), ...codeDelivery };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], { cwd: base });
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', W, '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Remove and discount items', '--description', 'Removing an item lowers the count; a discount halves a price.');
  sflow('prepare', 'intake');
  const item = path.join(root, 'singularity/work-items', W);
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [`# ${W} — Quick fix scope and plan`, '', '## Problem and fix', '', 'Removing an item must lower the count; a discount must halve a price.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${AC1}] | Removing one of two items leaves one. |`, `| [${AC2}] | A discount halves a price and refuses a negative one. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    `| \`${AC1}\` | \`src/cart.mjs\` | \`test/cart.test.mjs\` | modified | The test reads 1. |`,
    `| \`${AC2}\` | \`src/discount.mjs\` | \`test/discount.test.mjs\` | new | The test reads 5. |`, '', '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  sflow('submit', 'intake'); sflow('approve', 'intake', '--yes'); sflow('resume', W); sflow('phase', 'begin', 'implement', '--json');
  await write('src/cart.mjs', `// @clause:${AC1} removing an item lowers the count\nexport const items = (list) => list.length;\nexport const remove = (list, item) => list.filter((entry) => entry !== item);\n`);
  await write('src/discount.mjs', [`// @clause:${AC2} a discount halves a price and refuses a negative one`, 'export const discount = (price) => {', '  if (price < 0) {',
    "    throw new Error('A price is never negative');", '  }', '  return price / 2;', '};', ''].join('\n'));
  await write('test/cart.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';", "import { items, remove } from '../src/cart.mjs';",
    "test('counts items', () => assert.equal(items([1]), 1));", `// @ac:${AC1}`, "test('removes an item', () => { assert.equal(items(remove([1, 2], 2)), 1); });", ''].join('\n'));
  // The negative branch never runs.
  const discountTest = (negative) => ["import test from 'node:test';", "import assert from 'node:assert/strict';", "import { discount } from '../src/discount.mjs';",
    `// @ac:${AC2}`, "test('halves a price', () => { assert.equal(discount(10), 5); });",
    ...(negative ? ["test('refuses a negative price', () => { assert.throws(() => discount(-1), /never negative/u); });"] : []), ''].join('\n');
  await write('test/discount.test.mjs', discountTest(false));
  sflow('prepare', 'implement');
  const publish = () => run(process.execPath, [cli, '--no-model', 'phase', 'publish', 'implement']);
  const json = (...args) => JSON.parse(sflow(...args, '--json').stdout);
  return { root, item, sflow, json, publish, write, discountTest };
}

test('a Story whose tests write lcov shows its changed lines per file and per clause, warns below 80% and refuses nothing', slowLane({ timeout: 600_000 }), async (t) => {
  const story = await storyAtCode(t);
  const published = story.publish();
  assert.equal(published.status, 0, published.stdout + published.stderr);
  const summary = story.json('tests', 'summary', '--work-id', W, '--phase', 'implement');
  const coverage = (summary.data ?? summary).changedLineCoverage;
  assert.equal(coverage.status, 'measured', JSON.stringify(coverage));
  assert.equal(coverage.formats[0], 'lcov');
  const discount = coverage.files.find((entry) => entry.path === 'src/discount.mjs');
  assert.equal(discount.uncoveredLines, '4-5');
  assert.equal(coverage.files.find((entry) => entry.path === 'src/cart.mjs').uncoveredLines, '');
  assert.deepEqual(coverage.clauses.map((entry) => [entry.clauseId, entry.below]), [[AC1, false], [AC2, true]]);
  assert.equal(coverage.below, true);
  assert.match(coverage.words, /Below the 80% wanted: it warns and refuses nothing\.$/u);
  // The text says the same, and so does the review packet the approval reads.
  assert.match(story.sflow('tests', 'summary', '--work-id', W, '--phase', 'implement').stdout, /Changed-line coverage: \d+ of \d+ changed lines ran[\s\S]*src\/discount\.mjs: \d+ of \d+ changed lines ran \([\d.]+%\); not run: lines 4-5[\s\S]*COV-1:AC-002: .*below 80%/u);
  const review = story.json('phase', 'show', 'implement');
  assert.deepEqual((review.data ?? review).changedLineCoverage?.files, coverage.files);
  // The committed attempt keeps the lcov report beside its test report.
  const attemptFolder = path.join(story.item, 'context/code-delivery/tests/attempts/implement');
  const [name] = (await (await import('node:fs/promises')).readdir(attemptFolder)).filter((entry) => entry.endsWith('.json'));
  const recorded = JSON.parse(await readFile(path.join(attemptFolder, name), 'utf8'));
  assert.match(await readFile(path.join(story.root, recorded.coverage.report.path), 'utf8'), /SF:src\/discount\.mjs/u);
});

test('a Story that enforces a minimum refuses publication below it on a measured run, and publishes once its tests run the lines', slowLane({ timeout: 600_000 }), async (t) => {
  const story = await storyAtCode(t, { codeDelivery: { changedLineCoverage: { mode: 'enforce', minimum: 90 } } });
  const refused = story.publish();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /cannot publish: Changed-line coverage: \d+ of \d+ changed lines ran \([\d.]+%\)\. This Story's codeDelivery\.changedLineCoverage enforces at least 90%\. src\/discount\.mjs lines 4-5 did not run/u);
  await story.write('test/discount.test.mjs', story.discountTest(true));
  const published = story.publish();
  assert.equal(published.status, 0, published.stdout + published.stderr);
  const coverage = (story.json('tests', 'summary', '--work-id', W, '--phase', 'implement').data ?? {}).changedLineCoverage
    ?? story.json('tests', 'summary', '--work-id', W, '--phase', 'implement').changedLineCoverage;
  assert.equal(coverage.below, false, JSON.stringify(coverage));
  assert.equal(coverage.files.find((entry) => entry.path === 'src/discount.mjs').uncoveredLines, '');
});

test('a test that asserts nothing warns at publication, in the review and its packet, and the step still publishes [CQF:REQ-032]', slowLane({ timeout: 600_000 }), async (t) => {
  const story = await storyAtCode(t);
  await story.write('test/discount.test.mjs', ["import test from 'node:test';", "import { discount } from '../src/discount.mjs';", `// @ac:${AC2}`,
    "test('halves a price', () => { discount(10); });", ''].join('\n'));
  const published = story.publish();
  assert.equal(published.status, 0, published.stdout + published.stderr);
  assert.match(published.stderr, /Assertion check: 1 test asserts nothing it tests \('halves a price' at test\/discount\.test\.mjs:4\); .*It warns and refuses nothing\./u);
  const review = story.json('phase', 'show', 'implement');
  const check = (review.data ?? review).testEvidence.assertionCheck;
  assert.equal(check.mode, 'warn');
  assert.deepEqual(check.inadequate.map((entry) => [entry.path, entry.name, entry.adequacy, entry.clauseIds]), [['test/discount.test.mjs', 'halves a price', 'missing', [AC2]]]);
  assert.match(story.sflow('phase', 'show', 'implement').stderr, /Assertion check: 1 test asserts nothing it tests/u);
  // Each criterion says how many tests prove it and whether each asserts, in the review and the summary the approval card reads [CQF:REQ-033].
  const proof = (review.data ?? review).testEvidence.acceptance.proof;
  assert.deepEqual(proof.map((entry) => entry.words), [`${AC1}: 1 test proves it; it asserts`, `${AC2}: 1 test proves it; 'halves a price' asserts nothing`]);
  const summary = story.json('tests', 'summary', '--work-id', W, '--phase', 'implement');
  assert.deepEqual((summary.data ?? summary).criterionProof, proof);
});

test('without a coverage report, coverage not measured is shown and nothing refuses, even where a minimum is enforced [CQF:REQ-034]', slowLane({ timeout: 600_000 }), async (t) => {
  const story = await storyAtCode(t, { codeDelivery: { changedLineCoverage: { mode: 'enforce', minimum: 90 } }, coverage: false });
  const published = story.publish();
  assert.equal(published.status, 0, published.stdout + published.stderr);
  const summary = story.json('tests', 'summary', '--work-id', W, '--phase', 'implement');
  const coverage = (summary.data ?? summary).changedLineCoverage;
  assert.equal(coverage.status, 'not-measured');
  assert.match(coverage.words, /^Coverage not measured: no test command of this step wrote a coverage report SFlow reads \(the one its coverage names, or one in a usual place such as coverage\/lcov\.info or target\/site\/jacoco\/jacoco\.xml\)\. It refuses nothing\.$/u);
  assert.match(story.sflow('tests', 'summary', '--work-id', W, '--phase', 'implement').stdout, /\nCoverage not measured: /u);
  const review = story.json('phase', 'show', 'implement');
  assert.equal((review.data ?? review).changedLineCoverage.status, 'not-measured');
  assert.match(story.sflow('phase', 'show', 'implement').stderr, /Coverage not measured: /u);
  // The attempt records nothing about coverage: no report was there.
  const attemptFolder = path.join(story.item, 'context/code-delivery/tests/attempts/implement');
  const { readdir } = await import('node:fs/promises');
  for (const name of (await readdir(attemptFolder)).filter((entry) => entry.endsWith('.json'))) {
    assert.equal(JSON.parse(await readFile(path.join(attemptFolder, name), 'utf8')).coverage, undefined);
  }
});

test("an earlier run's report that this run did not write reads as not measured, with why", () => {
  const coverage = changedLineCoverage([{ commandId: 'unit', coverage: { status: 'not-measured', sourcePath: 'coverage/lcov.info',
    reason: "coverage/lcov.info was not written by this run, so it is an earlier run's" } }], { policy: changedLineCoveragePolicy({}) });
  assert.deepEqual(coverage, { status: 'not-measured', mode: 'warn', minimum: 80, reasons: ["unit: coverage/lcov.info was not written by this run, so it is an earlier run's"],
    words: "Coverage not measured: unit: coverage/lcov.info was not written by this run, so it is an earlier run's. It refuses nothing." });
  // A run that measured, but not against the Story's changes, says that instead.
  assert.match(changedLineCoverage([{ commandId: 'unit', coverage: { status: 'measured', format: 'lcov', changed: { base: 'b', unavailable: 'Changes since b failed' } } }],
    { policy: changedLineCoveragePolicy({}) }).words, /^Coverage not measured: unit: its report could not be read against the Story's changes \(Changes since b failed\)\. It refuses nothing\.$/u);
});
