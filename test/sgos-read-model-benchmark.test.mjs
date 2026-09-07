import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { SGOS_PROJECTED_VIEW_TYPES } from '../src/sgos/projection.mjs';

function run(...args) {
  return spawnSync(process.execPath, ['scripts/sgos-read-model-benchmark.mjs', ...args], {
    cwd: process.cwd(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
  });
}

test('SGOS read-model benchmark is bounded, deterministic, and content-free', () => {
  const result = run('--samples=2', '--enforce');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, 'sflow-sgos-read-model-benchmark/v1');
  assert.equal(report.assurance, 'content-free-local-measurement');
  assert.equal(report.authoritative, false);
  assert.equal(report.lifecycleGate, false);
  assert.equal(report.externalTelemetrySent, false);
  assert.equal(report.modelInvocations, 0);
  assert.equal(report.networkRequests, 0);
  assert.equal(report.outcome, 'passed');
  assert.deepEqual(report.profiles.map((entry) => entry.tasks), [1, 200, 2_000]);
  assert.ok(report.profiles.every((entry) => entry.views === SGOS_PROJECTED_VIEW_TYPES.length));
  assert.ok(report.profiles.every((entry) => entry.completedSamples === 2));
  assert.ok(report.profiles.every((entry) => entry.serializedBytes <= entry.budgets.maximumBytes));
  const serialized = JSON.stringify(report);
  for (const forbidden of [
    'PROC-BENCHMARK', 'TASK-0001', 'sha256:', '/Users/', '\\Users\\', 'benchmark branch'
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  for (const excluded of [
    'process-id', 'task-id', 'record-digest', 'repository-path', 'file-path', 'source-bytes',
    'prompt', 'response', 'identity', 'work-id', 'telemetry-destination'
  ]) assert.ok(report.contentExcluded.includes(excluded), excluded);
});

test('SGOS read-model benchmark refuses unknown and unbounded arguments', () => {
  const unbounded = run('--samples=101');
  assert.notEqual(unbounded.status, 0);
  assert.match(unbounded.stderr, /integer from 1 to 100/u);
  const unknown = run('--destination=https:\/\/collector.invalid');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown argument/u);
});
