/**
 * A test command's coverage report is kept beside its test report and goes with its attempt [CQF:REQ-030].
 *
 * The lcov report here is Node's own runner's, made by a real run. The Cobertura, JaCoCo and Istanbul
 * reports are recorded in each tool's documented form: no tool that writes them is installed here.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeExternalCommand } from '../src/external-command-policy.mjs';
import { admitTestAttempts, recordTestAttempt, stepAttempts } from '../src/verification/attempts.mjs';
import { capturedCoverage, changedLinesFromPatch, coverageReportsBefore, DEFAULT_COVERAGE_REPORTS, lineRanges, rangeLines, readCoverageReport }
  from '../src/verification/coverage-reports.mjs';

const GIT_ENV = { ...process.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Coverage Tester',
  GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'coverage.tester@example.invalid' };
delete GIT_ENV.NODE_TEST_CONTEXT;
const git = (root, ...args) => {
  const result = spawnSync('git', args, { cwd: root, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
};

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-coverage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'coverage/\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  await writeFile(path.join(root, 'src/price.mjs'), 'export const price = (value) => value;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Base');
  const base = git(root, 'rev-parse', 'HEAD');
  // The Story changes one line and adds a branch no test reaches, and adds a file no test loads.
  await writeFile(path.join(root, 'src/price.mjs'), ['export const price = (value) => {', '  if (value < 0) {', "    throw new Error('negative');", '  }',
    '  return value * 2;', '};', ''].join('\n'));
  await writeFile(path.join(root, 'src/unused.mjs'), 'export const unused = () => 1;\n');
  await writeFile(path.join(root, 'test/price.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "import { price } from '../src/price.mjs';\ntest('doubles', () => assert.equal(price(2), 4));\n");
  return { root, base };
}

/** A real run of Node's own test runner that writes lcov, as a command would. Node needs the folder to exist. */
async function nodeCoverageRun(root) {
  await mkdir(path.join(root, 'coverage'), { recursive: true });
  const result = spawnSync(process.execPath, ['--test', '--experimental-test-coverage', '--test-reporter=lcov', '--test-reporter-destination=coverage/lcov.info',
    '--test-reporter=tap', '--test-reporter-destination=stdout', 'test/'], { cwd: root, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

const COBERTURA = `<?xml version="1.0" ?>
<!DOCTYPE coverage SYSTEM "http://cobertura.sourceforge.net/xml/coverage-04.dtd">
<coverage line-rate="0.5" branch-rate="0" lines-covered="2" lines-valid="4" timestamp="1700000000" version="7.4.0">
  <sources><source>/work/app</source></sources>
  <packages><package name="pricing" line-rate="0.5">
    <classes><class name="price.py" filename="pricing/price.py" line-rate="0.5">
      <methods/>
      <lines><line number="1" hits="1"/><line number="2" hits="1"/><line number="3" hits="0"/><line number="5" hits="0" branch="true" condition-coverage="0% (0/2)"/></lines>
    </class></classes>
  </package></packages>
</coverage>
`;
const JACOCO = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">
<report name="pricing"><sessioninfo id="host-1" start="1700000000000" dump="1700000001000"/>
<package name="com/example/pricing"><class name="com/example/pricing/Price" sourcefilename="Price.java"><method name="double" desc="(I)I" line="7"><counter type="LINE" missed="1" covered="1"/></method></class>
<sourcefile name="Price.java"><line nr="3" mi="0" ci="3" mb="0" cb="0"/><line nr="7" mi="0" ci="2" mb="0" cb="0"/><line nr="8" mi="4" ci="0" mb="2" cb="0"/><counter type="LINE" missed="1" covered="2"/></sourcefile>
</package></report>
`;
const ISTANBUL = JSON.stringify({
  '/work/app/src/total.ts': {
    path: '/work/app/src/total.ts',
    statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 40 } }, 1: { start: { line: 3, column: 2 }, end: { line: 3, column: 20 } },
      2: { start: { line: 4, column: 2 }, end: { line: 4, column: 12 } } },
    fnMap: {}, branchMap: {}, s: { 0: 1, 1: 0, 2: 5 }, f: {}, b: {}
  }
});

test('each of the four report forms reads into the lines it marks run, in its own paths', () => {
  const hits = (entries) => Object.fromEntries(entries.map((entry) => [entry.file, Object.fromEntries(entry.lines)]));
  assert.deepEqual(hits(readCoverageReport('cobertura', COBERTURA)), { 'pricing/price.py': { 1: 1, 2: 1, 3: 0, 5: 0 } });
  assert.deepEqual(readCoverageReport('cobertura', COBERTURA)[0].sources, ['/work/app']);
  // JaCoCo names a file inside its package's folder; a line ran when it covered an instruction.
  assert.deepEqual(hits(readCoverageReport('jacoco', JACOCO)), { 'com/example/pricing/Price.java': { 3: 3, 7: 2, 8: 0 } });
  assert.deepEqual(hits(readCoverageReport('istanbul-json', ISTANBUL)), { '/work/app/src/total.ts': { 1: 1, 3: 0, 4: 5 } });
  assert.deepEqual(hits(readCoverageReport('lcov', 'TN:\nSF:src/a.mjs\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\n')), { 'src/a.mjs': { 1: 1, 2: 0 } });
  assert.throws(() => readCoverageReport('lcov', 'not a report'), /SF:/u);
  assert.throws(() => readCoverageReport('jacoco', COBERTURA), /<report>/u);
  assert.deepEqual(DEFAULT_COVERAGE_REPORTS.map((entry) => entry.path), ['coverage/lcov.info', 'coverage/cobertura-coverage.xml', 'target/site/jacoco/jacoco.xml',
    'build/reports/jacoco/test/jacocoTestReport.xml', 'coverage.xml', 'coverage/coverage-final.json']);
});

test('line ranges and a zero-context patch read the way the Story changed them', () => {
  assert.equal(lineRanges([7, 1, 2, 3, 9, 10]), '1-3,7,9-10');
  assert.deepEqual([...rangeLines('1-3,7')], [1, 2, 3, 7]);
  const patch = ['diff --git a/src/a.mjs b/src/a.mjs', '--- a/src/a.mjs', '+++ b/src/a.mjs', '@@ -1 +1,3 @@', '-x', '+a', '+b', '+c', '@@ -9,0 +12 @@', '+d',
    'diff --git a/src/gone.mjs b/src/gone.mjs', '--- a/src/gone.mjs', '+++ /dev/null', '@@ -1 +0,0 @@', '-y'].join('\n');
  assert.deepEqual(Object.fromEntries([...changedLinesFromPatch(patch)].map(([file, lines]) => [file, [...lines]])), { 'src/a.mjs': [1, 2, 3, 12] });
});

test('a command names where it writes its coverage report, and nothing else about it', () => {
  const command = { id: 'unit', kind: 'test', argv: ['npm', 'test'], modelPolicy: 'never', workingDirectory: '.', affectedRoots: ['.'],
    result: { adapter: 'node-tap', path: '.sflow/results/node-tests.tap' } };
  assert.deepEqual(normalizeExternalCommand({ ...command, coverage: { format: 'lcov', path: './coverage/lcov.info' } }).coverage, { format: 'lcov', path: 'coverage/lcov.info' });
  assert.equal(normalizeExternalCommand(command).coverage, undefined);
  // Its argv is what it was: SFlow adds no coverage flag, which would change the command's pin.
  assert.deepEqual(normalizeExternalCommand({ ...command, coverage: { format: 'lcov', path: 'coverage/lcov.info' } }).argv, ['npm', 'test']);
  for (const coverage of [{ format: 'clover', path: 'coverage/clover.xml' }, { format: 'lcov', path: '../lcov.info' }, { format: 'lcov', path: 'x', flags: ['--coverage'] }]) {
    assert.throws(() => normalizeExternalCommand({ ...command, coverage }), /coverage/u);
  }
});

test("a real run's lcov is read for the Story's changed lines, and a report the run did not write is never this run's", async (t) => {
  const { root, base } = await repository(t);
  const command = { kind: 'test', argv: ['node', '--test'], workingDirectory: '.', affectedRoots: ['.'] };
  // An earlier run's report is there before this run starts, and this run writes none.
  await mkdir(path.join(root, 'coverage'), { recursive: true });
  await writeFile(path.join(root, 'coverage/lcov.info'), 'TN:\nSF:src/price.mjs\nDA:1,1\nDA:2,1\nDA:3,1\nend_of_record\n');
  const old = new Date(Date.now() - 60_000);
  await utimes(path.join(root, 'coverage/lcov.info'), old, old);
  const startedAt = new Date().toISOString();
  const stale = await capturedCoverage(root, await coverageReportsBefore(root, command), { startedAt, codeRoot: root, base, affectedRoots: ['.'] });
  assert.equal(stale.status, 'not-measured');
  assert.match(stale.reason, /coverage\/lcov\.info was not written by this run/u);
  assert.equal(stale.contents, undefined);

  const before = await coverageReportsBefore(root, command);
  await nodeCoverageRun(root);
  const captured = await capturedCoverage(root, before, { startedAt: new Date(Date.now() - 5_000).toISOString(), codeRoot: root, base, affectedRoots: ['.'] });
  assert.equal(captured.status, 'measured');
  assert.equal(captured.format, 'lcov');
  assert.equal(captured.sourcePath, 'coverage/lcov.info');
  assert.equal(captured.bytes, captured.contents.length);
  assert.match(captured.contents.toString('utf8'), /SF:src\/price\.mjs/u);
  const files = Object.fromEntries(captured.changed.files.map((file) => [file.path, file]));
  // The throw no test reaches is changed and executable, and did not run; the doubled return did.
  assert.equal(files['src/price.mjs'].inReport, true);
  assert.ok(rangeLines(files['src/price.mjs'].uncoveredLines).has(3), JSON.stringify(files['src/price.mjs']));
  assert.ok(rangeLines(files['src/price.mjs'].coveredLines).has(5), JSON.stringify(files['src/price.mjs']));
  assert.equal(files['src/price.mjs'].executable, files['src/price.mjs'].covered + rangeLines(files['src/price.mjs'].uncoveredLines).size);
  // A changed source file no test loaded is named; the test file and the ignored report are not changed source.
  assert.deepEqual(files['src/unused.mjs'], { path: 'src/unused.mjs', inReport: false, executable: 0, covered: 0, coveredLines: '', uncoveredLines: '' });
  assert.equal(files['test/price.test.mjs'], undefined);
  assert.equal(captured.changed.base, base);
});

test('Cobertura, JaCoCo and Istanbul paths resolve to the changed files they name', async (t) => {
  const { root, base } = await repository(t);
  const lines = (count) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');
  for (const [relative, text] of [['pricing/price.py', lines(5)], ['src/main/java/com/example/pricing/Price.java', lines(8)], ['src/total.ts', lines(4)]]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), `${text}\n`);
  }
  const reports = { cobertura: ['coverage.xml', COBERTURA.replace('/work/app', root)], jacoco: ['target/site/jacoco/jacoco.xml', JACOCO],
    'istanbul-json': ['coverage/coverage-final.json', ISTANBUL.replaceAll('/work/app', root)] };
  const measured = {};
  for (const [format, [relative, text]] of Object.entries(reports)) {
    const command = { kind: 'test', argv: ['x'], coverage: { format, path: relative } };
    const before = await coverageReportsBefore(root, command);
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
    const captured = await capturedCoverage(root, before, { startedAt: new Date(Date.now() - 5_000).toISOString(), codeRoot: root, base, affectedRoots: ['.'] });
    assert.equal(captured.status, 'measured', JSON.stringify(captured));
    measured[format] = Object.fromEntries(captured.changed.files.filter((file) => file.inReport).map((file) => [file.path, [file.coveredLines, file.uncoveredLines]]));
  }
  assert.deepEqual(measured.cobertura, { 'pricing/price.py': ['1-2', '3,5'] });
  assert.deepEqual(measured.jacoco, { 'src/main/java/com/example/pricing/Price.java': ['3,7', '8'] });
  assert.deepEqual(measured['istanbul-json'], { 'src/total.ts': ['1,4', '3'] });
});

test("an attempt keeps its run's coverage report beside its test report, and admits it with the step", async (t) => {
  const { root, base } = await repository(t);
  const command = { id: 'unit', kind: 'test', argv: ['node', '--test'], workingDirectory: '.', affectedRoots: ['.'], result: { adapter: 'node-tap', path: '.sflow/results/node-tests.tap' } };
  const before = await coverageReportsBefore(root, command);
  await nodeCoverageRun(root);
  const coverage = await capturedCoverage(root, before, { startedAt: new Date(Date.now() - 5_000).toISOString(), codeRoot: root, base, affectedRoots: ['.'] });
  const check = { id: 'unit', status: 'skipped-warning', startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
  Object.defineProperty(check, 'coverageReport', { value: coverage });
  // The check's JSON never carries the report's bytes.
  assert.equal(JSON.stringify(check).includes('coverage'), false);
  const itemRelative = 'singularity/work-items/COV-1';
  const { attempt } = await recordTestAttempt(root, itemRelative, { command, check, purpose: 'local', workId: 'COV-1', phaseId: 'implement', generation: 1 });
  assert.equal(attempt.coverage.status, 'measured');
  assert.equal(attempt.coverage.contents, undefined);
  assert.equal(attempt.coverage.report.path, `${itemRelative}/context/code-delivery/tests/raw/${coverage.sha256}.info`);
  assert.equal(attempt.coverage.report.bytes, coverage.bytes);
  assert.ok(attempt.coverage.changed.files.some((file) => file.path === 'src/price.mjs'));
  assert.deepEqual((await stepAttempts(root, itemRelative, 'COV-1', 'implement')).map((entry) => entry.coverage?.report?.sha256), [coverage.sha256]);
  await admitTestAttempts(root, itemRelative, 'COV-1', 'implement');
  assert.deepEqual(await readFile(path.join(root, attempt.coverage.report.path)), coverage.contents);

  // A run that wrote no report it can read is recorded as not measured, with why, and keeps no bytes.
  const unread = { id: 'unit', status: 'skipped-warning' };
  Object.defineProperty(unread, 'coverageReport', { value: { status: 'not-measured', sourcePath: 'coverage/lcov.info', reason: 'coverage/lcov.info was not written by this run, so it is an earlier run\'s' } });
  const recorded = await recordTestAttempt(root, itemRelative, { command, check: unread, purpose: 'local', workId: 'COV-1', phaseId: 'implement', generation: 1 });
  assert.deepEqual(recorded.attempt.coverage, { status: 'not-measured', sourcePath: 'coverage/lcov.info', reason: 'coverage/lcov.info was not written by this run, so it is an earlier run\'s' });
  const plain = await recordTestAttempt(root, itemRelative, { command, check: { id: 'unit', status: 'skipped-warning' }, purpose: 'local', workId: 'COV-1', phaseId: 'implement', generation: 1 });
  assert.equal(plain.attempt.coverage, undefined);
  assert.equal(existsSync(path.join(root, 'coverage/lcov.info')), true);
});

test("a node --test run whose one reporter writes lcov to a file still reports TAP through SFlow's reporter", async (t) => {
  const { nodeTestReporterEnvironment } = await import('../src/verification/node-test-observation.mjs');
  const { root } = await repository(t);
  const argv = (...flags) => ['node', '--test', ...flags, 'test/'];
  const lcov = await nodeTestReporterEnvironment({}, root, { argv: argv('--experimental-test-coverage', '--test-reporter=lcov', '--test-reporter-destination=coverage/lcov.info') });
  assert.equal(lcov.SINGULARITY_FLOW_NODE_TEST_TAP, '1');
  assert.match(lcov.NODE_OPTIONS, /--test-reporter=file:.*node-test-reporter\.mjs --test-reporter-destination=stdout$/u);
  // A TAP reporter of the command's own is still the one that reports, as before.
  assert.equal((await nodeTestReporterEnvironment({}, root, { argv: argv('--test-reporter=tap', '--test-reporter-destination=stdout') })).SINGULARITY_FLOW_NODE_TEST_TAP, '0');
  assert.equal((await nodeTestReporterEnvironment({}, root, { argv: argv('--test-reporter', 'lcov', '--test-reporter-destination', 'stdout') })).SINGULARITY_FLOW_NODE_TEST_TAP, '0');
  assert.equal((await nodeTestReporterEnvironment({}, root, { argv: argv() })).SINGULARITY_FLOW_NODE_TEST_TAP, '1');
});
