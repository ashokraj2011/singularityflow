import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  buildTestExecutionReceipt, replayLocalJavascriptJsonObservation
} from '../src/code-delivery-tests.mjs';
import { verifyCodeDeliveryReceipt } from '../src/delivery-evidence.mjs';
import { buildRepositoryChangeSet } from '../src/repository-change-set.mjs';
import { canonicalJson } from '../src/records.mjs';
import {
  classifyJavascriptTestCommandScope, observeJavascriptTestIdentities,
  verifyJavascriptTestIdentityObservation
} from '../src/wel-javascript.mjs';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(source) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-javascript-'));
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"scripts":{"test":"jest"}}\n');
  await writeFile(path.join(root, 'test', 'payment.test.js'), source);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'WEL JavaScript Test']);
  git(root, ['config', 'user.email', 'wel-js@example.test']);
  git(root, ['remote', 'add', 'origin', 'https://example.test/team/javascript.git']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

const command = {
  id: 'node-tests', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.',
  affectedRoots: ['.'], modelPolicy: 'never',
  result: { adapter: 'jest-json', path: '.sflow/results/node-tests.json', minimumDiscovered: 1 }
};

const policy = {
  mode: 'observe', adapter: 'jest-static-v1', requiredWitnessTypes: ['test'],
  evidenceTier: 'testcase-local-observed'
};

function report(overrides = {}) {
  return {
    numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0,
    testResults: [{ assertionResults: [{
      ancestorTitles: [], fullName: 'returns balance', title: 'returns balance',
      status: 'passed', duration: 7, ...overrides
    }] }]
  };
}

function parsedReport(value = report(), adapter = 'jest-json') {
  const bytes = Buffer.from(JSON.stringify(value));
  const replay = replayLocalJavascriptJsonObservation([{ contents: bytes }], adapter);
  return {
    adapter, tests: replay.tests, testcaseObservation: replay.testcaseObservation,
    result: {
      path: command.result.path, sha256: replay.result.sha256, bytes: replay.result.bytes,
      files: [{ sourcePath: command.result.path, ...replay.result.files[0] }]
    },
    rawReports: [{ sourcePath: command.result.path, sha256: replay.result.sha256,
      bytes: replay.result.bytes, contents: bytes }],
    minimumDiscovered: 1, minimumPassed: 1
  };
}

test('a top-level literal Jest test binds qualified clauses without claiming execution authority', async () => {
  const source = [
    '// @sflow-ac:PAY:AC-001',
    '// @sflow-ac:PAY:AC-002',
    'test("returns balance", () => {',
    '  expect(2).toBe(2);',
    '});',
    ''
  ].join('\n');
  const root = await fixture(source);
  const parsed = parsedReport();
  const observation = await observeJavascriptTestIdentities(root, command, parsed, policy);
  assert.equal(observation.status, 'observed');
  assert.equal(observation.exact, true);
  assert.deepEqual(observation.mappingProposals.map((entry) => entry.clauseId).sort(), [
    'PAY:AC-001', 'PAY:AC-002'
  ]);
  assert.equal(observation.occurrences[0].identityStatus, 'exact-static-identity');
  assert.equal(observation.catalog.framework, 'jest');

  const receipt = buildTestExecutionReceipt(command, {
    status: 'passed', exitCode: 0, stderr: '', sourceCommit: git(root, ['rev-parse', 'HEAD']),
    sourceTreeSha256: 'c'.repeat(64), startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString()
  }, parsed, { testcasePolicy: policy, exactTestcaseObservation: observation });
  assert.equal(receipt.testcaseObservation.exact, true);
  assert.equal(receipt.testcaseExecutionProven, false);
  assert.equal(receipt.candidate, null);
  assert.ok(receipt.testcaseObservation.bindingGaps.includes('sgos-candidate-unavailable'));
  const verified = await verifyJavascriptTestIdentityObservation(root, receipt.testcaseObservation);
  assert.equal(verified.valid, true, verified.errors.join('\n'));
  assert.deepEqual(verified.rawOccurrences, parsed.testcaseObservation.occurrences);

  const missingProposal = structuredClone(receipt.testcaseObservation);
  missingProposal.mappingProposals.pop();
  const incomplete = await verifyJavascriptTestIdentityObservation(root, missingProposal);
  assert.equal(incomplete.valid, false);
  assert.ok(incomplete.errors.some((entry) => /incomplete proposal set/.test(entry)));

  const changed = source.replace('test("returns balance"', 'test("changed balance"');
  await writeFile(path.join(root, 'test', 'payment.test.js'), changed);
  const stale = await verifyJavascriptTestIdentityObservation(root, receipt.testcaseObservation);
  assert.equal(stale.valid, false);
  assert.ok(stale.errors.some((entry) => /bytes changed/.test(entry)));
});

test('nested, dynamic, modified, and multiline-ambiguous JavaScript declarations fail safely', async () => {
  for (const source of [
    '// @sflow-ac:PAY:AC-001\ndescribe("suite", () => { test("returns balance", () => {}); });\n',
    '// @sflow-ac:PAY:AC-001\ntest.only("returns balance", () => {\n',
    '// @sflow-ac:PAY:AC-001\ntest(`returns ${value}`, () => {\n',
    '/* prefix */\n// @sflow-ac:PAY:AC-001\ntest("returns balance", () => {\n',
    'if (true)\n// @sflow-ac:PAY:AC-001\ntest("returns balance", () => {\n'
  ]) {
    const root = await fixture(source);
    const observation = await observeJavascriptTestIdentities(root, command, parsedReport(), policy);
    assert.equal(observation.exact, false);
    assert.deepEqual(observation.mappingProposals, []);
    assert.ok(observation.gaps.includes('UNSUPPORTED_JAVASCRIPT_SOURCE_SHAPE'));
  }
  assert.deepEqual(
    classifyJavascriptTestCommandScope({ argv: ['npm', 'test', '--', '-t', 'balance'] }).gaps,
    ['FOCUSED_OR_RETRIED_TEST_EXECUTION_UNSUPPORTED']
  );

  const collisionRoot = await fixture([
    '// @sflow-ac:PAY:AC-001', 'test("returns balance", () => { });',
    '// @sflow-ac:PAY:AC-002', 'test("returns balance", () => { });', ''
  ].join('\n'));
  const collision = await observeJavascriptTestIdentities(
    collisionRoot, command, parsedReport(), policy
  );
  assert.equal(collision.exact, false);
  assert.deepEqual(collision.mappingProposals, []);
  assert.ok(collision.gaps.includes('TEST_DECLARATION_COLLISION'));
});

test('Jest/Vitest report replay rejects aggregate drift and ambiguous occurrence identities', () => {
  const bytes = Buffer.from(JSON.stringify(report()));
  const replay = replayLocalJavascriptJsonObservation([{ contents: bytes }], 'jest-json');
  assert.deepEqual(replay.tests, { discovered: 1, passed: 1, failed: 0, skipped: 0 });
  assert.equal(replay.testcaseObservation.occurrences[0].identityStatus, 'observed-name-only');
  assert.equal(replay.result.sha256, createHash('sha256').update(bytes).digest('hex'));

  assert.throws(() => replayLocalJavascriptJsonObservation([{ contents: Buffer.from(JSON.stringify({
    ...report(), numPassedTests: 0, numFailedTests: 1
  })) }], 'jest-json'), /differ from the reporter aggregate/);

  const duplicate = report();
  duplicate.numTotalTests = 2;
  duplicate.numPassedTests = 2;
  duplicate.testResults[0].assertionResults.push({ ...duplicate.testResults[0].assertionResults[0] });
  const ambiguous = replayLocalJavascriptJsonObservation([{
    contents: Buffer.from(JSON.stringify(duplicate))
  }], 'jest-json');
  assert.ok(ambiguous.testcaseObservation.occurrences.every((entry) =>
    entry.identityStatus === 'ambiguous-display-identity'));

  const vitest = replayLocalJavascriptJsonObservation([{ contents: bytes }], 'vitest-json');
  assert.equal(vitest.testcaseObservation.parser.framework, 'vitest');
});

test('delivery replay binds JavaScript source, normalized occurrences, and the content-addressed report', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-javascript-delivery-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"scripts":{"test":"jest"}}\n');
  await writeFile(path.join(root, 'src', 'payment.js'), 'export const payment = false;\n');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'WEL JavaScript Delivery']);
  git(root, ['config', 'user.email', 'wel-js-delivery@example.test']);
  git(root, ['remote', 'add', 'origin', 'https://example.test/team/javascript-delivery.git']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);
  const baseline = git(root, ['rev-parse', 'HEAD']);

  await writeFile(path.join(root, 'src', 'payment.js'), 'export const payment = true;\n');
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'test', 'payment.test.js'), [
    '// @sflow-ac:PAY:AC-001',
    'test("returns balance", () => {',
    '  expect(payment).toBe(true);',
    '});',
    ''
  ].join('\n'));
  const changeSet = await buildRepositoryChangeSet(root, { baseCommit: baseline });
  const changeSetPath = 'singularity/work-items/PAY/context/code-delivery/implementation-gen1-changes.json';
  await mkdir(path.dirname(path.join(root, changeSetPath)), { recursive: true });
  await writeFile(path.join(root, changeSetPath), `${JSON.stringify(changeSet, null, 2)}\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'publish generation']);
  const generationCommit = git(root, ['rev-parse', 'HEAD']);
  const generationTree = git(root, ['rev-parse', 'HEAD^{tree}']);

  const parsed = parsedReport();
  const observation = await observeJavascriptTestIdentities(root, command, parsed, policy);
  const testReceipt = buildTestExecutionReceipt(command, {
    status: 'passed', exitCode: 0, stderr: '', sourceCommit: generationCommit,
    sourceTreeSha256: 'c'.repeat(64), startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString()
  }, parsed, { testcasePolicy: policy, exactTestcaseObservation: observation });
  const reportBytes = parsed.rawReports[0].contents;
  const reportSha256 = createHash('sha256').update(reportBytes).digest('hex');
  const rawReportPath = `singularity/work-items/PAY/context/code-delivery/tests/raw/${reportSha256}.bin`;
  await mkdir(path.dirname(path.join(root, rawReportPath)), { recursive: true });
  await writeFile(path.join(root, rawReportPath), reportBytes);
  testReceipt.testcaseObservation.rawReports = [{
    path: rawReportPath, sha256: reportSha256, bytes: reportBytes.length
  }];
  const testReceiptPath = 'singularity/work-items/PAY/context/code-delivery/tests/implementation-gen1-node.json';
  await mkdir(path.dirname(path.join(root, testReceiptPath)), { recursive: true });
  await writeFile(path.join(root, testReceiptPath), `${JSON.stringify(testReceipt, null, 2)}\n`);

  const deliveryReceipt = {
    schemaVersion: 2, kind: 'code-delivery', workId: 'PAY', phase: 'implementation', generation: 1,
    generationIntentId: 'intent',
    changeSet: {
      path: changeSetPath, digest: changeSet.digest, sourcePaths: ['src/payment.js'],
      executableTestPaths: ['test/payment.test.js'], supportingTestPaths: []
    },
    traceability: {
      required: ['PAY:AC-001'], bound: ['PAY:AC-001'], missing: [], ambiguous: [],
      bindings: [{
        clauseId: 'PAY:AC-001', testSource: 'test/payment.test.js',
        bindingAssurance: 'namespace-qualified', testIdentity: null,
        moduleRoot: '.', commandId: 'node-tests', executionAssurance: 'module-executed'
      }]
    },
    testExecutions: [{
      commandId: 'node-tests', receiptPath: testReceiptPath,
      receiptSha256: createHash('sha256').update(canonicalJson(testReceipt)).digest('hex'),
      status: 'passed', affectedRoots: ['.']
    }],
    tree: { workingStateDigest: 'c'.repeat(64), generationCommit, generationTree },
    model: {
      task: 'code', required: false, authorshipProducer: 'human',
      assurance: 'unavailable', invocationIds: []
    },
    status: 'ready', capturedAt: new Date(0).toISOString()
  };
  const verified = await verifyCodeDeliveryReceipt(root, deliveryReceipt);
  assert.equal(verified.valid, true, verified.errors.join('\n'));

  await writeFile(path.join(root, rawReportPath), Buffer.from('{}'));
  const tampered = await verifyCodeDeliveryReceipt(root, deliveryReceipt);
  assert.equal(tampered.valid, false);
  assert.ok(tampered.errors.some((entry) => /raw report is unavailable/.test(entry)));
});
