import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { IntakePreflightScheduler } from '../apps/vscode/src/intake-preflight-scheduler.ts';

function clock() {
  let sequence = 0;
  const tasks = new Map();
  return {
    set(action, delay) { const id = ++sequence; tasks.set(id, { action, delay }); return id; },
    clear(id) { tasks.delete(id); },
    flush() { const pending = [...tasks.values()]; tasks.clear(); pending.forEach(({ action }) => action()); },
    tasks
  };
}

test('rapid option/identifier edits launch one check for the latest request', () => {
  const timers = clock(); const scheduler = new IntakePreflightScheduler(400, timers);
  const checked = [];
  for (const tuple of ['workflow', 'base', 'baseline', 'test-scope', 'identifier']) {
    scheduler.schedule(() => checked.push(tuple));
  }
  assert.equal(timers.tasks.size, 1);
  assert.equal([...timers.tasks.values()][0].delay, 400);
  timers.flush(); assert.deepEqual(checked, ['identifier']);
  timers.flush(); assert.deepEqual(checked, ['identifier']);
});

test('dispose, explicit refresh and invalid requests can cancel queued native work', () => {
  const timers = clock(); const scheduler = new IntakePreflightScheduler(400, timers);
  let calls = 0;
  scheduler.schedule(() => calls++); scheduler.cancel(); scheduler.cancel();
  timers.flush(); assert.equal(calls, 0);
  scheduler.schedule(() => calls++); timers.flush(); assert.equal(calls, 1);
});

test('panel option changes use the scheduler and invalidate receipt/readiness before waiting', async () => {
  const panel = await readFile(new URL('../apps/vscode/src/views/intake-panel.ts', import.meta.url), 'utf8');
  for (const name of ['qualityGateMode', 'readinessBaseline', 'storyTestScope', 'testRecoveryChoice',
    'tracker', 'baseBranch', 'workType']) {
    const body = panel.split(`    ${name}: (message) => {`)[1]?.split('\n    },')[0];
    assert.match(body ?? '', /return this.scheduleIdentifierPreflight\(\)/u, name);
    assert.doesNotMatch(body, /return this.preflightBaseBranch\(\)/u);
  }
  const schedule = panel.split('private scheduleIdentifierPreflight(): void {')[1].split('\n  /**')[0];
  assert.ok(schedule.indexOf('this.cancelBasePreflight()') < schedule.indexOf('this.preflightScheduler.schedule('));
  assert.match(schedule, /basePreflightChecking: pending/u);
  assert.match(panel, /this.intakeReceipt = null/u);
  assert.match(panel, /if \(version !== this.preflightVersion\) return/u);
});
