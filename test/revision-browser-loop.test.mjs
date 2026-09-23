import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { recordSha256 } from '../src/records.mjs';
import {
  buildRevisionBrowserRunReceipt, compareRevisionBrowserRun,
  createRevisionBrowserRunState, defineRevisionBrowserCheck, prepareRevisionBrowserRun,
  transitionRevisionBrowserRunState, validateRevisionBrowserRunReceipt
} from '../src/revision/browser-loop.mjs';
import {
  readLatestRevisionBrowserRunReceipt, readRevisionBrowserArtifact,
  readRevisionBrowserRunReceipt, writeRevisionBrowserRunReceipt
} from '../src/revision/browser-run-store.mjs';
import {
  inspectPublicRevisionBrowserCheckResult, inspectPublicRevisionBrowserCheckStatus
} from '../src/revision/browser-check-service.mjs';
import {
  executeRevisionBrokeredPlan, registerRevisionBrokeredExecutionPlan,
  revisionBrokeredParentSha256
} from '../src/revision/execution-bridge.mjs';
import { sgosRevisionCandidateReference } from '../src/revision/candidate-adapter.mjs';
import { revisionRuntimeCapabilities } from '../src/revision/runtime.mjs';
import { freezeSgosCandidate } from '../src/sgos/candidate-lifecycle.mjs';
import { familyForStoredPath, migrationRegistrySnapshot } from '../src/schema-migrations.mjs';

const H = (value) => `sha256:${recordSha256(value)}`;
const NOW = '2026-09-21T00:00:00.000Z';
const LATER = '2026-09-21T00:00:01.000Z';
const END = '2026-09-21T00:00:02.000Z';
const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function check(overrides = {}) {
  return defineRevisionBrowserCheck({
    id: 'browser-tests', argv: ['npx', 'playwright', 'test'], workingDirectory: '.',
    environment: { name: 'qa', fingerprintSha256: H('qa-environment') },
    outputRoots: ['test-results/brl'],
    artifacts: { screenshots: 'always', traces: 'on-failure', video: 'never' },
    visualBaseline: null,
    timeoutMs: 60_000,
    limits: {
      maximumArtifacts: 16, maximumArtifactBytes: 1024 * 1024,
      maximumOutputBytes: 2 * 1024 * 1024, maximumTests: 100, maximumLogBytes: 64 * 1024
    },
    result: {
      adapter: 'sflow-browser-result-v1', path: 'test-results/brl/result.json',
      adapterSha256: H('adapter')
    },
    accessClass: 'private', retentionClass: 'proof', ...overrides
  });
}

function result({ status = 'passed', reasonCode = null, exitCode = 0,
  testStatus = 'passed', attempts = 1, bodySha256 = H('test-body'), includeTrace = false,
  visualComparisons = [], captureProvenanceSha256 = null } = {}) {
  const counts = { discovered: 1, passed: 0, failed: 0, skipped: 0, flaky: 0 };
  counts[testStatus] = 1;
  return Buffer.from(JSON.stringify({
    schemaVersion: 1, kind: 'sflow-browser-result-v1', status, reasonCode, exitCode,
    tests: counts,
    testCases: [{
      id: 'responsive-header', titleSha256: H('title'), bodySha256,
      status: testStatus, attempts
    }],
    artifacts: [{
      path: 'test-results/brl/header.png', kind: 'playwright-screenshot',
      mediaType: 'image/png', captureProvenanceSha256
    }, ...(includeTrace ? [{
      path: 'test-results/brl/trace.zip', kind: 'playwright-trace',
      mediaType: 'application/zip', captureProvenanceSha256: null
    }] : [])],
    visualComparisons,
    logPath: null
  }));
}

