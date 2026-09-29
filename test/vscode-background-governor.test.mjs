import assert from 'node:assert/strict';
import test from 'node:test';
import { BackgroundWorkGovernor } from '../apps/vscode/src/background-governor.ts';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('optional work runs at once when nothing holds the governor', async () => {
  const governor = new BackgroundWorkGovernor();
  assert.equal(governor.held, false);
  await governor.waitUntilIdle();
});

test('work waits for the last of nested holds, then runs', async () => {
  const governor = new BackgroundWorkGovernor();
  const intake = governor.hold('intake');
  const start = governor.hold('story-start');
  let ran = false;
  const waiting = governor.waitUntilIdle().then(() => { ran = true; });
  intake.release();
  await pause(10);
  assert.equal(ran, false, 'one hold remains');
  start.release();
  start.release();
  await waiting;
  assert.equal(ran, true);
  assert.equal(governor.held, false);
});

test('a hold never defers work past its cap, and an abort ends the wait', async () => {
  const governor = new BackgroundWorkGovernor();
  governor.hold('forgotten');
  const started = Date.now();
  await governor.waitUntilIdle({ maxDeferralMs: 40 });
  assert.ok(Date.now() - started >= 35, 'waited for the cap');
  const controller = new AbortController();
  const aborted = governor.waitUntilIdle({ signal: controller.signal, maxDeferralMs: 60_000 });
  controller.abort();
  await aborted;
});
