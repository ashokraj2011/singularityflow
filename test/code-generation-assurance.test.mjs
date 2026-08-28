import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildTestExecutionReceipt, inferModuleTestCommand, isExecutableTestSourcePath, isSupportingTestResourcePath,
  normalizeRequiredTestCommand, parseTestResult, resolveAffectedModule, testReceiptPassing,
  testSuppression
} from '../src/code-delivery-tests.mjs';
import { generationSkillForPhase, normalizeCodeDeliveryPolicy } from '../src/code-delivery-policy.mjs';
import { normalizeExternalCommand } from '../src/external-command-policy.mjs';
import { evaluateCodeDeliveryPreflight, taggedAcceptanceIds, verifyCodeDeliveryReceipt } from '../src/delivery-evidence.mjs';
import { beginCodeGeneration, verifyOpenGenerationIntent } from '../src/generation-boundary.mjs';
import {
  buildRepositoryChangeSet, evaluateProtectedPaths, evaluateSourceBoundary, parseRawDiff
} from '../src/repository-change-set.mjs';
import { run } from '../src/util.mjs';
import { canonicalJson } from '../src/records.mjs';
import { ensureWorkIntervalBaseline } from '../src/work-intervals.mjs';

function git(root, args) {
  const result = run('git', args, { cwd: root, allowFailure: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function repository(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `sflow-cga-${name}-`));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'CGA Test']);
  git(root, ['config', 'user.email', 'cga@example.invalid']);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'payment.js'), 'export const payment = true;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'baseline']);
  return root;
}

test('raw change sets preserve both rename endpoints and ignore user rename configuration', async () => {
  const root = await repository('rename');
  const baseline = git(root, ['rev-parse', 'HEAD']);
  await mkdir(path.join(root, 'tests'), { recursive: true });
  git(root, ['config', 'diff.renames', 'false']);
  git(root, ['mv', 'src/payment.js', 'tests/payment.test.js']);
  const changeSet = await buildRepositoryChangeSet(root, { baseCommit: baseline });
  const rename = changeSet.entries.find((entry) => entry.status === 'renamed');
  assert.equal(rename.oldPath, 'src/payment.js');
  assert.equal(rename.newPath, 'tests/payment.test.js');
  assert.equal(rename.similarity, 100);
  assert.equal(evaluateSourceBoundary(changeSet, 'test-automation', {
    allowedPath: (candidate) => candidate.startsWith('tests/')
  }).valid, false, 'the product-source endpoint disappeared from boundary policy');
});

test('a pure product-source deletion remains first-class code delivery evidence', async () => {
  const root = await repository('source-deletion');
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await writeFile(path.join(root, 'tests', 'payment.test.js'), '// @ac:CGA:AC-001\ntest("removed", () => {});\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'add baseline acceptance test']);
  git(root, ['switch', '-c', 'CGA-DELETE']);
  const phase = {
    id: 'implementation', generation: 0, status: 'in_progress', writeScope: 'source-and-artifact',
    sourceBoundary: 'unrestricted', generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'implementation-summary' }
  };
  const workflow = {
    workItem: { id: 'CGA-DELETE', workType: 'feature', branch: 'CGA-DELETE' },
    currentPhase: phase.id, phaseOrder: [phase.id], phases: { [phase.id]: phase },
    resolution: {
      configSha256: 'c'.repeat(64), sourceSha256: 's'.repeat(64), templates: {},
      capability: { policy: { protectedPaths: [] } },
      codeDelivery: normalizeCodeDeliveryPolicy()
    },
    lineage: { canonicalBranch: 'CGA-DELETE', requiredChecks: [] }, history: []
  };
  const config = {
    workItemRoot: 'singularity/work-items', governance: { requireAcceptanceCriteriaTags: false },
    workTypes: { feature: {} }
  };
  const itemDirectory = path.join(root, 'singularity', 'work-items', workflow.workItem.id);
  await mkdir(itemDirectory, { recursive: true });
  await ensureWorkIntervalBaseline(root, config, workflow, {
    phaseId: phase.id, itemDirectory,
    itemRelative: path.relative(root, itemDirectory).replaceAll(path.sep, '/')
  });
  await rm(path.join(root, 'src', 'payment.js'));
  await writeFile(path.join(root, 'tests', 'payment.test.js'), '// @ac:CGA:AC-001\ntest("removed source stays removed", () => {});\n');
  const evidence = await evaluateCodeDeliveryPreflight(root, config, workflow, phase);
  assert.deepEqual(evidence.deletedSourcePaths, ['src/payment.js']);
  assert.ok(evidence.sourcePaths.includes('src/payment.js'));
  assert.equal(evidence.paths.find((entry) => entry.path === 'src/payment.js').fileKind, 'missing');
});

