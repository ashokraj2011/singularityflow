import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function result(testName) {
  return {
    numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0,
    testResults: [{ assertionResults: [{
      ancestorTitles: [], fullName: testName, title: testName, status: 'passed', duration: 3
    }] }]
  };
}

async function repository(parent, name, { exact }) {
  const root = path.join(parent, name);
  const testName = `private ${name} result`;
  await mkdir(path.join(root, 'test'), { recursive: true });
  await mkdir(path.join(root, '.sflow', 'results'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"scripts":{"test":"jest"}}\n');
  await writeFile(path.join(root, 'test', 'private.test.js'), exact ? [
    '// @sflow-ac:PRIVATE:AC-001',
    `test(${JSON.stringify(testName)}, () => {`,
    '  expect(true).toBe(true);',
    '});',
    ''
  ].join('\n') : [
    '// @sflow-ac:PRIVATE:AC-001',
    `test(${JSON.stringify(testName).replace(/^"|"$/g, "'")}, () => {`,
    '});',
    ''
  ].join('\n'));
  await writeFile(path.join(root, '.sflow', 'results', 'node-tests.json'),
    `${JSON.stringify(result(testName))}\n`);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Private Corpus Person']);
  git(root, ['config', 'user.email', 'private-corpus@example.invalid']);
  git(root, ['remote', 'add', 'origin', `https://example.test/team/${name}.git`]);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

async function junitRepository(parent, name) {
  const root = path.join(parent, name);
  const source = path.join(root, 'src', 'test', 'java', 'example', 'PaymentTest.java');
  const reports = path.join(root, 'target', 'surefire-reports');
  await mkdir(path.dirname(source), { recursive: true });
  await mkdir(reports, { recursive: true });
  await writeFile(path.join(root, 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion></project>\n');
  await writeFile(source, [
    'package example;',
    'import org.junit.jupiter.api.Test;',
    'import org.junit.jupiter.api.Tag;',
    'class PaymentTest {',
    '  @Test @Tag("sflow-ac:PRIVATE:AC-002") void pays() {}',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(reports, 'TEST-example.PaymentTest.xml'), [
    '<testsuite name="PaymentTest" tests="1" failures="0" errors="0" skipped="0">',
    '  <testcase classname="example.PaymentTest" name="pays" time="0.01"/>',
    '</testsuite>',
    ''
  ].join('\n'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Private Corpus Person']);
  git(root, ['config', 'user.email', 'private-corpus@example.invalid']);
  git(root, ['remote', 'add', 'origin', `https://example.test/team/${name}.git`]);
  git(root, ['add', 'pom.xml', 'src/test/java/example/PaymentTest.java']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

async function writeManifest(file, cases) {
  await writeFile(file, `${JSON.stringify({
    schema: 'sflow-wel-real-corpus-input/v1', cases
  }, null, 2)}\n`);
}

function corpusCase(caseId, repositoryRoot, expected, {
  framework = 'jest', report = '.sflow/results/node-tests.json'
} = {}) {
  return {
    caseId,
    repository: repositoryRoot,
    framework,
    workingDirectory: '.',
    report,
    expected
  };
}

test('real WEL corpus measurement aggregates reviewed outcomes without leaking or changing repositories', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-real-corpus-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const exact = await repository(parent, 'customer-payments-secret', { exact: true });
  const inexact = await repository(parent, 'customer-ledger-secret', { exact: false });
  const junit = await junitRepository(parent, 'customer-java-secret');
  await writeFile(path.join(exact, '.sflow', 'results', 'malformed.json'), '{invalid-json\n');
  const manifest = path.join(parent, 'private-reviewed-manifest.json');
  await writeManifest(manifest, [
    corpusCase('exact-payment', exact, { outcome: 'exact', reason: null }),
    corpusCase('inexact-ledger', inexact, {
      outcome: 'inexact', reason: 'UNSUPPORTED_JAVASCRIPT_SOURCE_SHAPE'
    }),
    corpusCase('refused-malformed-report', exact, {
      outcome: 'report-refused', reason: 'CODE_TEST_RESULT_REQUIRED'
    }, { report: '.sflow/results/malformed.json' }),
    corpusCase('exact-junit-payment', junit, { outcome: 'exact', reason: null }, {
      framework: 'junit-surefire', report: 'target/surefire-reports'
    })
  ]);
  const beforeExact = git(exact, ['status', '--porcelain=v1', '-z']);
  const beforeInexact = git(inexact, ['status', '--porcelain=v1', '-z']);
  const resultValue = spawnSync(process.execPath, [
    'scripts/wel-corpus-measurement.mjs', '--manifest', manifest, '--samples', '2'
  ], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(resultValue.status, 0, resultValue.stderr || resultValue.stdout);
  const report = JSON.parse(resultValue.stdout);
  assert.equal(report.schema, 'sflow-wel-real-corpus/v2');
  assert.equal(report.outcome, 'observed');
  assert.equal(report.repositoryCount, 3);
  assert.equal(report.caseCount, 4);
  assert.equal(report.completedMeasurements, 8);
  assert.equal(report.counts.expectedExact, 2);
  assert.equal(report.counts.expectedInexact, 1);
  assert.equal(report.counts.expectedReportRefused, 1);
  assert.equal(report.counts.observedExact, 2);
  assert.equal(report.counts.observedInexact, 1);
  assert.equal(report.counts.observedReportRefused, 1);
  assert.equal(report.counts.falseExact, 0);
  assert.equal(report.counts.falseInconclusive, 0);
  assert.equal(report.counts.mismatched, 0);
  assert.equal(report.availability.javascriptStaticObservation, 'used');
  assert.equal(report.availability.junitSurefireStaticObservation, 'used');
  assert.equal(report.availability.model, 'not-invoked');
  assert.equal(report.availability.astIntelligence, 'not-invoked');
  assert.equal(report.availability.structuralExtraction, 'local-jdk-parser');
  assert.equal(report.availability.network, 'not-invoked');
  assert.equal(report.availability.testExecution, 'not-invoked');
  assert.equal(report.repositoryState, 'unchanged-observed');
  assert.equal(report.lifecycleGate, false);
  assert.equal(report.authoritative, false);
  assert.equal(report.releaseEligible, false);
  assert.equal(git(exact, ['status', '--porcelain=v1', '-z']), beforeExact);
  assert.equal(git(inexact, ['status', '--porcelain=v1', '-z']), beforeInexact);

  const serialized = JSON.stringify(report);
  for (const forbidden of [
    parent, 'customer-payments-secret', 'customer-ledger-secret', 'customer-java-secret',
    'private.test.js', 'PaymentTest.java', 'TEST-example.PaymentTest.xml',
    'node-tests.json', 'private-reviewed-manifest', 'PRIVATE:AC-001', 'PRIVATE:AC-002',
    'Private Corpus Person', 'private-corpus@example.invalid', 'sha256:'
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test('real WEL corpus measurement reports reviewed classification mismatch and fails closed', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-real-corpus-mismatch-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = await repository(parent, 'private-inexact-secret', { exact: false });
  const manifest = path.join(parent, 'manifest.json');
  await writeManifest(manifest, [
    corpusCase('incorrect-expectation', root, { outcome: 'exact', reason: null })
  ]);
  const resultValue = spawnSync(process.execPath, [
    'scripts/wel-corpus-measurement.mjs', '--manifest', manifest, '--samples', '1'
  ], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(resultValue.status, 1);
  const report = JSON.parse(resultValue.stdout);
  assert.equal(report.outcome, 'mismatch');
  assert.equal(report.counts.mismatched, 1);
  assert.equal(report.counts.falseInconclusive, 1);
  assert.equal(report.counts.falseExact, 0);
  assert.doesNotMatch(`${resultValue.stdout}${resultValue.stderr}`, /private-inexact-secret/);
});

test('real WEL corpus measurement refuses unsafe manifests, duplicate cases, and unbounded inputs without path disclosure', async (t) => {
  const missing = path.join(os.tmpdir(), 'missing-private-wel-corpus-manifest');
  const absent = spawnSync(process.execPath, [
    'scripts/wel-corpus-measurement.mjs', '--manifest', missing
  ], { cwd: process.cwd(), encoding: 'utf8' });
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /WEL_REAL_CORPUS_INVALID/);
  assert.doesNotMatch(absent.stderr, /missing-private-wel-corpus-manifest/);

  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-real-corpus-bounds-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = await repository(parent, 'private-bound-secret', { exact: true });
  const duplicate = path.join(parent, 'duplicate.json');
  const one = corpusCase('same-case', root, { outcome: 'exact', reason: null });
  await writeManifest(duplicate, [one, one]);
  const duplicateResult = spawnSync(process.execPath, [
    'scripts/wel-corpus-measurement.mjs', '--manifest', duplicate
  ], { cwd: process.cwd(), encoding: 'utf8' });
  assert.notEqual(duplicateResult.status, 0);
  assert.match(duplicateResult.stderr, /WEL_REAL_CORPUS_INVALID/);
  assert.doesNotMatch(duplicateResult.stderr, /private-bound-secret/);

  const sampleOverflow = spawnSync(process.execPath, [
    'scripts/wel-corpus-measurement.mjs', '--manifest', duplicate, '--samples', '21'
  ], { cwd: process.cwd(), encoding: 'utf8' });
  assert.notEqual(sampleOverflow.status, 0);
  assert.match(sampleOverflow.stderr, /WEL_REAL_CORPUS_INVALID/);
});
