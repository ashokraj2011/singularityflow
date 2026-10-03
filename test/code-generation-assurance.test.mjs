import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdtemp, mkdir, readFile, readlink, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildTestExecutionReceipt, replayTestReports, inferModuleTestCommand, isExecutableTestSourcePath, isSupportingTestResourcePath,
  normalizeRequiredTestCommand, parseTestResult, readDurableTestObservation,
  replayLocalJunitObservation, resolveAffectedModule, testReceiptPassing, testSuppression
} from '../src/code-delivery-tests.mjs';
import { generationSkillForPhase, normalizeCodeDeliveryPolicy } from '../src/code-delivery-policy.mjs';
import { normalizeExternalCommand } from '../src/external-command-policy.mjs';
import { evaluateCodeDeliveryPreflight, taggedAcceptanceIds, verifyCodeDeliveryReceipt } from '../src/delivery-evidence.mjs';
import { scanJavaScriptDeclarations } from '../src/verification/javascript-declarations.mjs';
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

test('a confirmed Testing return permits exact prior product source with a new unit test, but not an unbound test-only edit', async (t) => {
  const root = await repository('testing-test-repair');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  const priorTest = '// @ac:CGA-REPAIR:AC-001\ntest("payment", () => {});\n';
  const source = await readFile(path.join(root, 'src/payment.js'));
  await writeFile(path.join(root, 'tests/payment.test.js'), priorTest);
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'schemaVersion: 1\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'approved Code baseline']);
  git(root, ['switch', '-c', 'CGA-REPAIR']);
  const codeCommit = git(root, ['rev-parse', 'HEAD']);
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  const priorReceiptSha256 = 'a'.repeat(64);
  const priorPaths = [
    { path: 'src/payment.js', fileKind: 'regular-file', sha256: digest(source) },
    { path: 'tests/payment.test.js', fileKind: 'regular-file', sha256: digest(priorTest) }
  ];
  const phase = {
    id: 'implementation', generation: 1, status: 'in_progress',
    writeScope: 'source-and-artifact', sourceBoundary: 'unrestricted',
    generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'implementation-summary' },
    generationCommit: codeCommit,
    deliveryEvidence: {
      receiptSha256: priorReceiptSha256, sourcePaths: ['src/payment.js'],
      testPaths: ['tests/payment.test.js'], paths: priorPaths
    }
  };
  const workflow = {
    workItem: { id: 'CGA-REPAIR', workType: 'classic-delivery', branch: 'CGA-REPAIR' },
    currentPhase: 'implementation', phaseOrder: ['implementation', 'testing'],
    // The shipped Testing step's own return route: a repair binds to a review that may return to Code.
    phases: { implementation: phase, testing: {
      id: 'testing', status: 'not_started', generation: 1,
      approvalPolicy: { authorities: ['quality-reviewers'], minimum: 1, rejectTo: ['implementation', 'testing'] },
      approvals: [{ decision: 'rejected', target: 'implementation', changeRequestId: 'CR-001' }]
    } },
    changeRequests: [{
      id: 'CR-001', status: 'open', sourcePhase: 'testing', targetPhase: 'implementation',
      testingRepair: {
        codeGeneration: 1, codeGenerationCommit: codeCommit,
        codeReceiptSha256: priorReceiptSha256,
        confirmation: `sha256:${'b'.repeat(64)}`,
        changeSetDigest: `sha256:${'c'.repeat(64)}`,
        changedPaths: ['tests/payment.test.js']
      }
    }],
    resolution: {
      configSha256: 'c'.repeat(64), sourceSha256: 's'.repeat(64), templates: {},
      capability: { policy: { protectedPaths: [] } },
      codeDelivery: normalizeCodeDeliveryPolicy()
    },
    lineage: { canonicalBranch: 'CGA-REPAIR', requiredChecks: [] }, history: []
  };
  const config = {
    workItemRoot: 'singularity/work-items',
    governance: { requireAcceptanceCriteriaTags: false, protectedPaths: ['singularity/workflow.yml'] },
    workTypes: { 'classic-delivery': {} }
  };
  const itemDirectory = path.join(root, 'singularity/work-items/CGA-REPAIR');
  await mkdir(itemDirectory, { recursive: true });
  await ensureWorkIntervalBaseline(root, config, workflow, {
    phaseId: phase.id, itemDirectory, itemRelative: 'singularity/work-items/CGA-REPAIR'
  });
  await writeFile(path.join(root, 'tests/payment.test.js'), `${priorTest}// corrected assertion\n`);
  const repaired = await evaluateCodeDeliveryPreflight(root, config, workflow, phase);
  assert.deepEqual(repaired.sourcePaths, ['src/payment.js']);
  assert.deepEqual(repaired.testPaths, ['tests/payment.test.js']);
  assert.equal(repaired.testingRepair?.changeRequestId, 'CR-001');
  assert.deepEqual(repaired.testingRepair?.reusedSourcePaths, ['src/payment.js']);

  workflow.changeRequests[0].status = 'resolved';
  await assert.rejects(() => evaluateCodeDeliveryPreflight(root, config, workflow, phase), {
    code: 'CODE_DELIVERY_EVIDENCE_REQUIRED'
  });
  workflow.changeRequests[0].status = 'open';
  // A return recorded against a review whose policy cannot send work back to Code is no repair.
  workflow.phases.testing.approvalPolicy.rejectTo = ['testing'];
  await assert.rejects(() => evaluateCodeDeliveryPreflight(root, config, workflow, phase), {
    code: 'CODE_DELIVERY_EVIDENCE_REQUIRED'
  });
  workflow.phases.testing.approvalPolicy.rejectTo = ['implementation', 'testing'];
  await writeFile(path.join(root, 'src/payment.js'), 'export const payment = false;\n');
  const productCorrection = await evaluateCodeDeliveryPreflight(root, config, workflow, phase);
  assert.equal(productCorrection.testingRepair, null);
  assert.ok(productCorrection.sourcePaths.includes('src/payment.js'));
  await writeFile(path.join(root, 'src/payment.js'), source);
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'schemaVersion: 2\n');
  await assert.rejects(() => evaluateCodeDeliveryPreflight(root, config, workflow, phase), {
    code: 'CHANGE_SET_POLICY_VIOLATION'
  });
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