test('code delivery accepts only exact protected configuration projected at Story start', async (t) => {
  const root = await repository('configuration-projection');
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['switch', '-c', 'CGA-CONFIG']);
  const phase = {
    id: 'implementation', generation: 0, status: 'in_progress', writeScope: 'source-and-artifact',
    sourceBoundary: 'unrestricted', generationPolicy: { task: 'code' },
    requiredArtifact: { kind: 'implementation-summary' }
  };
  const workflowText = 'schemaVersion: 1\n';
  const agentText = '---\nname: developer\n---\n';
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await mkdir(path.join(root, '.github', 'agents'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), workflowText);
  await writeFile(path.join(root, '.github', 'agents', 'developer.agent.md'), agentText);
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  const workflow = {
    workItem: { id: 'CGA-CONFIG', workType: 'feature', branch: 'CGA-CONFIG' },
    currentPhase: phase.id, phaseOrder: [phase.id], phases: { [phase.id]: phase },
    resolution: {
      configSha256: digest(workflowText), sourceSha256: 's'.repeat(64), templates: {},
      configurationSource: { files: {
        'singularity/workflow.yml': digest(workflowText),
        '.github/agents/developer.agent.md': digest(agentText)
      } },
      capability: { policy: { protectedPaths: [] } },
      codeDelivery: normalizeCodeDeliveryPolicy()
    },
    lineage: { canonicalBranch: 'CGA-CONFIG', requiredChecks: [] }, history: []
  };
  const config = {
    workItemRoot: 'singularity/work-items',
    governance: {
      requireAcceptanceCriteriaTags: false,
      protectedPaths: ['singularity/workflow.yml', '.github/agents']
    },
    workTypes: { feature: {} }
  };
  const itemDirectory = path.join(root, 'singularity', 'work-items', workflow.workItem.id);
  await mkdir(itemDirectory, { recursive: true });
  await ensureWorkIntervalBaseline(root, config, workflow, {
    phaseId: phase.id, itemDirectory,
    itemRelative: path.relative(root, itemDirectory).replaceAll(path.sep, '/')
  });
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await writeFile(path.join(root, 'src', 'payment.js'), 'export const payment = "implemented";\n');
  await writeFile(path.join(root, 'tests', 'payment.test.js'), 'test("payment", () => {});\n');

  const evidence = await evaluateCodeDeliveryPreflight(root, config, workflow, phase);
  assert.ok(evidence.sourcePaths.includes('src/payment.js'));
  assert.ok(evidence.testPaths.includes('tests/payment.test.js'));

  await writeFile(path.join(root, '.github', 'agents', 'developer.agent.md'), `${agentText}tampered\n`);
  await assert.rejects(
    evaluateCodeDeliveryPreflight(root, config, workflow, phase),
    (error) => error.code === 'CHANGE_SET_POLICY_VIOLATION'
      && /\.github\/agents\/developer\.agent\.md/.test(error.message)
  );
});

test('protected-path evaluation checks the source and destination of renames', () => {
  const changeSet = {
    entries: [{ changeId: 'one', status: 'renamed', oldPath: 'singularity/workflow.yml', newPath: 'archive/workflow.yml' }]
  };
  assert.deepEqual(evaluateProtectedPaths(changeSet, ['singularity']).violations.map((entry) => entry.endpoint), ['oldPath']);
});

test('protected-path evaluation follows the repository case policy', () => {
  const changeSet = {
    target: { caseInsensitivePaths: true },
    entries: [{ changeId: 'one', status: 'modified', oldPath: 'Singularity/workflow.yml', newPath: 'Singularity/workflow.yml' }]
  };
  assert.equal(evaluateProtectedPaths(changeSet, ['singularity']).valid, false);
});

test('quality working directories cannot normalize outside the repository', () => {
  for (const workingDirectory of ['src/../../../tmp', 'module/../../outside', 'src/../outside', '../tmp', '/tmp']) {
    assert.throws(() => normalizeExternalCommand({ argv: ['node', '--test'], workingDirectory }), /repository-relative/);
  }
});

