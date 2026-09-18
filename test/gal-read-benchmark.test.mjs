import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function run(...args) {
  return spawnSync(process.execPath, ['scripts/gal-read-benchmark.mjs', ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    maxBuffer: 1024 * 1024, windowsHide: true
  });
}

test('GAL read benchmark separates cold discovery and warm object reads with exact parity', () => {
  const result = run('--samples=2', '--objects=16');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, 'sflow-gal-read-benchmark/v1');
  assert.equal(report.authority, 'local-measurement-only');
  assert.equal(report.lifecycleGate, false);
  assert.equal(report.declaredFixtureComplete, false);
  assert.equal(report.releaseQualified, false);
  assert.equal(report.fixture.objectCount, 16);
  assert.equal(report.fixture.objectBytes, 1_024);
  assert.equal(report.fixture.totalBytes, 16 * 1_024);
  assert.match(report.fixture.oidListSha256, /^[0-9a-f]{64}$/u);
  assert.match(report.gitVersion, /^git version /u);
  assert.match(report.sourceRevision, /^[0-9a-f]{40,64}$/u);
  assert.deepEqual(report.parity, {
    referenceExactBytes: true, asyncReferenceExactBytes: true,
    persistentExactBytes: true, persistentBatchExactBytes: true, requiredComplete: true
  });
  for (const profile of Object.values(report.profiles)) {
    assert.equal(profile.trials, 2);
    assert.equal(profile.physicalGitSpawns.length, 2);
    assert.ok(profile.latencyMilliseconds.min >= 0);
    assert.ok(profile.latencyMilliseconds.p95 >= profile.latencyMilliseconds.median);
  }
  assert.ok(report.profiles.coldRuntimeAndRepositoryDiscovery.physicalGitSpawns
    .every((count) => count > 0));
  assert.deepEqual(report.profiles.referenceMetadataFirstSynchronousBatch.physicalGitSpawns,
    [3, 3]);
  assert.deepEqual(report.profiles.referenceMetadataFirstAsyncBatch.physicalGitSpawns,
    [3, 3]);
  assert.deepEqual(report.profiles.referenceMetadataFirstAsyncBatch.logicalRequests,
    [1, 1]);
  assert.deepEqual(report.profiles.warmLegacyBatchWorker.workerSpawns, [0, 0]);
  assert.deepEqual(report.profiles.warmLegacyBatchWorker.logicalRequests, [16, 16]);
  assert.deepEqual(report.profiles.warmExplicitMultiFrameBatchWorker.physicalGitSpawns, [0, 0]);
  assert.deepEqual(report.profiles.warmExplicitMultiFrameBatchWorker.workerSpawns, [0, 0]);
  assert.deepEqual(report.profiles.warmExplicitMultiFrameBatchWorker.logicalRequests, [1, 1]);
  assert.deepEqual(report.profiles.warmExplicitMultiFrameBatchWorker.logicalObjectReads, [16, 16]);
  assert.deepEqual(report.profiles.warmExplicitMultiFrameBatchWorker.workerWrites, [1, 1]);
  const text = result.stdout;
  assert.equal(text.includes('sflow-gal-benchmark-'), false, 'temporary path must not leak');
  assert.equal(text.includes('GAL-FIXTURE-'), false, 'fixture contents must not leak');
});

test('GAL read benchmark chunks explicit multi-frame batches at 128 OIDs', () => {
  const result = run('--samples=1', '--objects=129');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.parity.persistentBatchExactBytes, true);
  assert.deepEqual(report.profiles.warmExplicitMultiFrameBatchWorker.logicalRequests, [2]);
  assert.deepEqual(report.profiles.warmExplicitMultiFrameBatchWorker.logicalObjectReads, [129]);
  assert.deepEqual(report.profiles.warmExplicitMultiFrameBatchWorker.workerWrites, [2]);
  assert.deepEqual(report.profiles.warmExplicitMultiFrameBatchWorker.workerSpawns, [0]);
  assert.deepEqual(report.profiles.warmLegacyBatchWorker.logicalRequests, [129],
    'the existing sequential profile must remain separately measured');
});

test('GAL read benchmark refuses unbounded and unknown arguments', () => {
  for (const args of [
    ['--samples=0'], ['--samples=11'], ['--objects=0'], ['--objects=501'],
    ['--destination=https://example.invalid']
  ]) {
    const result = run(...args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(result.stderr, /GAL_BENCHMARK_FAILED/u);
  }
});