test('code delivery excludes lifecycle state stored under a configured custom Story root', async (t) => {
  const root = await repository('custom-story-root');
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['switch', '-c', 'CGA-CUSTOM-ROOT']);
  const workItemRoot = 'governed/story-state';
  const phase = {
    id: 'implementation', generation: 0, status: 'in_progress',
    writeScope: 'source-and-artifact', sourceBoundary: 'unrestricted',
    generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'implementation-summary' }
  };
  const workflow = {
    workItem: { id: 'CGA-CUSTOM-ROOT', workType: 'feature', branch: 'CGA-CUSTOM-ROOT' },
    currentPhase: phase.id, phaseOrder: [phase.id], phases: { [phase.id]: phase },
    resolution: {
      workItemRoot, configSha256: 'c'.repeat(64), sourceSha256: 's'.repeat(64), templates: {},
      capability: { policy: { protectedPaths: [] } }, codeDelivery: normalizeCodeDeliveryPolicy()
    },
    lineage: { canonicalBranch: 'CGA-CUSTOM-ROOT', requiredChecks: [] }, history: []
  };
  const config = {
    workItemRoot, governance: { requireAcceptanceCriteriaTags: false }, workTypes: { feature: {} }
  };
  const itemDirectory = path.join(root, workItemRoot, workflow.workItem.id);
  await mkdir(itemDirectory, { recursive: true });
  await writeFile(path.join(itemDirectory, 'workflow.json'), `${JSON.stringify(workflow)}\n`);
  await ensureWorkIntervalBaseline(root, config, workflow, {
    phaseId: phase.id, itemDirectory,
    itemRelative: path.relative(root, itemDirectory).replaceAll(path.sep, '/')
  });
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await writeFile(path.join(root, 'src', 'payment.js'), 'export const payment = "custom-root";\n');
  await writeFile(path.join(root, 'tests', 'payment.test.js'), 'test("custom root", () => {});\n');

  const evidence = await evaluateCodeDeliveryPreflight(root, config, workflow, phase);
  assert.ok(evidence.changeClassification.entries.some((entry) => entry.newPath === 'src/payment.js'));
  assert.ok(evidence.changeClassification.entries.every((entry) =>
    !(entry.newPath ?? entry.oldPath)?.startsWith(`${workItemRoot}/`)),
  'custom-root lifecycle records are not application delivery');
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
  assert.equal(normalizeCodeDeliveryPolicy().traceability.sourceBindings, 'enforce',
    'new definitions without an explicit option must enforce source bindings');
  assert.equal(normalizeCodeDeliveryPolicy({ traceability: { sourceBindings: 'off' } })
    .traceability.sourceBindings, 'off', 'an explicit new-definition opt-out remains possible');
  assert.equal(normalizeCodeDeliveryPolicy({ traceability: { sourceBindings: 'enforce' } })
    .traceability.sourceBindings, 'enforce');
  assert.throws(() => normalizeCodeDeliveryPolicy({ traceability: { sourceBindings: 'guess' } }),
    /codeDelivery.traceability.sourceBindings/);
  assert.equal(normalizeCodeDeliveryPolicy().tests.minimumPassed, 1);
  // Exact identity comes from each module's adapter (ADR 0016); the opt-in observation knob and
  // the testcase-exact execution assurance are retired and refused, never silently ignored.
  assert.equal(normalizeCodeDeliveryPolicy().tests.testcaseExact, undefined);
  for (const mode of ['observe', 'enforce', 'disabled']) {
    assert.throws(() => normalizeCodeDeliveryPolicy({ tests: { testcaseExact: { mode, adapter: 'junit5-surefire-v1' } } }),
      (error) => error.code === 'CODE_DELIVERY_POLICY_RETIRED');
  }
  assert.throws(() => normalizeCodeDeliveryPolicy({ tests: { executionAssurance: 'testcase-exact' } }), /executionAssurance/);
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
  assert.throws(() => normalizeRequiredTestCommand({
    ...base, argv: ['mvn', 'test', '--token', 'secret-value'],
    result: { adapter: 'unsupported', path: 'target/results.xml' }
  }), (error) => {
    assert.equal(error.code, 'CODE_TEST_RESULT_REQUIRED');
    assert.equal(error.details.configurationDependency, true);
    assert.equal(error.details.commandIndex, 0);
    assert.doesNotMatch(error.message, /secret-value/);
    return true;
  });
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

  await writeFile(path.join(root, command.result.path), [
    '\u001b[36mℹ tests 2\u001b[39m', 'ℹ pass 2', 'ℹ fail 0', 'ℹ cancelled 0',
    'ℹ skipped 0', 'ℹ todo 0', ''
  ].join('\n'));
  assert.deepEqual((await parseTestResult(root, command)).tests, {
    discovered: 2, passed: 2, failed: 0, skipped: 0
  }, 'modern Node spec-reporter summaries remain structured evidence');
});