test('unsupported code-delivery policy alternatives are rejected instead of silently ignored', () => {
  assert.equal(normalizeCodeDeliveryPolicy().model.minimumAssurance, 'unavailable',
    'the external Copilot host cannot inherit a kernel-audit assurance floor');
  assert.equal(normalizeCodeDeliveryPolicy().tests.minimumPassed, 1);
  assert.throws(() => normalizeCodeDeliveryPolicy({ mode: 'warn' }), /codeDelivery.mode/);
  assert.throws(() => normalizeCodeDeliveryPolicy({ changeSet: { includeUntracked: false } }), /currently supports only true/);
  assert.throws(() => normalizeCodeDeliveryPolicy({ tests: { stringCommands: 'compatibility-warn' } }), /stringCommands/);
});

test('raw parser retains type, modes, objects, and copy similarity', () => {
  const oldObject = 'a'.repeat(40), newObject = 'b'.repeat(40);
  const parsed = parseRawDiff(`:100644 100755 ${oldObject} ${newObject} C087\0src/a.js\0test/a.test.js\0`);
  assert.deepEqual(parsed[0], {
    status: 'copied', similarity: 87, oldPath: 'src/a.js', newPath: 'test/a.test.js',
    oldMode: '100644', newMode: '100755', oldObject, newObject
  });
});

test('record-link-only change evidence hashes the Git symlink target bytes', async () => {
  const root = await repository('symlink-target');
  const baseline = git(root, ['rev-parse', 'HEAD']);
  await symlink('../src/payment.js', path.join(root, 'payment-link.js'));
  const changeSet = await buildRepositoryChangeSet(root, { baseCommit: baseline });
  const link = changeSet.entries.find((entry) => entry.newPath === 'payment-link.js');
  const targetBytes = await readlink(path.join(root, 'payment-link.js'));
  assert.equal(link.newContent.kind, 'symlink');
  assert.equal(link.newContent.sha256, `sha256:${createHash('sha256').update(targetBytes).digest('hex')}`);
});

test('only current regular executable test sources satisfy delivery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-tests-'));
  await mkdir(path.join(root, 'tests', 'fixtures'), { recursive: true });
  await writeFile(path.join(root, 'tests', 'payment.test.js'), 'test("payment", () => {});\n');
  await writeFile(path.join(root, 'tests', 'README.md'), '# tests\n');
  await writeFile(path.join(root, 'tests', 'fixtures', 'payment.json'), '{}\n');
  await symlink(path.join(root, 'tests', 'payment.test.js'), path.join(root, 'tests', 'linked.test.js'));
  assert.equal(await isExecutableTestSourcePath(root, 'tests/payment.test.js'), true);
  assert.equal(await isExecutableTestSourcePath(root, 'tests/README.md'), false);
  assert.equal(await isExecutableTestSourcePath(root, 'tests/fixtures/payment.json'), false);
  assert.equal(await isExecutableTestSourcePath(root, 'tests/linked.test.js'), false);
  assert.equal(await isExecutableTestSourcePath(root, 'tests/deleted.test.js'), false);
  await writeFile(path.join(root, 'tests', 'payment_test.exs'), 'ExUnit.start()\n');
  assert.equal(await isExecutableTestSourcePath(root, 'tests/payment_test.exs'), false);
  assert.equal(await isExecutableTestSourcePath(root, 'tests/payment_test.exs', { sourceExtensions: ['.exs'] }), true);
  assert.equal(isSupportingTestResourcePath('tests/README.md'), true);
  assert.equal(isSupportingTestResourcePath('tests/__snapshots__/payment.snap'), true);
});