async function fixture(t, { selectedCheck = check() } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-brl-core-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'BRL Test');
  git(root, 'config', 'user.email', 'brl@example.com');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), 'schemaVersion: 1\n');
  await writeFile(path.join(root, 'app.js'), 'export const value = 1;\n');
  git(root, 'add', 'app.js', 'singularity/workflow.yml');
  git(root, 'commit', '-m', 'baseline');
  await writeFile(path.join(root, 'app.js'), 'export const value = 2;\n');
  const frozen = await freezeSgosCandidate(root, {
    subjectId: 'BRL-100:implementation', createdBy: { kind: 'human', id: 'brl@example.com' }
  });
  const candidateReference = await sgosRevisionCandidateReference(root, frozen.candidate.candidateId);
  const prepared = await prepareRevisionBrowserRun({
    root, candidateReference, workId: 'BRL-100', phaseId: 'implementation', phaseGeneration: 2,
    loopId: 'LOOP-BRL-100', intervalId: 'REV-BRL-100-1', runId: 'BRL-aaaaaaaaaaaa',
    configSha256: H('config'), workflowSha256: H('workflow'),
    proofProfileSha256: H('proof'),
    testManifest: [{ id: 'responsive-header', bodySha256: H('test-body') }],
    check: selectedCheck
  });
  return { root, candidateReference, prepared };
}

async function bridge(prepared, resultBytes = result(), extra = []) {
  const parsed = JSON.parse(resultBytes.toString('utf8'));
  const declared = parsed.artifacts
    .filter((item) => item.path !== 'test-results/brl/header.png')
    .map((item) => ({ kind: 'write', path: item.path, bytes: Buffer.from(`artifact:${item.kind}`) }));
  const operations = [
    { kind: 'write', path: prepared.check.result.path, bytes: resultBytes },
    { kind: 'write', path: 'test-results/brl/header.png', bytes: Buffer.from('fake-png') },
    ...declared,
    ...extra
  ];
  return executeRevisionBrokeredPlan({
    plan: registerRevisionBrokeredExecutionPlan(operations),
    parentFiles: prepared.parentFiles,
    allowedPaths: operations.map((item) => item.path),
    allowedEffects: ['candidate-filesystem', 'local-process'], config: {}, workflow: {},
    timeoutMs: prepared.check.timeoutMs
  });
}

function completed(prepared, {
  plannedAt = NOW, startedAt = LATER, endedAt = END
} = {}) {
  const planned = createRevisionBrowserRunState({ runKey: prepared.runKey, at: plannedAt });
  const running = transitionRevisionBrowserRunState(planned, { to: 'running', at: startedAt });
  return transitionRevisionBrowserRunState(running, { to: 'completed', at: endedAt });
}

function bridgeBoundReceiptInput(prepared, brokered, overrides = {}) {
  const { startedAt, endedAt } = brokered.processTiming;
  return {
    prepared,
    state: completed(prepared, { plannedAt: startedAt, startedAt, endedAt }),
    bridgeReceipt: brokered, startedAt, endedAt,
    ...overrides
  };
}

test('BRL path boundaries reject Windows device aliases and trailing dot or space', () => {
  for (const outputRoot of [
    'CON', 'nul.json', 'COM¹', 'lpt².json', 'CONIN$', 'clock$.log', 'reports.', 'reports '
  ]) {
    assert.throws(() => check({
      outputRoots: [outputRoot],
      result: {
        adapter: 'sflow-browser-result-v1', path: `${outputRoot}/result.json`,
        adapterSha256: H('adapter')
      }
    }), { code: 'REV_BROWSER_PATH_INVALID' }, outputRoot);
  }

  for (const unsafe of [
    'AUX.log', 'COM1.txt', 'COM¹.txt', 'LPT³.log', 'CONOUT$', 'output.', 'output '
  ]) {
    assert.throws(() => registerRevisionBrokeredExecutionPlan([{
      kind: 'write', path: unsafe, bytes: Buffer.from('blocked')
    }]), { code: 'REV_ATTEMPT_PATH_INVALID' }, unsafe);
    assert.throws(() => revisionBrokeredParentSha256([{
      path: unsafe, bytes: Buffer.from('blocked'), executable: false
    }]), { code: 'REV_ATTEMPT_PATH_INVALID' }, unsafe);
  }
});

