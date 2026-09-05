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
  assert.equal(report.schema, 'sflow-wel-benchmark/v2');
  assert.equal(report.assurance, 'content-free-local-measurement');
  assert.ok(['observed', 'unavailable'].includes(report.outcome));
  assert.equal('repositoryPath' in report, false);
  assert.equal('originUrl' in report, false);
  assert.equal('workId' in report, false);
  assert.ok(report.rawReportBytes > 0);
  assert.ok(report.estimatedDurableBytesPerExecution >= 0);
  assert.deepEqual(report.measurementCapabilities, [
    'source-catalog', 'report-ingestion', 'receipt-projection', 'durable-storage-estimate'
  ]);
  assert.equal(report.fixtureOutcomes.falseExact, 0);
  if (report.outcome === 'observed') {
    assert.ok(report.reportIngestionMilliseconds.median >= 0);
    assert.ok(report.receiptProjectionMilliseconds.median >= 0);
    assert.ok(report.cpuMilliseconds.median >= 0);
    assert.equal(report.fixtureOutcomes.exactStatic, 1);
  }
  assert.deepEqual(report.contentExcluded, [
    'repository-path', 'origin-url', 'work-id', 'git-identity', 'clause-text', 'test-body'
  ]);
  assert.doesNotMatch(result.stdout, /sflow-wel-benchmark-[A-Za-z0-9_-]+/);
});