test('suppression flags and shell strings cannot satisfy required tests', () => {
  const base = {
    id: 'unit', kind: 'test', argv: ['mvn', 'test'], workingDirectory: '.', affectedRoots: ['.'],
    modelPolicy: 'never', result: { adapter: 'junit-xml', path: 'target/results.xml' }
  };
  assert.equal(normalizeRequiredTestCommand(base).kind, 'test');
  assert.match(testSuppression({ ...base, argv: ['mvn', 'test', '-DskipTests'] }), /disabled/);
  assert.match(testSuppression({ ...base, argv: ['mvn', 'test', '-DskipTests=true'] }), /disabled/);
  assert.match(testSuppression({ ...base, argv: ['mvn', 'test', '-Dmaven.test.skip'] }), /disabled/);
  assert.match(testSuppression({ ...base, argv: ['gradle', 'test', '-x', 'test'] }), /excluded/);
  assert.match(testSuppression({ ...base, argv: ['gradle', 'test', '-x', ':module:test'] }), /excluded/);
  assert.match(testSuppression({ ...base, argv: ['gradle', 'test', '--exclude-task=test'] }), /excluded/);
  assert.match(testSuppression({ ...base, argv: ['npx', 'vitest', '--passWithNoTests'] }), /zero discovered/);
  assert.throws(() => normalizeRequiredTestCommand('npm test'), (error) => error.code === 'CODE_TEST_RESULT_REQUIRED');
  assert.throws(() => normalizeRequiredTestCommand({ ...base, argv: ['mvn', 'test', '-DskipTests'] }), (error) => error.code === 'CODE_TEST_SUPPRESSED');
});

test('structured test receipts require discovery and zero failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-results-'));
  await mkdir(path.join(root, '.sflow', 'results'), { recursive: true });
  const command = {
    id: 'unit', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['src'],
    modelPolicy: 'never', result: { adapter: 'sflow-test-result-v1', path: '.sflow/results/unit.json', minimumDiscovered: 1 }
  };
  await writeFile(path.join(root, '.sflow', 'results', 'unit.json'), JSON.stringify({
    tests: { discovered: 2, passed: 2, failed: 0, skipped: 0 }
  }));
  const parsed = await parseTestResult(root, command);
  const receipt = buildTestExecutionReceipt(command, {
    status: 'passed', exitCode: 0, stderr: '', startedAt: new Date(0).toISOString()
  }, parsed);
  assert.equal(testReceiptPassing(receipt), true);
  assert.equal(testReceiptPassing({ ...receipt, tests: { ...receipt.tests, discovered: 0 } }), false);
  assert.equal(testReceiptPassing({ ...receipt, skipped: true }), false);
  assert.equal(testReceiptPassing({
    ...receipt, tests: { discovered: 20, passed: 0, failed: 0, skipped: 20 }
  }), false, 'an all-skipped suite is unavailable, never passing');
  assert.equal(testReceiptPassing({
    ...receipt, tests: { discovered: 2, passed: 1, failed: 0, skipped: 0 }
  }), false, 'summary counts must account for every discovered test');
});

test('Node TAP adapter preserves exact npm test scripts and validates their final summary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-node-tap-'));
  await mkdir(path.join(root, '.sflow', 'results'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { test: 'DATA_MODE=demo node --import tsx --test server/**/*.test.ts' }
  }));
  const command = await inferModuleTestCommand(root, { root: '.', system: 'node', manifest: 'package.json' });
  assert.deepEqual(command.argv, ['npm', 'test']);
  assert.equal(command.result.adapter, 'node-tap');
  await writeFile(path.join(root, command.result.path), [
    'TAP version 13', 'ok 1 - first', 'ok 2 - second', '1..2',
    '# tests 2', '# suites 0', '# pass 2', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', ''
  ].join('\n'));
  assert.deepEqual((await parseTestResult(root, command)).tests, {
    discovered: 2, passed: 2, failed: 0, skipped: 0
  });
});

test('structured result containment rejects a symlinked parent directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-contained-results-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-outside-results-'));
  await mkdir(path.join(root, '.sflow'), { recursive: true });
  await writeFile(path.join(outside, 'unit.json'), JSON.stringify({
    tests: { discovered: 1, passed: 1, failed: 0, skipped: 0 }
  }));
  await symlink(outside, path.join(root, '.sflow', 'results'));
  await assert.rejects(() => parseTestResult(root, {
    id: 'unit', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['.'],
    modelPolicy: 'never', result: { adapter: 'sflow-test-result-v1', path: '.sflow/results/unit.json' }
  }), (error) => error.code === 'CODE_TEST_RESULT_REQUIRED' && /securely repository-contained/.test(error.message));
});

test('directory result discovery ignores stale siblings when fresh results exist', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-fresh-results-'));
  await mkdir(path.join(root, 'results'), { recursive: true });
  const old = path.join(root, 'results', 'old.xml');
  const fresh = path.join(root, 'results', 'fresh.xml');
  await writeFile(old, '<testsuite tests="99" failures="0"/>');
  await utimes(old, new Date(0), new Date(0));
  const startedAt = new Date().toISOString();
  await writeFile(fresh, '<testsuite tests="2" failures="0"/>');
  const parsed = await parseTestResult(root, {
    id: 'junit', kind: 'test', argv: ['node', '--test'], workingDirectory: '.', affectedRoots: ['.'],
    modelPolicy: 'never', result: { adapter: 'junit-xml', path: 'results', minimumDiscovered: 1 }
  }, { startedAt });
  assert.equal(parsed.tests.discovered, 2);
});

