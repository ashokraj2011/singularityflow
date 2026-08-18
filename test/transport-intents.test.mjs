import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '../src/util.mjs';
import {
  createTransportIntent, readTransportIntent, retryTransportIntent
} from '../src/transport-intents.mjs';

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-transport-'));
  const bare = path.join(base, 'remote.git');
  const work = path.join(base, 'work');
  run('git', ['init', '-q', '--bare', bare]);
  run('git', ['init', '-q', '-b', 'main', work]);
  run('git', ['config', 'user.name', 'Transport Test'], { cwd: work });
  run('git', ['config', 'user.email', 'transport@example.test'], { cwd: work });
  await writeFile(path.join(work, 'README.md'), 'first\n');
  run('git', ['add', 'README.md'], { cwd: work });
  run('git', ['commit', '-qm', 'first'], { cwd: work });
  run('git', ['remote', 'add', 'origin', bare], { cwd: work });
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: work }).stdout.trim();
  const env = { ...process.env, SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(base, 'outbox') };
  return { base, bare, work, commit, env, options: { env, home: base } };
}

test('an exact transport intent pushes only its pinned commit to its pinned ref', async () => {
  const item = await fixture();
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef: 'refs/heads/sflow/govern/demo', expectedRemote: null,
    scope: { bootstrapId: 'bst_demo' }
  }, item.options);
  const result = await retryTransportIntent(created.intentId, item.options);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.attemptBudget.used, 1);
  assert.equal(run('git', ['--git-dir', item.bare, 'rev-parse', 'refs/heads/sflow/govern/demo']).stdout.trim(), item.commit);
  assert.equal(run('git', ['--git-dir', item.bare, 'show-ref', '--verify', '--quiet', 'refs/heads/main'], {
    allowFailure: true
  }).status, 1, 'the application branch was not an implicit push destination');
});

test('an already completed remote push is recognized without spending an attempt', async () => {
  const item = await fixture();
  run('git', ['push', 'origin', `${item.commit}:refs/heads/sflow/config`], { cwd: item.work });
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef: 'refs/heads/sflow/config', expectedRemote: null
  }, item.options);
  const result = await retryTransportIntent(created.intentId, item.options);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.attemptBudget.used, 0);
  assert.equal(result.healers.at(-1).id, 'remote-push-already-succeeded');
  assert.equal(result.healers.at(-1).proof.remoteCommit, item.commit);
});

test('creating the same exact transport joins its durable intent instead of duplicating publication', async () => {
  const item = await fixture();
  const input = {
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef: 'refs/heads/sflow/config', expectedRemote: null
  };
  const first = await createTransportIntent(input, item.options);
  const joined = await createTransportIntent(input, item.options);
  assert.equal(joined.intentId, first.intentId);
});

test('a needs-user transport retries only through explicit user authority', async () => {
  const item = await fixture();
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef: 'refs/heads/review', expectedRemote: null
  }, item.options);
  const denied = await retryTransportIntent(created.intentId, {
    ...item.options,
    runCommand: (command, args, options) => args[0] === 'push'
      ? { status: 1, stdout: '', stderr: 'authentication failed', signal: null }
      : run(command, args, options)
  });
  assert.equal(denied.status, 'needs-user');
  await assert.rejects(() => retryTransportIntent(created.intentId, item.options),
    (error) => error.code === 'TRANSPORT_INTENT_NEEDS_USER');
  const recovered = await retryTransportIntent(created.intentId, { ...item.options, allowNeedsUser: true });
  assert.equal(recovered.status, 'succeeded');
});

test('remote divergence is preserved for a human and never overwritten', async () => {
  const item = await fixture();
  run('git', ['push', 'origin', `${item.commit}:refs/heads/review`], { cwd: item.work });
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef: 'refs/heads/review', expectedRemote: item.commit
  }, item.options);

  await writeFile(path.join(item.work, 'README.md'), 'second\n');
  run('git', ['add', 'README.md'], { cwd: item.work });
  run('git', ['commit', '-qm', 'second'], { cwd: item.work });
  const moved = run('git', ['rev-parse', 'HEAD'], { cwd: item.work }).stdout.trim();
  run('git', ['push', 'origin', `${moved}:refs/heads/review`], { cwd: item.work });

  const result = await retryTransportIntent(created.intentId, item.options);
  assert.equal(result.status, 'remote-diverged');
  assert.equal(result.attemptBudget.used, 0);
  assert.equal(result.observedRemote, moved);
  assert.equal(run('git', ['--git-dir', item.bare, 'rev-parse', 'refs/heads/review']).stdout.trim(), moved);
});

test('an unreadable remote after an unknown outcome is never pushed speculatively', async () => {
  const item = await fixture();
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef: 'refs/heads/review', expectedRemote: null
  }, item.options);
  let pushes = 0;
  const runCommand = (command, args, options) => {
    if (args[0] === 'ls-remote') return { status: 1, stdout: '', stderr: 'network is unreachable', signal: null };
    if (args[0] === 'push') pushes += 1;
    return run(command, args, options);
  };
  const result = await retryTransportIntent(created.intentId, { ...item.options, runCommand });
  assert.equal(result.status, 'outcome-unknown');
  assert.equal(pushes, 0);
  assert.equal(result.attemptBudget.used, 0);
});

test('a modified transport record cannot authorize a retry', async () => {
  const item = await fixture();
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef: 'refs/heads/review', expectedRemote: null
  }, item.options);
  const file = path.join(item.env.SINGULARITY_FLOW_TRANSPORT_OUTBOX, 'intents', `${created.intentId}.json`);
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.targetRef = 'refs/heads/main';
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  await assert.rejects(() => readTransportIntent(created.intentId, item.options), (error) => {
    assert.equal(error.code, 'TRANSPORT_INTENT_INTEGRITY_INVALID');
    return true;
  });
});

test('the persisted circuit opens after repeated transient failures and survives another invocation', async () => {
  const item = await fixture();
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef: 'refs/heads/review', expectedRemote: null
  }, item.options);
  const runCommand = (command, args, options) => args[0] === 'push'
    ? { status: 1, stdout: '', stderr: 'connection reset by peer', signal: null }
    : run(command, args, options);
  const first = await retryTransportIntent(created.intentId, { ...item.options, runCommand });
  assert.equal(first.status, 'pending');
  assert.equal(first.circuit.openedAt, null);
  const second = await retryTransportIntent(created.intentId, { ...item.options, runCommand });
  assert.equal(second.status, 'pending');
  assert.ok(second.circuit.openedAt);
  const third = await retryTransportIntent(created.intentId, { ...item.options, runCommand });
  assert.equal(third.attemptBudget.used, 2, 'cooldown does not reset or spend the persistent budget');
  assert.ok(third.cooldown.remainingMs > 0);
});
