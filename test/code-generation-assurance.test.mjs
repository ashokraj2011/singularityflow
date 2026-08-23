import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildTestExecutionReceipt, inferModuleTestCommand, isExecutableTestSourcePath, isSupportingTestResourcePath,
  normalizeRequiredTestCommand, parseTestResult, resolveAffectedModule, testReceiptPassing,
  testSuppression
} from '../src/code-delivery-tests.mjs';
import { generationSkillForPhase } from '../src/code-delivery-policy.mjs';
import { taggedAcceptanceIds, verifyCodeDeliveryReceipt } from '../src/delivery-evidence.mjs';
import { beginCodeGeneration } from '../src/generation-boundary.mjs';
import {
  buildRepositoryChangeSet, evaluateProtectedPaths, evaluateSourceBoundary, parseRawDiff
} from '../src/repository-change-set.mjs';
import { run } from '../src/util.mjs';
import { canonicalJson } from '../src/records.mjs';

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

test('protected-path evaluation checks the source and destination of renames', () => {
  const changeSet = {
    entries: [{ changeId: 'one', status: 'renamed', oldPath: 'singularity/workflow.yml', newPath: 'archive/workflow.yml' }]
  };
  assert.deepEqual(evaluateProtectedPaths(changeSet, ['singularity']).violations.map((entry) => entry.endpoint), ['oldPath']);
});

test('raw parser retains type, modes, objects, and copy similarity', () => {
  const oldObject = 'a'.repeat(40), newObject = 'b'.repeat(40);
  const parsed = parseRawDiff(`:100644 100755 ${oldObject} ${newObject} C087\0src/a.js\0test/a.test.js\0`);
  assert.deepEqual(parsed[0], {
    status: 'copied', similarity: 87, oldPath: 'src/a.js', newPath: 'test/a.test.js',
    oldMode: '100644', newMode: '100755', oldObject, newObject
  });
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
  assert.match(testSuppression({ ...base, argv: ['gradle', 'test', '-x', 'test'] }), /excluded/);
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

test('acceptance tags preserve namespaces and reject ambiguous bare suffixes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-ac-'));
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await writeFile(path.join(root, 'tests', 'payment.test.js'), '// @ac:AC-001\n// @ac:ORDER:AC-002\n');
  const tags = await taggedAcceptanceIds(root, ['tests/payment.test.js'], [
    'ORDER:AC-001', 'PAYMENT:AC-001', 'ORDER:AC-002'
  ]);
  assert.deepEqual(tags.ids, ['ORDER:AC-002']);
  assert.deepEqual(tags.ambiguous, [{ suffix: 'AC-001', matches: ['ORDER:AC-001', 'PAYMENT:AC-001'] }]);
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

test('approval replay binds the committed tree, change-set policy, and exact test receipt', async () => {
  const root = await repository('replay');
  const baseline = git(root, ['rev-parse', 'HEAD']);
  await mkdir(path.join(root, 'tests'), { recursive: true });
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
    model: { task: 'code', assurance: 'unavailable', invocationIds: [] },
    status: 'ready', capturedAt: new Date(0).toISOString()
  };
  assert.equal((await verifyCodeDeliveryReceipt(root, receipt)).valid, true);
  await writeFile(path.join(root, testReceiptPath), `${JSON.stringify({ ...testReceipt, skipped: true }, null, 2)}\n`);
  const replay = await verifyCodeDeliveryReceipt(root, receipt);
  assert.equal(replay.valid, false);
  assert.ok(replay.errors.some((message) => /bound digest/.test(message)));
  assert.ok(replay.errors.some((message) => /not passing/.test(message)));
});