test('BRL output roots cannot overlap retained Candidate source', async (t) => {
  await assert.rejects(() => fixture(t, { selectedCheck: check({
    outputRoots: ['app.js'],
    result: {
      adapter: 'sflow-browser-result-v1', path: 'app.js/result.json',
      adapterSha256: H('adapter')
    }
  }) }), { code: 'REV_BROWSER_OUTPUT_SCOPE_VIOLATION' });
});

test('BRL binds an immutable run to retained candidate bytes and stores opaque artifacts privately', async (t) => {
  const { root, prepared } = await fixture(t);
  const brokered = await bridge(prepared);
  const receipt = await buildRevisionBrowserRunReceipt(
    bridgeBoundReceiptInput(prepared, brokered)
  );
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.executionAssurance, 'bounded-effects-only');
  assert.match(receipt.attemptId, /^REVBR-[0-9a-f-]{36}$/);
  assert.equal(receipt.candidateUnderTestAttestation, null);
  assert.equal(receipt.runKey.workId, 'BRL-100');
  assert.equal(receipt.runKey.loopId, 'LOOP-BRL-100');
  assert.equal(receipt.runKey.intervalId, 'REV-BRL-100-1');
  assert.equal(receipt.runKey.runId, 'BRL-aaaaaaaaaaaa');
  assert.equal(receipt.assertionWitnessStatus, 'not-established');
  assert.equal(receipt.publicationEligibilityEstablished, false);
  assert.equal(receipt.artifacts[0].captureProvenanceSha256, null);
  assert.equal(receipt.artifacts[0].previewable, false);
  assert.deepEqual(receipt.visualComparisons, []);
  assert.deepEqual(validateRevisionBrowserRunReceipt(receipt), receipt);

  const written = await writeRevisionBrowserRunReceipt(root, receipt);
  assert.equal(written.created, true);
  assert.equal((await writeRevisionBrowserRunReceipt(root, receipt)).created, false);
  const conflictingBridge = await bridge(prepared);
  const conflicting = await buildRevisionBrowserRunReceipt(
    bridgeBoundReceiptInput(prepared, conflictingBridge)
  );
  await assert.rejects(() => writeRevisionBrowserRunReceipt(root, conflicting),
    { code: 'REV_BROWSER_STORE_RUN_IMMUTABLE' });
  assert.deepEqual(await readRevisionBrowserRunReceipt(root, {
    runId: prepared.runKey.runId
  }), receipt);
  assert.deepEqual(await readLatestRevisionBrowserRunReceipt(root, prepared.runKey.runId), receipt);
  const publicStatus = await inspectPublicRevisionBrowserCheckStatus(
    root, prepared.runKey.runId
  );
  assert.equal(publicStatus.state, 'completed');
  assert.equal(publicStatus.verdict, 'passed');
  assert.equal(publicStatus.receiptSha256, receipt.receiptSha256);
  assert.equal(publicStatus.runKeySha256, receipt.runKey.runKeySha256);
  assert.equal(publicStatus.currentBindingStatus, 'unavailable',
    'a missing current Story cannot hide a named historical receipt');
  assert.equal(publicStatus.assertionWitnessStatus, 'not-established');
  assert.equal(publicStatus.testingVerificationStatus,
    'not-established-by-browser-check-status');
  assert.equal(publicStatus.publicationEligibilityEstablished, false);
  const publicResult = await inspectPublicRevisionBrowserCheckResult(
    root, prepared.runKey.runId
  );
  assert.equal(publicResult.status, 'passed');
  assert.deepEqual(publicResult.receipt, receipt);
  assert.equal(publicResult.runState.state, 'completed');
  assert.equal(publicResult.currentBindingStatus, 'unavailable');
  assert.equal(publicResult.comparison, null,
    'historical receipt identity is not misrepresented as a current sealed comparison');
  assert.equal(publicResult.criterionSatisfactionEstablished, false);
  assert.equal(publicResult.testingVerificationStatus,
    'not-established-by-browser-check-result');
  assert.equal(publicResult.publicationEligibilityEstablished, false);
  for (const action of ['status', 'result']) {
    const invoked = spawnSync(process.execPath, [
      CLI, 'revision', 'checks', action, prepared.runKey.runId, '--json'
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(invoked.status, 0, invoked.stderr);
    const envelope = JSON.parse(invoked.stdout);
    assert.equal(envelope.operation.id, `revision.checks.${action}`);
    assert.equal(envelope.effects.stateChanged, false);
    assert.equal(envelope.data.runId, prepared.runKey.runId);
    assert.equal(envelope.data.receiptSha256 ?? envelope.data.receipt?.receiptSha256,
      receipt.receiptSha256);
    assert.equal(envelope.data.publicationEligibilityEstablished, false);
  }
  assert.equal((await readRevisionBrowserArtifact(root, {
    runId: prepared.runKey.runId,
    artifactSha256: receipt.artifacts[0].sha256
  })).toString(), 'fake-png');
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'export const value = 2;\n');

  const mismatchedRunId = 'BRL-cccccccccccc';
  const mismatchedDirectory = path.join(
    root, '.git', 'singularity-flow', 'revision-browser-runs', mismatchedRunId
  );
  await mkdir(mismatchedDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(mismatchedDirectory, 'receipt.json'), JSON.stringify(receipt), {
    mode: 0o600
  });
  await assert.rejects(
    () => inspectPublicRevisionBrowserCheckStatus(root, mismatchedRunId),
    { code: 'REV_BROWSER_STORE_CORRUPT' }
  );
  const receiptFile = path.join(
    root, '.git', 'singularity-flow', 'revision-browser-runs',
    prepared.runKey.runId, 'receipt.json'
  );
  await writeFile(receiptFile, '{not-json\n');
  await assert.rejects(
    () => inspectPublicRevisionBrowserCheckResult(root, prepared.runKey.runId),
    { code: 'REV_BROWSER_STORE_CORRUPT' }
  );
});