test('Angular Karma tests are inferred and their bounded terminal summary is structured evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-karma-text-'));
  await mkdir(path.join(root, '.sflow', 'results'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { test: 'ng test' },
    devDependencies: { '@angular-devkit/build-angular': '^17.3.0', karma: '^6.4.0' }
  }));
  const command = await inferModuleTestCommand(root, {
    root: '.', system: 'node', manifest: 'package.json'
  });
  assert.deepEqual(command.argv, [
    'npm', 'test', '--', '--watch=false', '--browsers=ChromeHeadless', '--no-progress'
  ]);
  assert.equal(command.result.adapter, 'karma-text');
  await writeFile(path.join(root, command.result.path), [
    'Chrome Headless: Executed 28 of 28 SUCCESS',
    '\u001b[32mTOTAL: 28 SUCCESS\u001b[39m', ''
  ].join('\n'));
  assert.deepEqual((await parseTestResult(root, command)).tests, {
    discovered: 28, passed: 28, failed: 0, skipped: 0
  });

  await writeFile(path.join(root, command.result.path), 'TOTAL: 2 FAILED, 26 SUCCESS\n');
  assert.deepEqual((await parseTestResult(root, command)).tests, {
    discovered: 28, passed: 26, failed: 2, skipped: 0
  });
  await writeFile(path.join(root, command.result.path), 'Executed tests without a summary\n');
  await assert.rejects(() => parseTestResult(root, command), (error) =>
    error.code === 'CODE_TEST_RESULT_REQUIRED' && /missing its final TOTAL summary/.test(error.message));

  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { test: 'npm run unit', unit: 'ng test' },
    devDependencies: { karma: '^6.4.0' }
  }));
  assert.equal(await inferModuleTestCommand(root, {
    root: '.', system: 'node', manifest: 'package.json'
  }), null, 'nested scripts are not inferred because npm flags may not reach the Angular leaf');

  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { test: 'ng test && playwright test' },
    devDependencies: { karma: '^6.4.0' }
  }));
  assert.equal(await inferModuleTestCommand(root, {
    root: '.', system: 'node', manifest: 'package.json'
  }), null, 'composite scripts are not inferred because Angular flags may bind to the wrong command');

  for (const unsafeScript of ['ng test\nplaywright test', 'ng test # keep watching']) {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      scripts: { test: unsafeScript }, devDependencies: { karma: '^6.4.0' }
    }));
    assert.equal(await inferModuleTestCommand(root, {
      root: '.', system: 'node', manifest: 'package.json'
    }), null, 'shell composition cannot disguise a direct Angular invocation');
  }

  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { test: 'ng test' },
    devDependencies: { '@angular-devkit/build-angular': '^20.0.0', vitest: '^3.0.0' }
  }));
  assert.equal(await inferModuleTestCommand(root, {
    root: '.', system: 'node', manifest: 'package.json'
  }), null, 'ng test without Karma is not misclassified as Karma output');

  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { test: 'ng test' }, devDependencies: { 'karma-chrome-launcher': '^3.0.0' }
  }));
  assert.equal(await inferModuleTestCommand(root, {
    root: '.', system: 'node', manifest: 'package.json'
  }), null, 'a leftover Karma plugin does not prove the test builder emits Karma output');
});

test('direct Playwright scripts infer a structured browser run without hidden installation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-playwright-inference-'));
  const module = { root: '.', system: 'node', manifest: 'package.json' };
  const writeManifest = async (script, dependencies = { '@playwright/test': '^1.0.0' }) => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      scripts: { test: script }, devDependencies: dependencies
    }));
  };
  await writeManifest('playwright test');
  const direct = await inferModuleTestCommand(root, module);
  assert.deepEqual(direct.argv, ['npm', 'test', '--', '--reporter=json']);
  assert.equal(direct.id, 'playwright-tests');
  assert.deepEqual(direct.result, {
    adapter: 'playwright-json', path: '.sflow/results/playwright-tests.json', minimumDiscovered: 1
  });
  assert.equal(await inferModuleTestCommand(root, module, { unitOnly: true }), null,
    'dependency-test readiness must not run a browser suite as a unit test');

  await writeManifest('npx --no-install playwright test --config=playwright.config.ts');
  assert.equal((await inferModuleTestCommand(root, module)).result.adapter, 'playwright-json');
  for (const unsafe of [
    'npx playwright test', 'playwright test --list', 'playwright test --ui',
    'playwright test --pass-with-no-tests', 'playwright test && echo done',
    'npm run browser', 'playwright test\nnode other.js'
  ]) {
    await writeManifest(unsafe);
    assert.equal(await inferModuleTestCommand(root, module), null, unsafe);
  }
  await writeManifest('playwright test', {});
  assert.equal(await inferModuleTestCommand(root, module), null,
    'a script without a declared local Playwright package is not a safe runner');
});

