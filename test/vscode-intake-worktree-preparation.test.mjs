import assert from 'node:assert/strict';
import test from 'node:test';
import { IntakeWorktreePreparation } from '../apps/vscode/src/intake-worktree-preparation.ts';

const baseCommit = 'a'.repeat(40);
const prepared = (workId = 'story', owned = true) => ({ preparation: { status: 'prepared', workId, baseCommit, owned } });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Start takes a finished exact-key preparation without discarding it', async () => {
  const calls = [], helper = new IntakeWorktreePreparation(async args => { calls.push(args); return prepared(); });
  helper.schedule('key', ['start', 'story', '--json']);
  const held = await helper.take('key'); helper.cancel(); await tick();
  assert.equal(held.baseCommit, baseCommit);
  assert.deepEqual(calls, [['start', 'story', '--json', '--prepare-only']]);
});
test('dispose during native checkout settles Git first and then discards only the owned checkout', async () => {
  let finish;
  const calls = [], helper = new IntakeWorktreePreparation(async args => {
    calls.push(args); if (args.includes('--prepare-only')) return new Promise(resolve => { finish = resolve; });
    return { preparation: { status: 'removed' } };
  });
  helper.schedule('key', ['start', 'story']); await tick(); helper.cancel();
  assert.equal(calls.length, 1, 'does not kill a running Git checkout');
  finish(prepared()); await tick(); await tick();
  assert.deepEqual(calls[1], ['start', 'story', '--discard-prepared', '--prepared-base', baseCommit, '--json']);
});
test('rapid selection edits skip queued obsolete requests and serialize their cleanup', async () => {
  const calls = [], helper = new IntakeWorktreePreparation(async args => { calls.push(args); return prepared(args[1]); });
  helper.schedule('old', ['start', 'old']);
  helper.schedule('new', ['start', 'new']);
  assert.equal((await helper.take('new')).workId, 'new');
  assert.deepEqual(calls, [['start', 'new', '--prepare-only']]);
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