test('artifact metadata cannot forge capture provenance or preview authority', async (t) => {
  const { prepared } = await fixture(t);
  const forged = await bridge(prepared, result({ captureProvenanceSha256: H('forged-capture') }));
  await assert.rejects(() => buildRevisionBrowserRunReceipt(
    bridgeBoundReceiptInput(prepared, forged)
  ), { code: 'REV_BROWSER_ARTIFACT_PROVENANCE_UNAVAILABLE' });
});

test('receipt timing is bound to the fixed bridge monotonic measurement and registered timeout', async (t) => {
  const { prepared } = await fixture(t, { selectedCheck: check({ timeoutMs: 1_000 }) });
  const brokered = await bridge(prepared);
  await assert.rejects(() => buildRevisionBrowserRunReceipt(
    bridgeBoundReceiptInput(prepared, brokered, { startedAt: NOW })
  ), { code: 'REV_BROWSER_TIMING_INVALID' });
  const receipt = await buildRevisionBrowserRunReceipt(
    bridgeBoundReceiptInput(prepared, brokered)
  );
  assert.equal(receipt.startedAt, brokered.processTiming.startedAt);
  assert.equal(receipt.endedAt, brokered.processTiming.endedAt);
  assert.equal(receipt.durationMs, brokered.processTiming.durationMs);
  assert.equal(receipt.runKey.timeoutMs, brokered.processTiming.timeoutMs);
});