test('composed npm test scripts preserve the exact top-level command when Node TAP is nested', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-composed-node-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: {
      test: 'npm run test:server && npm run test:background',
      'test:server': 'DATA_MODE=demo node --import tsx --test server/**/*.test.ts',
      'test:background': 'npm run build:web && playwright test',
      'build:web': 'ng build'
    }
  }));
  await writeFile(path.join(root, 'package-lock.json'), '{}\n');
  const command = await inferModuleTestCommand(root, {
    root: '.', system: 'node', manifest: 'package.json'
  });
  assert.deepEqual(command.argv, ['npm', 'test']);
  assert.equal(command.result.adapter, 'node-tap');
  assert.equal(command.result.path, '.sflow/results/node-tests.tap');
  assert.deepEqual(command.affectedRoots, ['.']);
});

test('Node package-script graph traversal is cycle-safe and bounded', async () => {
  const cycle = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-node-cycle-'));
  await writeFile(path.join(cycle, 'package.json'), JSON.stringify({
    scripts: { test: 'npm run a', a: 'npm run b', b: 'npm run a && node --test' }
  }));
  assert.deepEqual((await inferModuleTestCommand(cycle, {
    root: '.', system: 'node', manifest: 'package.json'
  })).argv, ['npm', 'test']);

  const deep = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-node-deep-'));
  const scripts = {};
  for (let index = 0; index < 35; index += 1) scripts[index ? `s${index}` : 'test'] = `npm run s${index + 1}`;
  scripts.s35 = 'node --test';
  await writeFile(path.join(deep, 'package.json'), JSON.stringify({ scripts }));
  await assert.rejects(() => inferModuleTestCommand(deep, {
    root: '.', system: 'node', manifest: 'package.json'
  }), (error) => error.code === 'CODE_TEST_RESULT_REQUIRED' && /exceeds depth/.test(error.message));

  const oversized = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-node-oversized-'));
  await writeFile(path.join(oversized, 'package.json'), JSON.stringify({
    scripts: { test: `node --test ${'x'.repeat(256 * 1024)}` }
  }));
  await assert.rejects(() => inferModuleTestCommand(oversized, {
    root: '.', system: 'node', manifest: 'package.json'
  }), (error) => error.code === 'CODE_TEST_RESULT_REQUIRED' && /exceeds 256 scripts or 262144 bytes/.test(error.message));
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
  await writeFile(path.join(root, 'results', 'result.xml'), [
    '<testsuite tests="1" failures="1"><testcase classname="ExampleTest" name="passes"/></testsuite>'
  ].join(''));
  await assert.rejects(() => parseTestResult(root, command), /aggregate 'failures' count differs/);
  await writeFile(path.join(root, 'results', 'result.xml'), [
    '<testsuite tests="1" failures="0" errors="0">',
    '<testcase classname="ExampleTest" name="passes"/><error message="afterAll failed"/>',
    '</testsuite>'
  ].join(''));
  await assert.rejects(() => parseTestResult(root, command), /suite-level 'error'/);
  await writeFile(path.join(root, 'results', 'result.xml'), [
    '<testsuite tests="1"><testcase classname="ExampleTest" name="flaky">',
    '<flakyFailure message="first attempt failed"/></testcase></testsuite>'
  ].join(''));
  // A Surefire rerun that passed is read as a flaky pass, never as a plain one [E2G-016, D15].
  const flaky = await parseTestResult(root, command);
  assert.deepEqual(flaky.tests, { discovered: 1, passed: 1, failed: 0, skipped: 0 });
  assert.equal(flaky.testcaseObservation.occurrences[0].flaky, true);
  await writeFile(path.join(root, 'results', 'result.xml'), [
    '<testsuite tests="1"><testcase classname="ExampleTest" name="flaky">',
    '<failure message="x"/><flakyFailure message="first attempt failed"/></testcase></testsuite>'
  ].join(''));
  await assert.rejects(() => parseTestResult(root, command), /contradictory retry outcomes/);
  await writeFile(path.join(root, 'results', 'result.xml'), [
    '<testsuite tests="1"><testcase classname="ExampleTest" name="rerun">',
    '<rerunFailure message="second attempt failed"/></testcase></testsuite>'
  ].join(''));
  await assert.rejects(() => parseTestResult(root, command), /contradictory retry outcomes/);
  await writeFile(path.join(root, 'results', 'result.xml'), Buffer.concat([
    Buffer.from('<testsuite tests="1"><testcase classname="ExampleTest" name="'),
    Buffer.from([0xff]),
    Buffer.from('"/></testsuite>')
  ]));
  await assert.rejects(() => parseTestResult(root, command), /not valid UTF-8/);
});

