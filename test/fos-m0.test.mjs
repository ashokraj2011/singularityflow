import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  compareFosSemanticProjections, fosSemanticProjection
} from '../src/fos-semantic-projection.mjs';
import {
  commandTimer, interruptedCommandTimings, recordCommandTiming
} from '../src/dx-command-timing.mjs';
import { commandFailureTiming } from '../src/cli-entry.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { SingularityFlowError } from '../src/util.mjs';

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
  assert.equal(manifest.profiles.controlled.minimumSamples, 30);
  assert.equal(manifest.profiles.controlled.warmupRuns, 5);
  assert.deepEqual(Object.keys(manifest.profiles.controlled.fixtures), [
    'small-local', 'reference-local', 'large-local'
  ]);
  assert.equal(manifest.budgets['reference-local'].optimizedWarmGitRequests, 0);
});

test('FOS:AC-034 terminal events distinguish every outcome and recover forced interruption without forged success', async () => {
  const timer = commandTimer('onboard', {
    commandClass: 'mutation', operationId: 'fos-op-test', mode: 'network'
  });
  timer.feedback();
  timer.increment('git.requests', 2);
  timer.increment('git.batch-requests', 2);
  timer.increment('git.spawns', 1);
  timer.increment('git.child-spawns', 3);
  timer.increment('git.service-ms', 14);
  timer.stage('local-completion');
  timer.stage('network-completion');
  const event = timer.finish();
  assert.equal(event.operationId, 'fos-op-test');
  assert.deepEqual(event.counters, {
    'git.requests': 2, 'git.batch-requests': 2, 'git.spawns': 1,
    'git.child-spawns': 3, 'git.service-ms': 14
  });
  assert.equal(event.gitRequests, 2);
  assert.equal(event.batchRequests, 2);
  assert.equal(event.gitSpawns, 1);
  assert.equal(event.gitChildSpawns, 3);
  assert.equal(event.gitMs, 14);
  assert.equal(typeof event.stages['local-completion'], 'number');
  assert.equal(typeof event.stages['network-completion'], 'number');
  assert.throws(() => timer.finish(), /terminal event/);

  const refused = commandFailureTiming(new SingularityFlowError('blocked', { code: 'AUTHORITY_PIN_INVALID' }));
  const cancelled = commandFailureTiming(new SingularityFlowError('cancelled', { code: 'MODEL_CANCELLED' }));
  const recovery = commandFailureTiming(new SingularityFlowError('repair', { code: 'WORK_RECOVERY_REQUIRED' }));
  const failed = commandFailureTiming(new TypeError('unexpected'));
  assert.deepEqual([refused.outcome, cancelled.outcome, recovery.outcome, failed.outcome],
    ['refused', 'cancelled', 'recovery_required', 'error']);

  const completedTimer = commandTimer('status', { invocationId: 'completed-invocation' });
  const completedStart = completedTimer.startEvent();
  const completed = completedTimer.finish();
  const killedStart = commandTimer('status', { invocationId: 'killed-invocation' }).startEvent();
  const interruptions = interruptedCommandTimings([completedStart, killedStart, completed], {
    observedAt: '2026-09-08T00:00:00.000Z'
  });
  assert.equal(interruptions.length, 1);
  assert.equal(interruptions[0].invocationId, 'killed-invocation');
  assert.equal(interruptions[0].outcome, 'unknown');
  assert.equal(interruptions[0].telemetryComplete, false);
  assert.equal(interruptions[0].completedAt, null);

  // A broken best-effort telemetry destination cannot rewrite a completed command outcome.
  await assert.doesNotReject(() => recordCommandTiming('/path/that/is/not/a/git/repository', event));
});

test('FOS:AC-036 delayed network receipt and child work remain inside completion after immediate feedback', () => {
  let monotonic = 0n;
  const clock = () => monotonic;
  const advance = (milliseconds) => { monotonic += BigInt(milliseconds) * 1_000_000n; };
  const timer = commandTimer('onboard', {
    commandClass: 'mutation', mode: 'network', clock,
    wallClock: () => Date.parse('2026-09-08T00:00:00.000Z')
  });
  advance(5);
  const first = timer.feedback();
  advance(20);
  timer.stage('local-work');
  advance(80);
  timer.stage('network-work');
  advance(15);
  timer.stage('receipt-work');
  advance(10);
  timer.stage('child-quiescence');
  const event = timer.finish();
  assert.equal(event.firstFeedbackMs, first);
  assert.equal(event.firstFeedbackMs, 5);
  assert.equal(event.durationMs, 130);
  assert.equal(event.stages['network-work'], 80);
  assert.equal(event.stages['receipt-work'], 15);
  assert.equal(event.stages['child-quiescence'], 10);
  assert.ok(event.durationMs > event.firstFeedbackMs);
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