test('comparison is deterministic, model-free, honest about assurance, and stale on bound changes', async (t) => {
  const { root, candidateReference, prepared } = await fixture(t);
  const brokered = await bridge(prepared);
  const receipt = await buildRevisionBrowserRunReceipt(
    bridgeBoundReceiptInput(prepared, brokered)
  );
  const current = compareRevisionBrowserRun({ receipt, expectedRunKey: prepared.runKey });
  assert.equal(current.status, 'observed-passed');
  assert.equal(current.modelInvocations, 0);
  assert.equal(current.criterionSatisfactionEstablished, false);
  assert.equal(current.assertions[0].witnessEligible, false);

  const next = await prepareRevisionBrowserRun({
    root, candidateReference, workId: 'BRL-100', phaseId: 'implementation', phaseGeneration: 2,
    loopId: 'LOOP-BRL-100', intervalId: 'REV-BRL-100-1', runId: 'BRL-bbbbbbbbbbbb',
    configSha256: H('config'), workflowSha256: H('workflow'),
    proofProfileSha256: H('proof'),
    testManifest: [{ id: 'responsive-header', bodySha256: H('changed-test-body') }],
    check: prepared.check
  });
  const stale = compareRevisionBrowserRun({ receipt, expectedRunKey: next.runKey });
  assert.equal(stale.status, 'stale');
  assert.deepEqual(stale.staleBindings, ['run', 'test-manifest']);

  const changedTimeout = structuredClone(prepared.runKey);
  changedTimeout.timeoutMs += 1_000;
  delete changedTimeout.runKeySha256;
  changedTimeout.runKeySha256 = H(changedTimeout);
  assert.deepEqual(compareRevisionBrowserRun({
    receipt, expectedRunKey: changedTimeout
  }).staleBindings, ['command']);

  const maximalExpected = structuredClone(prepared.runKey);
  Object.assign(maximalExpected, {
    candidateRefSha256: H('other-candidate-reference'), candidateTree: 'e'.repeat(40),
    workId: 'BRL-OTHER', loopId: 'LOOP-OTHER', intervalId: 'REV-OTHER-1',
    runId: 'BRL-cccccccccccc', phaseId: 'testing', phaseGeneration: 3,
    configSha256: H('other-config'), workflowSha256: H('other-workflow'),
    proofProfileSha256: H('other-proof'), testManifestSha256: H('other-tests'),
    argvSha256: H('other-command'), environmentSha256: H('other-environment'),
    baselineManifestSha256: H('other-baseline'), adapterSha256: H('other-adapter')
  });
  delete maximalExpected.runKeySha256;
  maximalExpected.runKeySha256 = H(maximalExpected);
  const maximal = compareRevisionBrowserRun({ receipt, expectedRunKey: maximalExpected });
  assert.equal(maximal.staleBindings.length, 16);
  assert.deepEqual(maximal.staleBindings, [
    'candidate', 'candidate-tree', 'subject', 'loop', 'interval', 'run', 'phase',
    'phase-generation', 'configuration', 'workflow', 'proof-profile', 'test-manifest',
    'command', 'environment', 'baseline', 'adapter'
  ]);
});

test('a re-sealed receipt cannot substitute a different per-test body manifest', async (t) => {
  const { prepared } = await fixture(t);
  const brokered = await bridge(prepared);
  const receipt = await buildRevisionBrowserRunReceipt(
    bridgeBoundReceiptInput(prepared, brokered)
  );
  const forged = structuredClone(receipt);
  forged.testCases[0].bodySha256 = H('substituted-test-body');
  delete forged.receiptSha256;
  forged.receiptSha256 = H(forged);
  assert.throws(() => validateRevisionBrowserRunReceipt(forged), {
    code: 'REV_BROWSER_RECEIPT_INVALID'
  });

  const forgedTiming = structuredClone(receipt);
  forgedTiming.durationMs = forgedTiming.runKey.timeoutMs + 1;
  delete forgedTiming.receiptSha256;
  forgedTiming.receiptSha256 = H(forgedTiming);
  assert.throws(() => validateRevisionBrowserRunReceipt(forgedTiming), {
    code: 'REV_BROWSER_RECEIPT_INVALID'
  });
});