test('an attempt keeps every JUnit occurrence its report names, with its candidate and how it ended', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-junit-observe-'));
  await mkdir(path.join(root, 'target', 'surefire-reports'), { recursive: true });
  await writeFile(path.join(root, 'target', 'surefire-reports', 'TEST-order.xml'), [
    '<testsuite name="OrderTest" tests="2" failures="0" skipped="1">',
    '  <testcase classname="example.OrderTest" name="calculatesInterest" time="0.125"/>',
    '  <testcase classname="example.OrderTest" name="missingRate"><skipped/></testcase>',
    '</testsuite>'
  ].join('\n'));
  const command = {
    id: 'maven', kind: 'test', argv: ['mvn', 'test'], workingDirectory: '.', affectedRoots: ['.'],
    modelPolicy: 'never', result: { adapter: 'junit-xml', path: 'target/surefire-reports', minimumDiscovered: 1 }
  };
  const parsed = await parseTestResult(root, command);
  const receipt = buildTestExecutionReceipt(command, {
    status: 'passed', exitCode: 0, signal: null, stderr: '', startedAt: new Date(0).toISOString(),
    completedAt: new Date(1_000).toISOString(), sourceCommit: 'a'.repeat(40),
    sourceTreeSha256: 'b'.repeat(64)
  }, parsed, { attemptId: 'TA-0123456789abcdef0123', nonce: 'f'.repeat(32), purpose: 'submission', workId: 'W', phase: 'implementation', generation: 1, profile: 'junit5-surefire-v2' });
  assert.equal(receipt.schemaVersion, 5);
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.terminal, true);
  assert.deepEqual(receipt.candidate, { commit: 'a'.repeat(40), treeSha256: 'b'.repeat(64) });
  assert.deepEqual(receipt.process, {
    status: 'passed', exitCode: 0, signal: null, timedOut: false, infrastructureUnavailable: false,
    startedAt: new Date(0).toISOString(), completedAt: new Date(1_000).toISOString()
  });
  assert.deepEqual(receipt.occurrences, [
    { className: 'example.OrderTest', name: 'calculatesInterest', outcome: 'passed', durationMs: 125 },
    { className: 'example.OrderTest', name: 'missingRate', outcome: 'skipped', durationMs: null }
  ]);
  assert.match(receipt.commandSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(receipt.testcaseObservation, undefined, 'the observe-only projection is retired');
});

test('local JUnit replay bounds the whole report set and marks cross-report display collisions', () => {
  const first = Buffer.from([
    '<testsuite name="One" tests="1"><testcase classname="ExampleTest" name="same"/></testsuite>'
  ].join(''));
  const second = Buffer.from([
    '<testsuite name="Two" tests="1"><testcase classname="ExampleTest" name="same"/></testsuite>'
  ].join(''));
  assert.throws(() => replayLocalJunitObservation([
    { contents: first }, { contents: second }
  ], { maximumOccurrences: 1 }), /occurrence count exceeds 0/);
  const replay = replayLocalJunitObservation([{ contents: first }, { contents: second }]);
  assert.equal(replay.testcaseObservation.occurrences.length, 2);
  assert.equal(replay.testcaseObservation.occurrences.every((entry) =>
    entry.identityStatus === 'ambiguous-display-identity'), true);
  assert.throws(() => replayLocalJunitObservation([
    { contents: first }, { contents: first }
  ]), /duplicate report bytes/);
});

test('durable local observations reject link substitution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-durable-link-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-durable-link-source-'));
  await mkdir(path.join(root, 'reports'), { recursive: true });
  const target = path.join(outside, 'report.xml');
  const contents = Buffer.from('<testsuite tests="1"><testcase classname="ExampleTest" name="one"/></testsuite>');
  await writeFile(target, contents);
  await symlink(target, path.join(root, 'reports', 'report.xml'));
  await assert.rejects(() => readDurableTestObservation(root, 'reports/report.xml', {
    expectedSha256: createHash('sha256').update(contents).digest('hex'), expectedBytes: contents.length
  }), (error) => error.code === 'WEL_RESULT_TAMPERED');
});

test('structured result ingestion rejects hard-linked reports', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-hardlink-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-hardlink-source-'));
  await mkdir(path.join(root, 'results'), { recursive: true });
  const source = path.join(outside, 'result.xml');
  await writeFile(source, '<testsuite tests="1"><testcase name="one"/></testsuite>');
  await link(source, path.join(root, 'results', 'result.xml'));
  await assert.rejects(() => parseTestResult(root, {
    id: 'junit', kind: 'test', argv: ['mvn', 'test'], workingDirectory: '.', affectedRoots: ['.'],
    modelPolicy: 'never', result: { adapter: 'junit-xml', path: 'results/result.xml' }
  }), (error) => error.code === 'CODE_TEST_RESULT_REQUIRED' && /hard-linked/.test(error.message));
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
  assert.deepEqual((await inferModuleTestCommand(root, module, { platform: 'win32' })).argv, ['.\\mvnw.cmd', 'test']);
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
  assert.deepEqual(pythonCommand.argv.slice(0, 7), [
    'py', '-3', '-B', '-m', 'pytest', '-p', 'no:cacheprovider'
  ]);
  const swiftCommand = await inferModuleTestCommand(root, { root: '.', system: 'swift', manifest: 'Package.swift' });
  assert.deepEqual(swiftCommand.argv.slice(0, 2), ['swift', 'test']);
  assert.equal(swiftCommand.result.adapter, 'junit-xml');
});

