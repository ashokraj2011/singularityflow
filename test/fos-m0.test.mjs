import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  compareFosSemanticProjections, fosSemanticProjection
} from '../src/fos-semantic-projection.mjs';
import { commandTimer } from '../src/dx-command-timing.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';

const fixture = (name) => new URL(`./fixtures/fos/${name}`, import.meta.url);

test('FOS:M0 trace covers every requirement and acceptance identity without claiming release evidence', async () => {
  const manifest = JSON.parse(await readFile(fixture('trace-manifest.json'), 'utf8'));
  const requirements = Object.values(manifest.milestones).flatMap((entry) => entry.requirements);
  assert.deepEqual([...new Set(requirements)].sort(),
    Array.from({ length: 53 }, (_, index) => `FOS:REQ-${String(index + 1).padStart(3, '0')}`).sort());
  assert.deepEqual([...new Set(manifest.acceptanceCases)].sort(),
    Array.from({ length: 50 }, (_, index) => `FOS:AC-${String(index + 1).padStart(3, '0')}`).sort());
  assert.equal(manifest.status, 'implemented-local-contracts-release-evidence-pending');
  assert.equal(manifest.releaseEvidence.localDeterministicSuites, 'executed');
  assert.equal(manifest.releaseEvidence.controlledPerformanceRunner, 'pending');
  assert.equal(manifest.releaseEvidence.m5LiveAdapterCertification, 'pending');
  assert.equal(manifest.featureDefaultsChanged, false);
});

test('FOS:PARTIAL-AC-035 benchmark manifest separates feedback, completion, requests and spawns', async () => {
  const manifest = JSON.parse(await readFile(new URL('../benchmarks/fos/benchmark-manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.claimsAuthorized, false);
  for (const required of [
    'first-feedback-ms', 'local-completion-ms', 'network-completion-ms',
    'git-request-count', 'git-process-spawn-count'
  ]) assert.ok(manifest.measurements.includes(required), required);
  assert.equal(manifest.budgets, null);
});

test('FOS:PARTIAL-AC-034 terminal timing retains explicit local, network, request and spawn dimensions', () => {
  const timer = commandTimer('onboard', { commandClass: 'mutation', operationId: 'fos-op-test' });
  timer.feedback();
  timer.increment('git.requests', 2);
  timer.increment('git.spawns', 1);
  timer.stage('local-completion');
  timer.stage('network-completion');
  const event = timer.finish();
  assert.equal(event.operationId, 'fos-op-test');
  assert.deepEqual(event.counters, { 'git.requests': 2, 'git.spawns': 1 });
  assert.equal(typeof event.stages['local-completion'], 'number');
  assert.equal(typeof event.stages['network-completion'], 'number');
});

test('FOS:PARTIAL-AC-036 first feedback and command completion are distinct observations', () => {
  const timer = commandTimer('onboard', { commandClass: 'mutation' });
  const first = timer.feedback();
  const event = timer.finish();
  assert.equal(event.firstFeedbackMs, first);
  assert.ok(event.durationMs >= event.firstFeedbackMs);
  assert.notEqual(event.recordedAt, null);
});

test('FOS:AC-037 semantic projection ignores timing identity but not governance', () => {
  const reference = {
    status: 'refused', code: 'EVIDENCE_MISSING', policySha256: 'sha256:a',
    recordedAt: '2026-01-01T00:00:00.000Z', durationMs: 10
  };
  const same = { ...reference, recordedAt: '2026-02-01T00:00:00.000Z', durationMs: 2 };
  const changed = { ...same, code: 'ALLOWED' };
  assert.equal(compareFosSemanticProjections(reference, same).equivalent, true);
  assert.equal(compareFosSemanticProjections(reference, changed).equivalent, false);
  assert.throws(() => fosSemanticProjection(reference, { ignoredKeys: new Set(['code']) }),
    /reviewed non-semantic/);
});

test('FOS:M0 durable families are registered before their writers', () => {
  for (const family of [
    'fos-attachment-descriptor', 'fos-operation-journal',
    'fos-attachment-receipt', 'fos-derived-cache-entry'
  ]) assert.equal(currentSchemaVersion(family), 1);
});