test('a re-sealed stored receipt cannot exceed the 256 KiB hard ceiling', async (t) => {
  const { prepared } = await fixture(t);
  const brokered = await bridge(prepared);
  const receipt = await buildRevisionBrowserRunReceipt(
    bridgeBoundReceiptInput(prepared, brokered)
  );
  const forged = structuredClone(receipt);
  forged.testCases = Array.from({ length: 1_200 }, (_, index) => ({
    id: `oversized-${String(index).padStart(4, '0')}-${'x'.repeat(220)}`,
    titleSha256: H(`title-${index}`), bodySha256: H(`body-${index}`),
    status: 'passed', attempts: 1
  }));
  forged.tests = {
    discovered: forged.testCases.length, passed: forged.testCases.length,
    failed: 0, skipped: 0, flaky: 0
  };
  const manifest = forged.testCases.map(({ id, bodySha256 }) => ({ id, bodySha256 }));
  forged.runKey.testManifestSha256 = H(manifest);
  delete forged.runKey.runKeySha256;
  forged.runKey.runKeySha256 = H(forged.runKey);
  delete forged.receiptSha256;
  forged.receiptSha256 = H(forged);
  assert.ok(Buffer.byteLength(JSON.stringify(forged)) > 256 * 1024);
  assert.throws(() => validateRevisionBrowserRunReceipt(forged), {
    code: 'REV_BROWSER_RECEIPT_INVALID',
    message: /exceeds its byte limit/
  });
});

test('unbound environments and invalid execution-state transitions fail closed', async (t) => {
  const unbound = check({ environment: { name: 'qa', fingerprintSha256: null } });
  const { prepared } = await fixture(t, { selectedCheck: unbound });
  const state = createRevisionBrowserRunState({ runKey: prepared.runKey, at: NOW });
  assert.equal(prepared.available, false);
  assert.equal(state.state, 'unavailable');
  assert.throws(() => transitionRevisionBrowserRunState(state, { to: 'running', at: LATER }),
    { code: 'REV_BROWSER_RUN_STATE_INVALID' });
  await assert.rejects(() => buildRevisionBrowserRunReceipt({
    prepared, state, bridgeReceipt: {}, startedAt: NOW, endedAt: END
  }), { code: 'REV_BROWSER_ENVIRONMENT_UNBOUND' });

  const { prepared: available } = await fixture(t);
  const planned = createRevisionBrowserRunState({ runKey: available.runKey, at: NOW });
  const running = transitionRevisionBrowserRunState(planned, { to: 'running', at: LATER });
  const infrastructure = transitionRevisionBrowserRunState(running, {
    to: 'infrastructure-failed', at: END, reasonCode: 'RUNNER_UNAVAILABLE'
  });
  assert.equal(infrastructure.state, 'infrastructure-failed');
  assert.throws(() => transitionRevisionBrowserRunState(running, {
    to: 'completed', at: END, reasonCode: 'TESTS_FAILED'
  }), { code: 'REV_BROWSER_RUN_STATE_INVALID' });
});

test('green claims refuse skipped, flaky, retried, empty, nonzero, or unexplained outcomes', async (t) => {
  for (const [name, selected] of [
    ['skipped', { testStatus: 'skipped' }],
    ['flaky', { testStatus: 'flaky' }],
    ['retried', { attempts: 2 }],
    ['nonzero', { exitCode: 1 }]
  ]) {
    const { prepared } = await fixture(t);
    const brokered = await bridge(prepared, result(selected));
    await assert.rejects(() => buildRevisionBrowserRunReceipt(
      bridgeBoundReceiptInput(prepared, brokered)
    ), { code: 'REV_BROWSER_RESULT_INVALID' }, name);
  }
  const { prepared: emptyPrepared } = await fixture(t);
  const emptyPayload = JSON.parse(result().toString('utf8'));
  emptyPayload.tests = { discovered: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 };
  emptyPayload.testCases = [];
  emptyPayload.visualComparisons = [];
  const emptyBridge = await bridge(emptyPrepared, Buffer.from(JSON.stringify(emptyPayload)));
  await assert.rejects(() => buildRevisionBrowserRunReceipt(
    bridgeBoundReceiptInput(emptyPrepared, emptyBridge)
  ), { code: 'REV_BROWSER_TEST_MANIFEST_MISMATCH' }, 'empty');
  const { prepared } = await fixture(t);
  const unexplained = await bridge(prepared, result({
    status: 'failed', reasonCode: null, exitCode: 1, testStatus: 'failed'
  }));
  await assert.rejects(() => buildRevisionBrowserRunReceipt(
    bridgeBoundReceiptInput(prepared, unexplained)
  ), { code: 'REV_BROWSER_RESULT_INVALID' });
});

