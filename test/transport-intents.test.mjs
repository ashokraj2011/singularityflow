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
  assert.equal(run('git', ['rev-parse', 'refs/remotes/origin/sflow/govern/demo'], {
    cwd: item.work
  }).stdout.trim(), item.commit, 'the exact published ref is available through normal origin tracking');
  assert.equal(run('git', ['--git-dir', item.bare, 'show-ref', '--verify', '--quiet', 'refs/heads/main'], {
    allowFailure: true
  }).status, 1, 'the application branch was not an implicit push destination');
});

test('transport intent pins and publishes to the configured push URL', async () => {
  const item = await fixture();
  const pushRemote = path.join(item.base, 'push-remote.git');
  run('git', ['init', '-q', '--bare', pushRemote]);
  run('git', ['remote', 'set-url', '--push', 'origin', pushRemote], { cwd: item.work });
  const targetRef = 'refs/heads/push-authority';
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef, expectedRemote: null
  }, item.options);
  assert.equal(created.remoteUrl, pushRemote);

  const result = await retryTransportIntent(created.intentId, item.options);
  assert.equal(result.status, 'succeeded');
  assert.equal(run('git', ['--git-dir', pushRemote, 'rev-parse', targetRef]).stdout.trim(), item.commit);
  assert.notEqual(run('git', [
    '--git-dir', item.bare, 'show-ref', '--verify', '--quiet', targetRef
  ], { allowFailure: true }).status, 0, 'the fetch URL did not receive the push');
});

test('a fresh intent cannot claim a pre-existing identical remote ref', async () => {
  const item = await fixture();
  run('git', ['push', 'origin', `${item.commit}:refs/heads/sflow/config`], { cwd: item.work });
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef: 'refs/heads/sflow/config', expectedRemote: null
  }, item.options);
  const result = await retryTransportIntent(created.intentId, item.options);
  assert.equal(result.status, 'remote-diverged');
  assert.equal(result.attemptBudget.used, 0);
  assert.equal(result.observedRemote, item.commit);
});

test('an exact remote tip is reconciled after a durably indeterminate push attempt', async () => {
  const item = await fixture();
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef: 'refs/heads/sflow/config', expectedRemote: null
  }, item.options);
  await assert.rejects(() => retryTransportIntent(created.intentId, {
    ...item.options,
    runCommand: (command, args, options) => {
      const result = run(command, args, options);
      if (args[0] === 'push' && !args.includes('--dry-run')) {
        assert.equal(result.status, 0);
        throw new Error('simulated process loss after receive-pack');
      }
      return result;
    }
  }), /simulated process loss/);
  const inFlight = await readTransportIntent(created.intentId, item.options);
  assert.equal(inFlight.status, 'pushing');
  assert.equal(inFlight.attemptBudget.used, 1);
  assert.equal(inFlight.attempts.at(-1).stage, 'push');
  assert.equal(inFlight.attempts.at(-1).result, 'in-flight');

  const recovered = await retryTransportIntent(created.intentId, item.options);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.healers.at(-1).id, 'remote-push-already-succeeded');
  assert.equal(recovered.healers.at(-1).proof.remoteCommit, item.commit);
});

test('a crash in dry-run cannot claim another actor exact update', async (t) => {
  for (const crashPoint of ['before', 'after']) {
    await t.test(`${crashPoint} dry-run completes`, async () => {
      const item = await fixture();
      const targetRef = `refs/heads/dry-run-crash-${crashPoint}`;
      const created = await createTransportIntent({
        repositoryRoot: item.work,
        sourceCommit: item.commit,
        targetRef,
        expectedRemote: null
      }, item.options);

      await assert.rejects(() => retryTransportIntent(created.intentId, {
        ...item.options,
        runCommand: (command, args, options) => {
          if (args[0] === 'push' && args.includes('--dry-run')) {
            if (crashPoint === 'after') {
              const dryRun = run(command, args, options);
              assert.equal(dryRun.status, 0);
            }
            throw new Error(`simulated process loss ${crashPoint} dry-run completion`);
          }
          return run(command, args, options);
        }
      }), /simulated process loss/);

      const interrupted = await readTransportIntent(created.intentId, item.options);
      assert.equal(interrupted.status, 'pending');
      assert.equal(interrupted.attempts.at(-1).stage, 'dry-run');
      assert.equal(interrupted.attempts.at(-1).result, 'in-flight');

      // Another actor installs the same object while this intent is down. The interrupted dry-run
      // is not evidence that this intent acquired the absent->commit transition.
      run('git', ['push', 'origin', `${item.commit}:${targetRef}`], { cwd: item.work });
      const recovered = await retryTransportIntent(created.intentId, item.options);
      assert.equal(recovered.status, 'remote-diverged');
      assert.equal(recovered.observedRemote, item.commit);
      assert.equal(recovered.healers.length, 0);
    });
  }
});