test('acceptance tags are namespace-qualified @ac comments; bare suffixes and the retired spelling bind nothing', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-ac-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await writeFile(path.join(root, 'tests', 'payment.test.js'), [
    '// @ac:AC-001', '// @ac:ORDER:AC-002', '// @sflow-ac:ORDER:AC-003', ''
  ].join('\n'));
  const tags = await taggedAcceptanceIds(root, ['tests/payment.test.js']);
  assert.deepEqual(tags.ids, ['ORDER:AC-002']);
  assert.deepEqual(tags.bindings, [{ clauseId: 'ORDER:AC-002', testSource: 'tests/payment.test.js', bindingAssurance: 'namespace-qualified' }]);
});

test('new qualified acceptance witnesses must be comments, not executable strings', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cga-ac-comment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await writeFile(path.join(root, 'tests', 'payment.test.js'),
    'test("decoy", () => expect("@ac:ORDER:AC-001").toBeTruthy());\n');
  const decoy = await taggedAcceptanceIds(root, ['tests/payment.test.js']);
  assert.deepEqual(decoy.ids, []);
  await writeFile(path.join(root, 'tests', 'payment.test.js'),
    '// @ac:ORDER:AC-001\ntest("payment", () => {});\n');
  const witnessed = await taggedAcceptanceIds(root, ['tests/payment.test.js']);
  assert.deepEqual(witnessed.ids, ['ORDER:AC-001']);
});

test('all code tasks route to the canonical skill without hard-coded phase names', () => {
  assert.equal(generationSkillForPhase({ id: 'implementation', generationPolicy: { task: 'code' } }), '/sflow-code');
  assert.equal(generationSkillForPhase({ id: 'poc-test-generation', generationPolicy: { task: 'code' } }), '/sflow-code');
  assert.equal(generationSkillForPhase({ id: 'analysis', generationPolicy: { task: 'analyze' } }), '/sflow-phase');
  assert.equal(generationSkillForPhase({
    id: 'closure', requiredArtifact: { kind: 'convergence-report' }, generationPolicy: {
      task: 'analyze', defaultProducer: 'deterministic', allowedProducers: ['deterministic']
    }
  }), '/sflow-converge');
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
    (error) => {
      assert.equal(error.code, 'GENERATION_DIRTY_START');
      assert.match(error.message, /policy blocks adoption/);
      assert.doesNotMatch(error.message, /--adopt-existing/);
      assert.deepEqual(error.details.changedPaths, ['src/payment.js']);
      assert.deepEqual(error.details.classification.preBoundaryPaths, ['src/payment.js']);
      return true;
    }
  );
  await assert.rejects(
    () => beginCodeGeneration(root, { workItemRoot: 'singularity/work-items' }, workflow, dirtyPhase, {
      adoptExisting: true, confirm: 'sha256:incorrect', persist: false
    }),
    (error) => error.code === 'GENERATION_DIRTY_START'
      && /policy blocks adoption/.test(error.message)
      && error.details.changeSetDigest.startsWith('sha256:')
  );
});