test('forged bridge objects, different parent bytes, source writes, and uninventoried outputs refuse', async (t) => {
  const { prepared } = await fixture(t);
  const brokered = await bridge(prepared);
  const common = bridgeBoundReceiptInput(prepared, brokered);
  await assert.rejects(() => buildRevisionBrowserRunReceipt({ ...common, bridgeReceipt: { ...brokered } }),
    { code: 'REV_ATTEMPT_RESULT_UNVERIFIED' });
  const differentParent = await executeRevisionBrokeredPlan({
    plan: registerRevisionBrokeredExecutionPlan([
      { kind: 'write', path: prepared.check.result.path, bytes: result() },
      { kind: 'write', path: 'test-results/brl/header.png', bytes: Buffer.from('fake-png') }
    ]),
    parentFiles: [{ path: 'other.txt', bytes: Buffer.from('other') }],
    allowedPaths: [prepared.check.result.path, 'test-results/brl/header.png'],
    allowedEffects: ['candidate-filesystem', 'local-process'], config: {}, workflow: {},
    timeoutMs: prepared.check.timeoutMs
  });
  await assert.rejects(() => buildRevisionBrowserRunReceipt(
    bridgeBoundReceiptInput(prepared, differentParent)
  ),
    { code: 'REV_BROWSER_BRIDGE_INVALID' });

  const sourceWrite = await bridge(prepared, result(), [
    { kind: 'write', path: 'src/escape.js', bytes: Buffer.from('bad') }
  ]);
  await assert.rejects(() => buildRevisionBrowserRunReceipt(
    bridgeBoundReceiptInput(prepared, sourceWrite)
  ),
    { code: 'REV_BROWSER_OUTPUT_SCOPE_VIOLATION' });
  const extra = await bridge(prepared, result(), [
    { kind: 'write', path: 'test-results/brl/unlisted.txt', bytes: Buffer.from('hidden') }
  ]);
  await assert.rejects(() => buildRevisionBrowserRunReceipt(
    bridgeBoundReceiptInput(prepared, extra)
  ),
    { code: 'REV_BROWSER_ARTIFACT_INVALID' });
});

test('prepared-run, check, state, and approved test-manifest substitutions fail closed', async (t) => {
  const { prepared } = await fixture(t);
  const brokered = await bridge(prepared);
  const input = bridgeBoundReceiptInput(prepared, brokered);
  await assert.rejects(() => buildRevisionBrowserRunReceipt({
    ...input, prepared: { ...prepared }
  }), { code: 'REV_BROWSER_PREPARED_RUN_INVALID' });
  const alternate = check({ id: 'alternate-browser-tests' });
  await assert.rejects(() => buildRevisionBrowserRunReceipt({
    ...input, prepared: { ...prepared, check: alternate }
  }), { code: 'REV_BROWSER_PREPARED_RUN_INVALID' });
  await assert.rejects(() => buildRevisionBrowserRunReceipt({
    ...input, state: { ...input.state }
  }), { code: 'REV_BROWSER_RUN_STATE_INVALID' });
  const changedBody = await bridge(prepared, result({ bodySha256: H('changed-test-body') }));
  await assert.rejects(() => buildRevisionBrowserRunReceipt(
    bridgeBoundReceiptInput(prepared, changedBody)
  ), { code: 'REV_BROWSER_TEST_MANIFEST_MISMATCH' });
});