test('Playwright result traversal includes nested suites and validates reporter statistics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-playwright-'));
  await mkdir(path.join(root, 'results'), { recursive: true });
  const resultPath = path.join(root, 'results', 'playwright.json');
  const command = {
    id: 'browser', kind: 'test', argv: ['playwright', 'test'], workingDirectory: '.', affectedRoots: ['.'],
    modelPolicy: 'never', result: { adapter: 'playwright-json', path: 'results/playwright.json', minimumDiscovered: 1 }
  };
  const report = {
    stats: { expected: 1, unexpected: 1, flaky: 1, skipped: 1 },
    suites: [{ title: 'root', suites: [{ title: 'nested', specs: [{ tests: [
      { status: 'expected', results: [{ status: 'passed' }] },
      { status: 'unexpected', results: [{ status: 'failed' }] },
      { status: 'flaky', results: [{ status: 'failed' }, { status: 'passed' }] },
      { status: 'skipped', results: [] }
    ] }] }] }]
  };
  await writeFile(resultPath, JSON.stringify(report));
  assert.deepEqual((await parseTestResult(root, command)).tests, {
    discovered: 4, passed: 2, failed: 1, skipped: 1
  });
  report.stats.expected = 2;
  await writeFile(resultPath, JSON.stringify(report));
  await assert.rejects(() => parseTestResult(root, command), (error) =>
    error.code === 'CODE_TEST_RESULT_REQUIRED' && /statistics differ/.test(error.message));
});

test('the TRX adapter counts failures, infrastructure outcomes, and skipped tests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-trx-'));
  await mkdir(path.join(root, 'TestResults'), { recursive: true });
  await writeFile(path.join(root, 'TestResults', 'result.trx'), [
    '<TestRun>',
    '  <ResultSummary><Counters total="6" executed="5" passed="2" failed="1" error="1" timeout="1" aborted="0" notExecuted="1" /></ResultSummary>',
    '</TestRun>'
  ].join('\n'));
  const command = {
    id: 'dotnet', kind: 'test', argv: ['dotnet', 'test'], workingDirectory: '.', affectedRoots: ['.'],
    modelPolicy: 'never', result: { adapter: 'dotnet-trx', path: 'TestResults', minimumDiscovered: 1 }
  };
  assert.deepEqual((await parseTestResult(root, command)).tests, {
    discovered: 6, passed: 2, failed: 3, skipped: 1
  });
});

test('XML adapters reject malformed documents and entity declarations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-xml-'));
  await mkdir(path.join(root, 'results'), { recursive: true });
  const command = {
    id: 'junit', kind: 'test', argv: ['test'], workingDirectory: '.', affectedRoots: ['.'],
    modelPolicy: 'never', result: { adapter: 'junit-xml', path: 'results/result.xml' }
  };
  await writeFile(path.join(root, 'results', 'result.xml'), '<testsuite tests="1"><testcase></testsuite>');
  await assert.rejects(() => parseTestResult(root, command), /closing tag/);
  await writeFile(path.join(root, 'results', 'result.xml'), '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><testsuite tests="1"/>');
  await assert.rejects(() => parseTestResult(root, command), /entity declarations are forbidden/);
});

test('Rust module inference reports the structured adapter requirement explicitly', async () => {
  await assert.rejects(() => inferModuleTestCommand(process.cwd(), {
    root: '.', system: 'rust', manifest: 'Cargo.toml'
  }), (error) => error.code === 'RUST_TEST_ADAPTER_REQUIRED' && /explicit argv-form/.test(error.message));
});

test('nearest module ownership wins and same-root polyglot ownership is ambiguous', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-modules-'));
  await writeFile(path.join(root, 'package.json'), '{}\n');
  await mkdir(path.join(root, 'services', 'orders', 'src'), { recursive: true });
  await writeFile(path.join(root, 'services', 'orders', 'pom.xml'), '<project/>\n');
  await writeFile(path.join(root, 'services', 'orders', 'src', 'Order.java'), 'class Order {}\n');
  assert.deepEqual(await resolveAffectedModule(root, 'services/orders/src/Order.java'), {
    root: 'services/orders', system: 'maven', manifest: 'pom.xml', configured: false
  });
  await writeFile(path.join(root, 'services', 'orders', 'package.json'), '{}\n');
  await assert.rejects(() => resolveAffectedModule(root, 'services/orders/src/Order.java'), (error) => error.code === 'TEST_MODULE_AMBIGUOUS');
});

