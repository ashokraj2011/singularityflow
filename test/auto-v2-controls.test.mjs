import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  buildAutoFlightReport, createAutoFlightState, discardAutoFlight, haltAutoFlight,
  mutateAutoFlightState, pauseAutoFlight, readAutoFlightReport, readAutoFlightState,
  resumeAutoFlight, takeoverAutoFlight
} from '../src/auto/auto-flight-store.mjs';
import { recordSha256 } from '../src/records.mjs';
import { withSubjectLock } from '../src/subject-lock.mjs';

const PLAN_SHA256 = `sha256:${'a'.repeat(64)}`;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, suffix) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-v2-controls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  const flightId = `AFL-${suffix.repeat(26)}`;
  const state = await createAutoFlightState(root, {
    flightId,
    planId: `APL-${suffix.repeat(26)}`,
    planSha256: PLAN_SHA256,
    status: 'running',
    story: { workId: `WORK-${suffix}`, branch: `work-${suffix}`, phase: 'implementation' },
    worktree: root,
    execution: {
      until: { kind: 'first-human-boundary', phase: null },
      ceilings: {
        maximumAuthoringAttemptsPerPhase: 1,
        maximumModelInvocations: 1
      }
    }
  });
  return { root, flightId, state };
}

async function holdStepLease(root, flightId) {
  const entered = deferred();
  const release = deferred();
  const lease = withSubjectLock(root, { kind: 'auto-flight-step', id: flightId }, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  return { release: release.resolve, lease };
}

const controls = [
  ['pause', 'A', (root, id, options) => pauseAutoFlight(root, id, options)],
  ['halt', 'B', (root, id, options) => haltAutoFlight(root, id, 'human-halted', options)],
  ['takeover', 'C', (root, id, options) => takeoverAutoFlight(root, id, options)]
];

for (const [kind, suffix, control] of controls) {
  test(`${kind} records recovery-required when execution quiescence cannot be proven`, async (t) => {
    const { root, flightId } = await fixture(t, suffix);
    const held = await holdStepLease(root, flightId);
    try {
      await assert.rejects(
        () => control(root, flightId, { quiescenceTimeoutMs: 10 }),
        (error) => error.code === 'AUTO_STOP_TIMEOUT'
          && error.details?.status === 'recovery-required'
          && error.details?.stopRequested?.kind === kind
      );

      const recovery = await readAutoFlightState(root, flightId);
      assert.equal(recovery.status, 'recovery-required');
      assert.equal(recovery.stopReason, `${kind}-quiescence-unproven`);
      assert.equal(recovery.stopRequested.kind, kind);
      assert.match(recovery.stopRequested.requestId, /^[0-9a-f-]{36}$/);
      assert.equal(recovery.lastError.code, 'AUTO_STOP_TIMEOUT');
      const report = buildAutoFlightReport(recovery);
      assert.equal(report.humanIntervention.required, true);
      await assert.rejects(
        () => resumeAutoFlight(root, flightId, recovery.checkpointSha256),
        (error) => error.code === 'AUTO_RECOVERY_REQUIRED'
      );
      await assert.rejects(
        () => discardAutoFlight(root, flightId, flightId),
        (error) => error.code === 'AUTO_RECOVERY_REQUIRED'
      );
    } finally {
      held.release();
      await held.lease;
    }
  });
}

test('manual takeover is durable before waiting and preserves flight evidence', async (t) => {
  const { root, flightId } = await fixture(t, 'D');
  const prepared = await mutateAutoFlightState(root, flightId, (state) => {
    state.position = 'authored';
    state.observedPaths = ['src/app.mjs', 'test/app.test.mjs'];
    state.evidence = { changeSetDigest: `sha256:${'b'.repeat(64)}` };
    state.operations = [{ operation: 'author', outcome: 'succeeded' }];
    state.commits = { generation: '1234567890abcdef' };
  });
  const held = await holdStepLease(root, flightId);
  let taken;
  try {
    const takingOver = takeoverAutoFlight(root, flightId, { quiescenceTimeoutMs: 2_000 });
    let requested = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      requested = await readAutoFlightState(root, flightId);
      if (requested.status === 'manual-takeover') break;
      await delay(10);
    }
    assert.equal(requested.status, 'manual-takeover');
    assert.equal(requested.stopRequested.kind, 'takeover');
    assert.notEqual(requested.checkpointSha256, prepared.checkpointSha256);
    await assert.rejects(
      () => resumeAutoFlight(root, flightId, requested.checkpointSha256),
      (error) => error.code === 'AUTO_STOP_IN_PROGRESS'
    );

    held.release();
    await held.lease;
    taken = await takingOver;
  } finally {
    held.release();
    await held.lease;
  }
  assert.equal(taken.status, 'manual-takeover');
  assert.equal(taken.stopReason, 'human-manual-takeover');
  assert.deepEqual(taken.observedPaths, ['src/app.mjs', 'test/app.test.mjs']);
  assert.deepEqual(taken.evidence, { changeSetDigest: `sha256:${'b'.repeat(64)}` });
  assert.deepEqual(taken.operations, [{ operation: 'author', outcome: 'succeeded' }]);
  assert.deepEqual(taken.commits, { generation: '1234567890abcdef' });
  assert.match(taken.stopRequested.quiescedAt, /^\d{4}-\d{2}-\d{2}T/);
  const report = buildAutoFlightReport(taken);
  assert.deepEqual(report.retainedUnpublishedPaths, taken.observedPaths);
  assert.equal(report.humanIntervention.required, true);

});

test('self-consistent wrong-family state and report records fail closed', async (t) => {
  const { root, flightId } = await fixture(t, 'E');
  const directory = path.join(root, '.git/singularity-flow/auto-flights', flightId);
  const statePath = path.join(directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.kind = 'auto-plan';
  delete state.recordSha256;
  state.recordSha256 = recordSha256(state);
  await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(
    () => readAutoFlightState(root, flightId),
    (error) => error.code === 'AUTO_FLIGHT_CORRUPT'
  );

  state.kind = 'auto-flight-state';
  delete state.recordSha256;
  state.recordSha256 = recordSha256(state);
  await writeFile(statePath, JSON.stringify(state));
  const report = buildAutoFlightReport(state);
  report.kind = 'auto-plan';
  delete report.reportSha256;
  report.reportSha256 = `sha256:${recordSha256(report)}`;
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report));
  await assert.rejects(
    () => readAutoFlightReport(root, flightId),
    (error) => error.code === 'AUTO_FLIGHT_CORRUPT'
  );
});
