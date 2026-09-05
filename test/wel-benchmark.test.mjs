import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('WEL benchmark emits only bounded content-free local measurements', () => {
  const result = spawnSync(process.execPath, ['scripts/wel-benchmark.mjs', '--samples=1'], {
    cwd: repository,
    encoding: 'utf8',
    timeout: 60_000
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, 'sflow-wel-benchmark/v4');
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
  assert.equal(report.incrementalReceiptBytes, report.receiptBytes - report.baselineReceiptBytes);
  assert.match(report.timingInterpretation, /signed deltas may be negative/);
  assert.deepEqual(report.measurementCapabilities, [
    'source-catalog', 'report-ingestion', 'receipt-projection', 'durable-storage-estimate',
    'baseline-comparison', 'context-xray-projection', 'story-start-latency',
    'story-push-recovery'
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