test('configured roots prefer the nearest override and Windows selects command wrappers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-wrappers-'));
  await mkdir(path.join(root, 'services', 'orders'), { recursive: true });
  await writeFile(path.join(root, 'services', 'orders', 'mvnw.cmd'), '@echo off\n');
  const module = await resolveAffectedModule(root, 'services/orders/src/Order.java', {
    overrides: {
      services: { root: 'services', system: 'gradle' },
      'services/orders': { root: 'services/orders', system: 'maven', manifest: 'pom.xml' }
    }
  });
  assert.equal(module.root, 'services/orders');
  assert.deepEqual((await inferModuleTestCommand(root, module, { platform: 'win32' })).argv, ['mvnw.cmd', 'test']);
});

test('inferred commands follow monorepo package managers and platform-native runners', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-portable-runners-'));
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await mkdir(path.join(root, 'packages', 'web'), { recursive: true });
  await writeFile(path.join(root, 'packages', 'web', 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  const nodeCommand = await inferModuleTestCommand(root, {
    root: 'packages/web', system: 'node', manifest: 'package.json'
  });
  assert.deepEqual(nodeCommand.argv.slice(0, 3), ['pnpm', 'test', '--']);
  const pythonCommand = await inferModuleTestCommand(root, { root: '.', system: 'python', manifest: 'pyproject.toml' }, { platform: 'win32' });
  assert.deepEqual(pythonCommand.argv.slice(0, 4), ['py', '-3', '-m', 'pytest']);
  const swiftCommand = await inferModuleTestCommand(root, { root: '.', system: 'swift', manifest: 'Package.swift' });
  assert.deepEqual(swiftCommand.argv.slice(0, 2), ['swift', 'test']);
  assert.equal(swiftCommand.result.adapter, 'junit-xml');
});

test('acceptance tags preserve namespaces and reject ambiguous bare suffixes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-ac-'));
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await writeFile(path.join(root, 'tests', 'payment.test.js'), '// @ac:AC-001\n// @ac:ORDER:AC-002\n');
  const tags = await taggedAcceptanceIds(root, ['tests/payment.test.js'], [
    'ORDER:AC-001', 'PAYMENT:AC-001', 'ORDER:AC-002'
  ]);
  assert.deepEqual(tags.ids, ['ORDER:AC-002']);
  assert.deepEqual(tags.ambiguous, [{ suffix: 'AC-001', matches: ['ORDER:AC-001', 'PAYMENT:AC-001'] }]);

  await writeFile(path.join(root, 'tests', 'legacy.test.js'), '// @ac:MOBILE-101:AC-001\n');
  const qualifiedLegacy = await taggedAcceptanceIds(root, ['tests/legacy.test.js'], ['AC-001'], {
    requireNamespaceQualifiedIds: true
  });
  assert.deepEqual(qualifiedLegacy.ids, ['AC-001', 'MOBILE-101:AC-001']);
  assert.deepEqual(qualifiedLegacy.ambiguous, []);
  assert.deepEqual(qualifiedLegacy.bindings, [{
    clauseId: 'AC-001', testSource: 'tests/legacy.test.js',
    bindingAssurance: 'namespace-qualified-legacy-clause', tag: 'MOBILE-101:AC-001'
  }]);
});

test('all code tasks route to the canonical skill without hard-coded phase names', () => {
  assert.equal(generationSkillForPhase({ id: 'implementation', generationPolicy: { task: 'code' } }), '/sflow-code');
  assert.equal(generationSkillForPhase({ id: 'poc-test-generation', generationPolicy: { task: 'code' } }), '/sflow-code');
  assert.equal(generationSkillForPhase({ id: 'analysis', generationPolicy: { task: 'analyze' } }), '/sflow-phase');
});

