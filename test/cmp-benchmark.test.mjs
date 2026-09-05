import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('CMP benchmark emits bounded content-free observe-only measurements', () => {
  const result = spawnSync(process.execPath, ['scripts/cmp-benchmark.mjs', '--samples=2'], {
    cwd: process.cwd(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, 'sflow-cmp-benchmark/v1');
  assert.equal(report.assurance, 'content-free-local-measurement');
  assert.equal(report.completedSamples, 2);
  assert.equal(report.outcome, 'observed');
  assert.equal(report.lifecycleGate, false);
  assert.equal(report.authoritative, false);
  assert.ok(report.counts.regions >= 8);
  assert.equal(report.counts.materialRegions, report.counts.regions);
  assert.equal(report.counts.unresolved, report.counts.regions);
  assert.equal(report.counts.unresolvedByCode.CMP_DISPOSITION_MISSING, report.counts.regions);
  assert.equal(report.availability.structuralExtraction, 'not-invoked');
  assert.equal(report.availability.model, 'not-invoked');
  assert.ok(report.storageBytes.manifest > report.storageBytes.recordModePreview);
  assert.ok(report.storageBytes.coverage > report.storageBytes.recordModePreview);
  assert.ok(report.timingsMilliseconds.total.median >= 0);

  const serialized = JSON.stringify(report);
  for (const forbidden of [
    'modified.txt', 'deleted.txt', 'renamed-new.txt', 'settings.yml', 'guide.md',
    'cmp-benchmark@example.invalid', 'CMP Benchmark', 'sha256:'
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  for (const excluded of [
    'repository-path', 'file-path', 'content-digest', 'source-bytes', 'cause-statement',
    'work-id', 'git-identity', 'prompt', 'transcript'
  ]) assert.ok(report.contentExcluded.includes(excluded), excluded);
});

test('CMP benchmark refuses unbounded sample counts', () => {
  const result = spawnSync(process.execPath, ['scripts/cmp-benchmark.mjs', '--samples=101'], {
    cwd: process.cwd(), encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /integer from 1 to 100/);
});
