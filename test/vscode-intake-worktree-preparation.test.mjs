import assert from 'node:assert/strict';
import test from 'node:test';
import { IntakeWorktreePreparation } from '../apps/vscode/src/intake-worktree-preparation.ts';
import { SingularityFlowClient } from '../apps/vscode/src/cli/client.ts';

const baseCommit = 'a'.repeat(40);
const prepared = (workId = 'story', owned = true) => ({ preparation: { status: 'prepared', workId, baseCommit, owned } });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('large prepared checkouts share Start host budgets and retain the launch repository after navigation', () => {
  const client = new SingularityFlowClient({ repository: '/unused-launch', location: { cli: '/unused-cli', executable: process.execPath } });
  const pinned = client.forkForRepository(client.repository);
  const budget = client.timeoutFor(['start'], false);
  assert.ok(budget > client.timeoutFor(['status'], false));
  for (const operation of ['prepare-worktree', 'discard-worktree']) {
    assert.equal(client.timeoutFor(['story', operation], false), budget);
  }
  client.useRepository('/unused-other');
  assert.equal(pinned.repository, '/unused-launch');
});

test('Start takes a finished exact-key preparation without discarding it', async () => {
  const calls = [], helper = new IntakeWorktreePreparation(async args => { calls.push(args); return prepared(); });
  helper.schedule('key', ['start', 'story', '--json']);
  const held = await helper.take('key'); helper.cancel(); await tick();
  assert.equal(held.baseCommit, baseCommit);
  assert.deepEqual(calls, [['story', 'prepare-worktree', '--work-id', 'story', '--json']]);
});
test('dispose during native checkout settles Git first and then discards only the owned checkout', async () => {
  let finish;
  const calls = [], helper = new IntakeWorktreePreparation(async args => {
    calls.push(args); if (args.includes('prepare-worktree')) return new Promise(resolve => { finish = resolve; });
    return { preparation: { status: 'removed' } };
  });
  helper.schedule('key', ['start', 'story']); await tick(); helper.cancel();
  assert.equal(calls.length, 1, 'does not kill a running Git checkout');
  finish(prepared()); await tick(); await tick();
  assert.deepEqual(calls[1], ['story', 'discard-worktree', '--work-id', 'story', '--prepared-base', baseCommit, '--json']);
});
test('rapid selection edits skip queued obsolete requests and serialize their cleanup', async () => {
  const calls = [], helper = new IntakeWorktreePreparation(async args => { calls.push(args); return prepared(args[3]); });
  helper.schedule('old', ['start', 'old']);
  helper.schedule('new', ['start', 'new']);
  assert.equal((await helper.take('new')).workId, 'new');
  assert.deepEqual(calls, [['story', 'prepare-worktree', '--work-id', 'new']]);
});
test('a preexisting baseline checkout is never claimed for cancellation cleanup', async () => {
  const calls = [], helper = new IntakeWorktreePreparation(async args => { calls.push(args); return prepared('story', false); });
  helper.schedule('key', ['start', 'story']); await tick(); helper.cancel(); await tick();
  assert.equal(calls.length, 1);
});
test('failed preparation or cleanup never blocks the next Start', async () => {
  const helper = new IntakeWorktreePreparation(async () => { throw new Error('unavailable'); });
  helper.schedule('key', ['start', 'story']); assert.equal(await helper.take('key'), null);
  helper.cancel(); await tick();
});
test('preparation uses the exact preflight remote instead of assuming origin', async () => {
  const calls = [], helper = new IntakeWorktreePreparation(async args => { calls.push(args); return prepared(); });
  helper.schedule('company', ['start', 'story'], 'company');
  await helper.take('company');
  assert.deepEqual(calls, [['story', 'prepare-worktree', '--work-id', 'story', '--remote', 'company']]);
});