test('generation begin is idempotent and refuses source mutated before its boundary', async () => {
  const root = await repository('begin');
  const baseline = git(root, ['rev-parse', 'HEAD']);
  const phase = {
    id: 'implementation', generation: 0, generationPolicy: { task: 'code' },
    sourceBoundary: 'unrestricted'
  };
  const workflow = {
    workItem: { id: 'CGA-1' },
    workIntervals: { current: { phaseId: 'implementation', status: 'open', sourceBaseCommit: baseline } },
    resolution: { codeDelivery: { generationBoundary: { dirtyStart: 'block' } } }
  };
  const first = await beginCodeGeneration(root, { workItemRoot: 'singularity/work-items' }, workflow, phase, { persist: false });
  const second = await beginCodeGeneration(root, { workItemRoot: 'singularity/work-items' }, workflow, phase, { persist: false });
  assert.equal(second.id, first.id);

  await writeFile(path.join(root, 'src', 'payment.js'), 'export const payment = false;\n');
  const dirtyPhase = { id: 'implementation', generation: 0, generationPolicy: { task: 'code' }, sourceBoundary: 'unrestricted' };
  await assert.rejects(
    () => beginCodeGeneration(root, { workItemRoot: 'singularity/work-items' }, workflow, dirtyPhase, { persist: false }),
    (error) => error.code === 'GENERATION_DIRTY_START' && /--adopt-existing/.test(error.message)
  );
});

test('a generation-looking commit message cannot establish the prior generation boundary', async () => {
  const root = await repository('rollover');
  const intervalBaseline = git(root, ['rev-parse', 'HEAD']);
  const phase = {
    id: 'implementation', generation: 1, generationPolicy: { task: 'code' },
    sourceBoundary: 'unrestricted',
    artifacts: [{ path: 'singularity/work-items/CGA-ROLL/artifacts/implementation/implementation-summary.md' }]
  };
  const workflow = {
    workItem: { id: 'CGA-ROLL' },
    workIntervals: { current: { phaseId: 'implementation', status: 'open', sourceBaseCommit: intervalBaseline } },
    resolution: { codeDelivery: { generationBoundary: { dirtyStart: 'block' } } }
  };
  await writeFile(path.join(root, 'src', 'payment.js'), 'export const payment = false;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', '[CGA-ROLL][phase:implementation][generated:1] publish artifacts']);
  await writeFile(path.join(root, 'src', 'payment.js'), 'export const payment = "repaired";\n');
  await assert.rejects(
    () => beginCodeGeneration(root, { workItemRoot: 'singularity/work-items' }, workflow, phase, { persist: false }),
    (error) => error.code === 'GENERATION_PUBLICATION_MIGRATION_REQUIRED'
      && /Commit-message matching is not authority/.test(error.message)
  );
});

test('generation-start verification binds the entire durable receipt', async () => {
  const root = await repository('intent-integrity');
  const baseline = git(root, ['rev-parse', 'HEAD']);
  const phase = { id: 'implementation', generation: 0, generationPolicy: { task: 'code' }, sourceBoundary: 'unrestricted' };
  const workflow = {
    workItem: { id: 'CGA-INTENT' },
    workIntervals: { current: { phaseId: 'implementation', status: 'open', sourceBaseCommit: baseline } },
    resolution: { codeDelivery: { generationBoundary: { dirtyStart: 'block' } } }
  };
  await beginCodeGeneration(root, { workItemRoot: 'singularity/work-items' }, workflow, phase, { persist: true });
  const receiptPath = path.join(root, phase.generationIntent.path);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  receipt.sourceBoundary = 'test-automation';
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(() => verifyOpenGenerationIntent(root, workflow, phase), /differs from its durable/);
});