test('dirty generation begin identifies protected and out-of-boundary paths for review', async () => {
  const root = await repository('dirty-scope');
  const baseline = git(root, ['rev-parse', 'HEAD']);
  const phase = {
    id: 'browser-tests', generation: 0, generationPolicy: { task: 'code' },
    sourceBoundary: 'test-automation'
  };
  const workflow = {
    workItem: { id: 'CGA-SCOPE' },
    workIntervals: { current: { phaseId: phase.id, status: 'open', sourceBaseCommit: baseline } },
    resolution: { codeDelivery: { generationBoundary: { dirtyStart: 'block' } } }
  };
  await writeFile(path.join(root, 'src', 'payment.js'), 'export const payment = false;\n');
  await assert.rejects(() => beginCodeGeneration(root, {
    workItemRoot: 'singularity/work-items',
    governance: { protectedPaths: ['src'] }
  }, workflow, phase, { persist: false }), (error) => {
    assert.equal(error.code, 'GENERATION_DIRTY_START');
    assert.deepEqual(error.details.classification.protectedPaths, ['src/payment.js']);
    assert.deepEqual(error.details.classification.outsideSourceBoundaryPaths, ['src/payment.js']);
    assert.equal(phase.generationIntent, undefined);
    return true;
  });
  await assert.rejects(() => beginCodeGeneration(root, {
    workItemRoot: 'singularity/work-items',
    governance: { protectedPaths: ['src'] }
  }, workflow, phase, {
    adoptExisting: true, confirm: 'sha256:incorrect', persist: false
  }), (error) => error.code === 'GENERATION_DIRTY_START'
    && /outside the phase's allowed source scope/.test(error.message));
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

  const reportBytes = Buffer.from(JSON.stringify({ tests: { discovered: 1, passed: 1, failed: 0, skipped: 0 } }));
  const replayed = replayTestReports('sflow-test-result-v1', [{ contents: reportBytes }]);
  const rawReportPath = `singularity/work-items/CGA-2/context/code-delivery/tests/raw/${replayed.result.files[0].sha256}.bin`;
  await mkdir(path.dirname(path.join(root, rawReportPath)), { recursive: true });
  await writeFile(path.join(root, rawReportPath), reportBytes);
  const unitCommand = {
    id: 'unit', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['.'],
    modelPolicy: 'never', result: { adapter: 'sflow-test-result-v1', path: '.sflow/results/unit.json', minimumDiscovered: 1 }
  };
  const testReceipt = buildTestExecutionReceipt(unitCommand, {
    status: 'passed', exitCode: 0, sourceCommit: generationCommit, sourceTreeSha256: 'working',
    startedAt: new Date(0).toISOString(), completedAt: new Date(1).toISOString()
  }, { adapter: 'sflow-test-result-v1', tests: replayed.tests, testcaseObservation: null,
    result: { path: unitCommand.result.path, ...replayed.result }, minimumDiscovered: 1, minimumPassed: 1 }, {
    attemptId: 'TA-00000000000000000001', nonce: 'a'.repeat(32), purpose: 'submission', workId: 'CGA-2',
    phase: 'implementation', generation: 1,
    rawReports: [{ path: rawReportPath, sha256: replayed.result.files[0].sha256, bytes: reportBytes.length }]
  });
  const testReceiptPath = `singularity/work-items/CGA-2/context/code-delivery/tests/attempts/implementation/${testReceipt.attemptId}.json`;
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
      commandId: 'unit', attemptId: testReceipt.attemptId, receiptPath: testReceiptPath,
      receiptSha256: createHash('sha256').update(canonicalJson(testReceipt)).digest('hex'), status: 'passed'
    }],
    tree: { workingStateDigest: 'working', generationCommit, generationTree },
    model: { task: 'code', required: true, authorshipProducer: 'governed-agent', assurance: 'unavailable', invocationIds: [] },
    status: 'ready', capturedAt: new Date(0).toISOString()
  };
  const first = await verifyCodeDeliveryReceipt(root, receipt);
  assert.equal(first.valid, true, first.errors.join('\n'));
  // An exact JavaScript witness is read again from the committed test; a forged revision is refused.
  const [declaration] = scanJavaScriptDeclarations(await readFile(path.join(root, 'tests', 'payment.test.js'), 'utf8'),
    { sourcePath: 'tests/payment.test.js', framework: 'jest' }).declarations;
  const witness = {
    clauseId: 'CGA:AC-001', testSource: 'tests/payment.test.js', profile: 'jest-static-v2', identity: { framework: 'jest', suitePath: [], name: 'payment' },
    logicalTestId: declaration.logicalTestId, declarationSha256: declaration.declarationSha256, gaps: []
  };
  const witnessed = await verifyCodeDeliveryReceipt(root, { ...receipt, traceability: { ...receipt.traceability, witnesses: [witness] } });
  assert.equal(witnessed.valid, true, witnessed.errors.join('\n'));
  const forged = await verifyCodeDeliveryReceipt(root, { ...receipt, traceability: { ...receipt.traceability, witnesses: [{ ...witness, declarationSha256: 'f'.repeat(64) }] } });
  assert.ok(forged.errors.some((message) => /acceptance witness for CGA:AC-001 in tests\/payment\.test\.js does not match the committed test/.test(message)), forged.errors.join('\n'));
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

