import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateWelBenchmarkEvidence } from '../src/wel-benchmark-evidence.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('WEL benchmark emits and privately retains bounded content-free local measurements', async (t) => {
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-benchmark-test-'));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const evidencePath = path.join(evidenceDirectory, 'report.json');
  const result = spawnSync(process.execPath, ['scripts/wel-benchmark.mjs', '--samples=1'], {
    cwd: repository,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, SINGULARITY_FLOW_WEL_BENCHMARK_OUT: evidencePath }
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const retained = JSON.parse(await readFile(evidencePath, 'utf8'));
  assert.deepEqual(retained, report);
  assert.match(validateWelBenchmarkEvidence(retained, {
    platform: process.platform,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    requireObserved: report.outcome === 'observed'
  }).evidenceSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(report.schema, 'sflow-wel-benchmark/v5');
  assert.equal(report.assurance, 'content-free-local-measurement');
  assert.ok(['observed', 'unavailable'].includes(report.outcome));
  assert.equal('repositoryPath' in report, false);
  assert.equal('originUrl' in report, false);
  assert.equal('workId' in report, false);
  assert.ok(report.rawReportBytes > 0);
  assert.ok(report.estimatedDurableBytesPerExecution >= 0);
  assert.ok(report.estimatedDurableIncrementalBytesPerExecution >= 0);
  assert.ok(report.baselineReceiptBytes > 0);
  assert.ok(report.contextXrayBytes > 0);
  assert.ok(report.contextXrayProjectionMilliseconds.median >= 0);
  assert.equal(report.storyStartRequestedSamples, 1);
  assert.equal(report.storyStartCompletedSamples, 1);
  assert.equal(report.storyStartMode, 'governed-local-publication-push-off');
  assert.match(report.storyTimingInterpretation, /synthetic local Story-start transaction/);
  assert.ok(report.storyStartMilliseconds.median >= 0);
  assert.ok(report.storyWorkflowBytes > 0);
  assert.equal(report.storyPushRecovery.outcome, 'recovered');
  assert.match(report.storyPushRecovery.failureCode, /^[A-Z][A-Z0-9_]+$/);
  assert.ok(report.storyPushRecovery.failureMilliseconds >= 0);
  assert.ok(report.storyPushRecovery.recoveryMilliseconds >= 0);
  assert.equal(report.storyPushRecovery.exactRetainedCommitPublished, true);
  assert.match(report.storyRecoveryInterpretation, /not office-network evidence/);
  assert.equal(report.storyOfflineRecovery.outcome, 'recovered');
  assert.match(report.storyOfflineRecovery.failureCode, /^[A-Z][A-Z0-9_]+$/);
  assert.ok(report.storyOfflineRecovery.failureMilliseconds >= 0);
  assert.ok(report.storyOfflineRecovery.recoveryMilliseconds >= 0);
  assert.equal(report.storyOfflineRecovery.exactRetainedCommitPublished, true);
  assert.ok(report.storyOfflineRecovery.freshCloneMilliseconds >= 0);
  assert.equal(report.storyOfflineRecovery.freshCloneExact, true);
  assert.equal(report.storyOfflineRecovery.freshCloneClean, true);
  assert.match(report.storyOfflineRecoveryInterpretation, /not office-network evidence/);
  assert.equal(report.interruptedWriteRecovery.outcome, 'recovered');
  assert.equal(report.interruptedWriteRecovery.failureCode, 'ABRUPT_PROCESS_EXIT');
  assert.ok(report.interruptedWriteRecovery.failureMilliseconds >= 0);
  assert.ok(report.interruptedWriteRecovery.recoveryMilliseconds >= 0);
  assert.equal(report.interruptedWriteRecovery.exactStableStateRestored, true);
  assert.match(report.interruptedWriteInterpretation, /public sync surface/);
  assert.deepEqual(report.adapterCancellation, {
    outcome: 'cancelled-safe',
    milliseconds: report.adapterCancellation.milliseconds,
    exact: false,
    mappingProposals: 0
  });
  assert.ok(report.adapterCancellation.milliseconds >= 0);
  assert.match(report.adapterCancellationInterpretation, /unavailable evidence/);
  assert.equal(report.incrementalReceiptBytes, report.receiptBytes - report.baselineReceiptBytes);
  assert.match(report.timingInterpretation, /signed deltas may be negative/);
  assert.deepEqual(report.measurementCapabilities, [
    'source-catalog', 'report-ingestion', 'receipt-projection', 'durable-storage-estimate',
    'baseline-comparison', 'context-xray-projection', 'story-start-latency',
    'story-push-recovery', 'story-offline-recovery', 'fresh-clone-verification',
    'interrupted-write-recovery', 'adapter-cancellation'
  ]);
  assert.equal(report.fixtureOutcomes.falseExact, 0);
  if (report.outcome === 'observed') {
    assert.ok(report.reportIngestionMilliseconds.median >= 0);
    assert.ok(report.receiptProjectionMilliseconds.median >= 0);
    assert.ok(report.baselineReceiptProjectionMilliseconds.median >= 0);
    assert.equal(
      report.incrementalReceiptProjectionMilliseconds.method,
      'witnessed-minus-unenrolled-same-process'
    );
    assert.ok(report.cpuMilliseconds.median >= 0);
    assert.equal(report.fixtureOutcomes.exactStatic, 1);
  }
  assert.deepEqual(report.contentExcluded, [
    'repository-path', 'origin-url', 'work-id', 'git-identity', 'clause-text', 'test-body'
  ]);
  assert.doesNotMatch(result.stdout, /sflow-wel-benchmark-[A-Za-z0-9_-]+/);
  assert.doesNotMatch(result.stdout,
    /WEL-BENCH-LOCAL|WEL-PERF-001|ctx-welbenchmark|benchmark-structural-item/);
});