test('approval replay binds the committed tree, change-set policy, and exact test receipt', async () => {
  const root = await repository('replay');
  const baseline = git(root, ['rev-parse', 'HEAD']);
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  const approvedWorkflow = 'schemaVersion: 1\n';
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), approvedWorkflow);
  await writeFile(path.join(root, 'src', 'payment.js'), 'export const payment = false;\n');
  await writeFile(path.join(root, 'tests', 'payment.test.js'), '// @ac:CGA:AC-001\ntest("payment", () => {});\n');
  const changeSet = await buildRepositoryChangeSet(root, { baseCommit: baseline });
  const changeSetPath = 'singularity/work-items/CGA-2/context/code-delivery/implementation-gen1-changes.json';
  await mkdir(path.dirname(path.join(root, changeSetPath)), { recursive: true });
  await writeFile(path.join(root, changeSetPath), `${JSON.stringify(changeSet, null, 2)}\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', '[CGA-2][phase:implementation][generated:1] publish artifacts']);
  const generationCommit = git(root, ['rev-parse', 'HEAD']);
  const generationTree = git(root, ['rev-parse', 'HEAD^{tree}']);

  const testReceipt = {
    schemaVersion: 1, kind: 'test-execution', commandId: 'unit', argvSha256: 'argv', platform: process.platform,
    workingDirectory: '.', affectedRoots: ['.'], adapter: 'sflow-test-result-v1', status: 'passed',
    exitCode: 0, timedOut: false, skipped: false, suppressed: false,
    tests: { discovered: 1, passed: 1, failed: 0, skipped: 0 },
    result: { path: '.sflow/results/unit.json', sha256: 'result' }, assurance: 'module-executed'
  };
  const testReceiptPath = 'singularity/work-items/CGA-2/context/code-delivery/tests/implementation-gen1-unit.json';
  await mkdir(path.dirname(path.join(root, testReceiptPath)), { recursive: true });
  await writeFile(path.join(root, testReceiptPath), `${JSON.stringify(testReceipt, null, 2)}\n`);
  const receipt = {
    schemaVersion: 2, kind: 'code-delivery', workId: 'CGA-2', phase: 'implementation', generation: 1,
    generationIntentId: 'intent',
    changeSet: {
      path: changeSetPath, digest: changeSet.digest, sourcePaths: ['src/payment.js'],
      executableTestPaths: ['tests/payment.test.js'], supportingTestPaths: []
    },
    traceability: {
      required: ['CGA:AC-001'], bound: ['CGA:AC-001'], missing: [], ambiguous: [],
      bindings: [{
        clauseId: 'CGA:AC-001', testSource: 'tests/payment.test.js', bindingAssurance: 'namespace-qualified',
        testIdentity: null, moduleRoot: '.', commandId: 'unit', executionAssurance: 'module-executed'
      }]
    },
    testExecutions: [{
      commandId: 'unit', receiptPath: testReceiptPath,
      receiptSha256: createHash('sha256').update(canonicalJson(testReceipt)).digest('hex'), status: 'passed'
    }],
    tree: { workingStateDigest: 'working', generationCommit, generationTree },
    model: { task: 'code', required: true, authorshipProducer: 'governed-agent', assurance: 'unavailable', invocationIds: [] },
    status: 'ready', capturedAt: new Date(0).toISOString()
  };
  assert.equal((await verifyCodeDeliveryReceipt(root, receipt)).valid, true);
  const configurationReplay = await verifyCodeDeliveryReceipt(root, receipt, {
    protectedPaths: ['singularity/workflow.yml'],
    configurationSource: { files: {
      'singularity/workflow.yml': createHash('sha256').update(approvedWorkflow).digest('hex')
    } }
  });
  assert.equal(configurationReplay.valid, true,
    'receipt replay accepts the exact configuration snapshot projected when the Story started');
  const changedConfigurationReplay = await verifyCodeDeliveryReceipt(root, receipt, {
    protectedPaths: ['singularity/workflow.yml'],
    configurationSource: { files: { 'singularity/workflow.yml': 'f'.repeat(64) } }
  });
  assert.equal(changedConfigurationReplay.valid, false,
    'receipt replay does not exempt a protected file from a different configuration digest');
  assert.ok(changedConfigurationReplay.errors.some((message) => /protected path policy fails/.test(message)));
  const insufficientModel = await verifyCodeDeliveryReceipt(root, receipt, { minimumModelAssurance: 'observed' });
  assert.equal(insufficientModel.valid, false);
  assert.ok(insufficientModel.errors.some((message) => /below required 'observed'/.test(message)));
  const manualModel = await verifyCodeDeliveryReceipt(root, {
    ...receipt, model: { ...receipt.model, required: false, authorshipProducer: 'human' }
  }, { minimumModelAssurance: 'observed' });
  assert.equal(manualModel.valid, true, 'human-authored delivery must not require a model invocation');
  await writeFile(path.join(root, testReceiptPath), `${JSON.stringify({ ...testReceipt, skipped: true }, null, 2)}\n`);
  const replay = await verifyCodeDeliveryReceipt(root, receipt);
  assert.equal(replay.valid, false);
  assert.ok(replay.errors.some((message) => /bound digest/.test(message)));
  assert.ok(replay.errors.some((message) => /not passing/.test(message)));
});