test('an attempt replays from its durable report bytes and is bound to its candidate, step and generation', async () => {
  const root = await repository('junit-replay');
  const baseline = git(root, ['rev-parse', 'HEAD']);
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await writeFile(path.join(root, 'src', 'payment.js'), 'export const payment = true;\n');
  await writeFile(path.join(root, 'tests', 'payment.test.js'), '// @ac:CGA:AC-001\ntest("payment", () => {});\n');
  const changeSet = await buildRepositoryChangeSet(root, { baseCommit: baseline });
  const changeSetPath = 'singularity/work-items/CGA-JUNIT/context/code-delivery/implementation-gen1-changes.json';
  await mkdir(path.dirname(path.join(root, changeSetPath)), { recursive: true });
  await writeFile(path.join(root, changeSetPath), `${JSON.stringify(changeSet, null, 2)}\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', '[CGA-JUNIT][phase:implementation][generated:1] publish artifacts']);
  const generationCommit = git(root, ['rev-parse', 'HEAD']);
  const generationTree = git(root, ['rev-parse', 'HEAD^{tree}']);

  const reportBytes = Buffer.from([
    '<testsuite name="PaymentTest" tests="1" failures="0" errors="0" skipped="0">',
    '  <testcase classname="example.PaymentTest" name="payment" time="0.01"/>',
    '</testsuite>'
  ].join('\n'));
  const reportSha256 = createHash('sha256').update(reportBytes).digest('hex');
  const rawReportPath = `singularity/work-items/CGA-JUNIT/context/code-delivery/tests/raw/${reportSha256}.xml`;
  await mkdir(path.dirname(path.join(root, rawReportPath)), { recursive: true });
  await writeFile(path.join(root, rawReportPath), reportBytes);
  const replayed = replayTestReports('junit-xml', [{ contents: reportBytes }]);
  const command = {
    id: 'maven', kind: 'test', argv: ['mvn', 'test'], workingDirectory: '.', affectedRoots: ['.'],
    modelPolicy: 'never', result: { adapter: 'junit-xml', path: 'target/surefire-reports', minimumDiscovered: 1 }
  };
  const testReceipt = buildTestExecutionReceipt(command, {
    status: 'passed', exitCode: 0, stderr: '', sourceCommit: generationCommit,
    sourceTreeSha256: 'c'.repeat(64), startedAt: new Date(0).toISOString(),
    completedAt: new Date(1_000).toISOString()
  }, {
    adapter: 'junit-xml', tests: replayed.tests, testcaseObservation: replayed.testcaseObservation,
    result: { path: command.result.path, ...replayed.result }, minimumDiscovered: 1, minimumPassed: 1
  }, {
    attemptId: 'TA-00000000000000000002', nonce: 'b'.repeat(32), purpose: 'submission', workId: 'CGA-JUNIT',
    phase: 'implementation', generation: 1,
    rawReports: [{ path: rawReportPath, sha256: reportSha256, bytes: reportBytes.length }]
  });
  const testReceiptPath = `singularity/work-items/CGA-JUNIT/context/code-delivery/tests/attempts/implementation/${testReceipt.attemptId}.json`;
  await mkdir(path.dirname(path.join(root, testReceiptPath)), { recursive: true });

  const deliveryReceipt = {
    schemaVersion: 2, kind: 'code-delivery', workId: 'CGA-JUNIT', phase: 'implementation', generation: 1,
    generationIntentId: 'intent',
    changeSet: {
      path: changeSetPath, digest: changeSet.digest, sourcePaths: ['src/payment.js'],
      executableTestPaths: ['tests/payment.test.js'], supportingTestPaths: []
    },
    traceability: {
      required: ['CGA:AC-001'], bound: ['CGA:AC-001'], missing: [], ambiguous: [],
      bindings: [{
        clauseId: 'CGA:AC-001', testSource: 'tests/payment.test.js', bindingAssurance: 'namespace-qualified',
        testIdentity: null, moduleRoot: '.', commandId: 'maven', executionAssurance: 'module-executed'
      }]
    },
    testExecutions: [{
      commandId: 'maven', attemptId: testReceipt.attemptId, receiptPath: testReceiptPath, receiptSha256: null,
      status: 'passed', affectedRoots: ['.']
    }],
    tree: { workingStateDigest: 'c'.repeat(64), generationCommit, generationTree },
    model: { task: 'code', required: false, authorshipProducer: 'human', assurance: 'unavailable', invocationIds: [] },
    status: 'ready', capturedAt: new Date(0).toISOString()
  };
  const storeReceipt = async (value) => {
    await writeFile(path.join(root, testReceiptPath), `${JSON.stringify(value, null, 2)}\n`);
    deliveryReceipt.testExecutions[0].receiptSha256 = createHash('sha256')
      .update(canonicalJson(value)).digest('hex');
  };
  const replayErrors = async (value) => {
    await storeReceipt(value);
    const result = await verifyCodeDeliveryReceipt(root, deliveryReceipt);
    assert.equal(result.valid, false);
    return result.errors;
  };

  await storeReceipt(testReceipt);
  const verified = await verifyCodeDeliveryReceipt(root, deliveryReceipt);
  assert.equal(verified.valid, true, verified.errors.join('\n'));

  await writeFile(path.join(root, rawReportPath), Buffer.from('<testsuite tests="0"/>'));
  const rawTamper = await verifyCodeDeliveryReceipt(root, deliveryReceipt);
  assert.equal(rawTamper.valid, false);
  assert.ok(rawTamper.errors.some((message) => /raw report is unavailable/.test(message)));
  await writeFile(path.join(root, rawReportPath), reportBytes);

  const otherCandidate = structuredClone(testReceipt);
  otherCandidate.candidate.treeSha256 = 'd'.repeat(64);
  assert.ok((await replayErrors(otherCandidate)).some((message) => /did not run against the published candidate/.test(message)));
  const otherGeneration = structuredClone(testReceipt);
  otherGeneration.generation = 2;
  assert.ok((await replayErrors(otherGeneration)).some((message) => /another step or generation/.test(message)));
  const occurrenceTamper = structuredClone(testReceipt);
  occurrenceTamper.occurrences[0].outcome = 'failed';
  assert.ok((await replayErrors(occurrenceTamper)).some((message) => /occurrences do not replay/.test(message)));
  const moduleTamper = structuredClone(testReceipt);
  moduleTamper.tests = { discovered: 2, passed: 2, failed: 0, skipped: 0 };
  assert.ok((await replayErrors(moduleTamper)).some((message) => /module counts do not replay/.test(message)));
  const relabelled = structuredClone(testReceipt);
  relabelled.attemptId = 'TA-00000000000000000003';
  assert.ok((await replayErrors(relabelled)).some((message) => /not the attempt it is bound to/.test(message)));
});