test('visual claims fail closed until comparator and governed baseline lifecycle exist', async (t) => {
  assert.throws(() => check({
    visualBaseline: {
      path: 'tests/__screenshots__', manifestSha256: H('baseline'), tolerance: 0.005,
      approvalSha256: H('baseline-approval'), updatePolicy: 'governed'
    }
  }), { code: 'REV_BROWSER_VISUAL_COMPARATOR_UNAVAILABLE' });
  const { prepared } = await fixture(t);
  const claimed = await bridge(prepared, result({ visualComparisons: [{
    testId: 'responsive-header', actualPath: 'test-results/brl/header.png',
    baselineSha256: H('baseline-image'), diffPath: null,
    differentPixels: 0, totalPixels: 1000
  }] }));
  await assert.rejects(() => buildRevisionBrowserRunReceipt(
    bridgeBoundReceiptInput(prepared, claimed)
  ), { code: 'REV_BROWSER_RESULT_INVALID' });
});

test('BRL schema families and runtime capability boundary are explicit and honest', async () => {
  const registry = new Map(migrationRegistrySnapshot().map((entry) => [entry.id, entry]));
  for (const family of [
    'revision-browser-check', 'revision-browser-run-key', 'revision-browser-run-state',
    'revision-browser-run-receipt', 'revision-browser-comparison'
  ]) {
    assert.equal(registry.get(family)?.currentVersion, 1, family);
    assert.equal(registry.get(family)?.immutable, true, family);
    assert.equal(registry.get(family)?.migrationPolicy, 'frozen-identity', family);
    const schema = JSON.parse(await readFile(
      new URL(`../schemas/${family}.schema.json`, import.meta.url), 'utf8'
    ));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', family);
    assert.equal(schema.additionalProperties, false, family);
    assert.equal(schema.properties.schemaVersion.const, 1, family);
    assert.equal(schema.properties.kind.const, family, family);
  }
  const comparisonSchema = JSON.parse(await readFile(
    new URL('../schemas/revision-browser-comparison.schema.json', import.meta.url), 'utf8'
  ));
  assert.equal(comparisonSchema.properties.staleBindings.maxItems, 16);
  const receiptSchema = JSON.parse(await readFile(
    new URL('../schemas/revision-browser-run-receipt.schema.json', import.meta.url), 'utf8'
  ));
  assert.equal(receiptSchema.$defs.artifact.properties.captureProvenanceSha256.type, 'null');
  assert.equal(receiptSchema.$defs.artifact.properties.previewable.const, false);
  const goldens = JSON.parse(await readFile(
    new URL('./fixtures/schema-migrations/goldens.json', import.meta.url), 'utf8'
  ));
  assert.deepEqual(goldens['revision-browser-check'], [{ schemaVersion: 1 }]);
  assert.deepEqual(goldens['revision-browser-run-key'], [{ schemaVersion: 1 }]);
  assert.deepEqual(goldens['revision-browser-run-state'], [{ schemaVersion: 1 }]);
  assert.deepEqual(goldens['revision-browser-run-receipt'], [{ schemaVersion: 1 }]);
  assert.deepEqual(goldens['revision-browser-comparison'], [{ schemaVersion: 1 }]);
  assert.equal(familyForStoredPath(
    '$git/revision-browser-runs/BRL-aaaaaaaaaaaa/receipt.json'
  )?.id, 'revision-browser-run-receipt');
  assert.equal(revisionRuntimeCapabilities.brlContractsAvailable, true);
  assert.equal(revisionRuntimeCapabilities.brlReceiptStoreAvailable, true);
  assert.equal(revisionRuntimeCapabilities.brlDeterministicComparisonAvailable, false);
  assert.equal(revisionRuntimeCapabilities.brlTrustedBrowserExecutorAvailable, false);
  assert.equal(revisionRuntimeCapabilities.brlCandidateUnderTestAttestationAvailable, false);
  assert.equal(revisionRuntimeCapabilities.brlPublicationBridgeAvailable, false);
  assert.equal(revisionRuntimeCapabilities.codeResultAvailable, false);
});