test('an offline dry-run cannot authorize another actor exact update', async () => {
  const item = await fixture();
  const targetRef = 'refs/heads/offline-dry-run';
  const created = await createTransportIntent({
    repositoryRoot: item.work,
    sourceCommit: item.commit,
    targetRef,
    expectedRemote: null
  }, item.options);

  const interrupted = await retryTransportIntent(created.intentId, {
    ...item.options,
    runCommand: (command, args, options) => args[0] === 'push' && args.includes('--dry-run')
      ? { status: 1, stdout: '', stderr: 'offline', signal: null }
      : run(command, args, options)
  });
  assert.equal(interrupted.status, 'needs-user');
  assert.equal(interrupted.fault.classification, 'offline');
  assert.equal(interrupted.attempts.at(-1).stage, 'dry-run');

  run('git', ['push', 'origin', `${item.commit}:${targetRef}`], { cwd: item.work });
  const recovered = await retryTransportIntent(created.intentId, {
    ...item.options,
    allowNeedsUser: true
  });
  assert.equal(recovered.status, 'remote-diverged');
  assert.equal(recovered.observedRemote, item.commit);
  assert.equal(recovered.healers.length, 0);
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

test('an absent-target lease rejects a branch created after the dry-run', async () => {
  const item = await fixture();
  await writeFile(path.join(item.work, 'README.md'), 'second\n');
  run('git', ['add', 'README.md'], { cwd: item.work });
  run('git', ['commit', '-qm', 'second'], { cwd: item.work });
  const source = run('git', ['rev-parse', 'HEAD'], { cwd: item.work }).stdout.trim();
  const parent = run('git', ['rev-parse', 'HEAD^'], { cwd: item.work }).stdout.trim();
  const targetRef = 'refs/heads/review';
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: source,
    targetRef, expectedRemote: null
  }, item.options);

  const pushArguments = [];
  const runCommand = (command, args, options) => {
    if (args[0] !== 'push') return run(command, args, options);
    pushArguments.push([...args]);
    const result = run(command, args, options);
    if (args.includes('--dry-run')) {
      assert.equal(result.status, 0, 'the target was absent during the dry-run');
      run('git', ['push', 'origin', `${parent}:${targetRef}`], { cwd: item.work });
    }
    return result;
  };

  const result = await retryTransportIntent(created.intentId, { ...item.options, runCommand });
  assert.equal(result.status, 'remote-diverged');
  assert.equal(result.observedRemote, parent);
  assert.equal(run('git', ['--git-dir', item.bare, 'rev-parse', targetRef]).stdout.trim(), parent,
    'the concurrent branch was not overwritten even though publication would be a fast-forward');
  assert.equal(pushArguments.length, 2);
  for (const args of pushArguments) {
    assert.ok(args.includes(`--force-with-lease=${targetRef}:`));
  }
});

test('an absent-target intent cannot claim an identical ref created after dry-run', async () => {
  const item = await fixture();
  const targetRef = 'refs/heads/identical-race';
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef, expectedRemote: null
  }, item.options);
  const runCommand = (command, args, options) => {
    if (args[0] !== 'push') return run(command, args, options);
    const result = run(command, args, options);
    if (args.includes('--dry-run')) {
      assert.equal(result.status, 0);
      run('git', ['push', 'origin', `${item.commit}:${targetRef}`], { cwd: item.work });
    }
    return result;
  };

  const result = await retryTransportIntent(created.intentId, { ...item.options, runCommand });
  assert.equal(result.status, 'remote-diverged');
  assert.equal(result.observedRemote, item.commit);
  assert.equal(result.attemptBudget.used, 1);
});

test('retry refuses a configured remote retargeted after intent creation', async () => {
  const item = await fixture();
  const colliding = path.join(item.base, 'remote?blue.git');
  run('git', ['init', '-q', '--bare', colliding]);
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef: 'refs/heads/review', expectedRemote: null
  }, item.options);
  run('git', ['remote', 'set-url', 'origin', colliding], { cwd: item.work });

  await assert.rejects(
    () => retryTransportIntent(created.intentId, item.options),
    (error) => error?.code === 'TRANSPORT_REMOTE_DRIFTED'
  );
  assert.notEqual(run('git', [
    '--git-dir', colliding, 'show-ref', '--verify', '--quiet', 'refs/heads/review'
  ], { allowFailure: true }).status, 0, 'the sanitizer-colliding replacement remote receives nothing');
});

test('retry keeps using its pinned URL when the configured name is retargeted after validation', async () => {
  const item = await fixture();
  const alternate = path.join(item.base, 'alternate.git');
  run('git', ['init', '-q', '--bare', alternate]);
  const targetRef = 'refs/heads/retarget-race';
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef, expectedRemote: null
  }, item.options);
  let retargeted = false;
  const runCommand = (command, args, options) => {
    const result = run(command, args, options);
    if (!retargeted && args[0] === 'remote' && args[1] === 'get-url') {
      retargeted = true;
      run('git', ['remote', 'set-url', 'origin', alternate], { cwd: item.work });
      run('git', ['config', `url.${alternate}.insteadOf`, item.bare], { cwd: item.work });
    }
    return result;
  };

  const result = await retryTransportIntent(created.intentId, { ...item.options, runCommand });
  assert.equal(result.status, 'succeeded');
  assert.equal(run('git', ['--git-dir', item.bare, 'rev-parse', targetRef]).stdout.trim(), item.commit,
    'the authority captured by the intent received the exact commit');
  assert.notEqual(run('git', [
    '--git-dir', alternate, 'show-ref', '--verify', '--quiet', targetRef
  ], { allowFailure: true }).status, 0, 'the retargeted configured name received nothing');
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
