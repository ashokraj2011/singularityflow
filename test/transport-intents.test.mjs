import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '../src/util.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';
import {
  createTransportIntent, observeRemoteTarget, readTransportIntent, retryTransportIntent
} from '../src/transport-intents.mjs';
import { subjectLockPath } from '../src/subject-lock.mjs';

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

test('remote target observation requires one exact ref and object ID', () => {
  const targetRef = 'refs/heads/review';
  const commit = 'a'.repeat(40);
  const intent = {
    remoteUrl: '/unused/remote.git', repositoryRoot: '/unused/repository', targetRef
  };
  const observe = (stdout) => observeRemoteTarget(intent, {
    runCommand: () => ({ status: 0, stdout, stderr: '' })
  });
  assert.deepEqual({ readable: observe('').readable, commit: observe('').commit }, {
    readable: true, commit: null
  });
  assert.equal(observe(`${commit}\t${targetRef}\n`).commit, commit);
  for (const output of [
    `not-an-object\t${targetRef}\n`,
    `${commit}\trefs/heads/other\n`,
    `${commit}\t${targetRef}\n${commit}\t${targetRef}\n`,
    `prefix ${commit}\t${targetRef}\n`
  ]) {
    assert.equal(observe(output).readable, false);
  }
});

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

test('proven remote publication never follows a symbolic local tracking ref', async () => {
  const item = await fixture();
  const targetRef = 'refs/heads/symbolic-tracking';
  const trackingRef = 'refs/remotes/origin/symbolic-tracking';
  run('git', ['symbolic-ref', trackingRef, 'refs/heads/main'], { cwd: item.work });
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef, expectedRemote: null
  }, item.options);
  const result = await retryTransportIntent(created.intentId, item.options);
  assert.equal(result.status, 'succeeded');
  assert.equal(run('git', ['symbolic-ref', trackingRef], { cwd: item.work }).stdout.trim(), 'refs/heads/main');
  assert.equal(run('git', ['rev-parse', 'refs/heads/main'], { cwd: item.work }).stdout.trim(), item.commit);
  assert.equal(run('git', ['--git-dir', item.bare, 'rev-parse', targetRef]).stdout.trim(), item.commit);
});

test('proven remote publication leaves a divergent local tracking ref to fetch reconciliation', async () => {
  const item = await fixture();
  await writeFile(path.join(item.work, 'README.md'), 'second\n');
  run('git', ['add', 'README.md'], { cwd: item.work });
  run('git', ['commit', '-qm', 'second'], { cwd: item.work });
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: item.work }).stdout.trim();
  const targetRef = 'refs/heads/divergent-tracking';
  const trackingRef = 'refs/remotes/origin/divergent-tracking';
  run('git', ['update-ref', trackingRef, item.commit], { cwd: item.work });
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit, targetRef, expectedRemote: null
  }, item.options);
  const result = await retryTransportIntent(created.intentId, item.options);
  assert.equal(result.status, 'succeeded');
  assert.equal(run('git', ['rev-parse', trackingRef], { cwd: item.work }).stdout.trim(), item.commit);
  assert.equal(run('git', ['--git-dir', item.bare, 'rev-parse', targetRef]).stdout.trim(), sourceCommit);
});

test('proven leased publication advances only the exact expected local tracking ref', async () => {
  const item = await fixture();
  const targetRef = 'refs/heads/leased-tracking';
  const trackingRef = 'refs/remotes/origin/leased-tracking';
  run('git', ['push', 'origin', `${item.commit}:${targetRef}`], { cwd: item.work });
  run('git', ['update-ref', trackingRef, item.commit], { cwd: item.work });
  await writeFile(path.join(item.work, 'README.md'), 'second\n');
  run('git', ['add', 'README.md'], { cwd: item.work });
  run('git', ['commit', '-qm', 'second'], { cwd: item.work });
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: item.work }).stdout.trim();
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit, targetRef, expectedRemote: item.commit
  }, item.options);
  const result = await retryTransportIntent(created.intentId, item.options);
  assert.equal(result.status, 'succeeded');
  assert.equal(run('git', ['rev-parse', trackingRef], { cwd: item.work }).stdout.trim(), sourceCommit);
  assert.equal(run('git', ['--git-dir', item.bare, 'rev-parse', targetRef]).stdout.trim(), sourceCommit);
});

test('async transport uses only the pinned, leased dry-run and real push descriptors', async () => {
  const item = await fixture();
  const targetRef = 'refs/heads/async-review';
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef, expectedRemote: null
  }, item.options);
  const calls = [];
  const probes = [];
  const result = await retryTransportIntent(created.intentId, {
    ...item.options,
    runAsyncProbeCommand: async (args, options) => {
      probes.push({ args: [...args], options });
      return runRemoteGitAsync(args, options);
    },
    runAsyncCommand: async (args, options) => {
      calls.push({ args: [...args], options });
      return runRemoteGitAsync(args, options);
    }
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(calls.length, 2);
  assert.equal(probes.length, 2, 'both authority observations use the async transport');
  for (const { args, options } of probes) {
    assert.deepEqual(args.slice(0, 2), ['ls-remote', '--refs']);
    assert.match(args[2], /^sflow-frozen-[a-f0-9-]+:$/);
    assert.equal(args[3], targetRef);
    const frozenIndex = Object.entries(options.env)
      .find(([key, value]) => /^GIT_CONFIG_KEY_\d+$/.test(key)
        && value === `url.${item.bare}.insteadOf`)?.[0].slice('GIT_CONFIG_KEY_'.length);
    assert.equal(options.env[`GIT_CONFIG_VALUE_${frozenIndex}`], args[2],
      'the private alias is pinned to the intent URL');
    assert.equal(options.cwd, created.repositoryRoot);
    assert.equal(options.operation, 'remote-probe');
    assert.ok(options.timeoutMs > 0);
    assert.equal(options.maxBuffer, 1024 * 1024);
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
  }
  assert.deepEqual(calls.map(({ args }) => args.includes('--dry-run')), [true, false]);
  for (const { args, options } of calls) {
    assert.equal(args[0], 'push');
    assert.ok(args.includes('--porcelain'));
    assert.ok(args.includes(`--force-with-lease=${targetRef}:`));
    assert.equal(args.at(-1), `${item.commit}:${targetRef}`);
    assert.match(args.at(-2), /^sflow-frozen-[a-f0-9-]+:$/,
      'the configured name is never the retry destination');
    const frozenIndex = Object.entries(options.env)
      .find(([key, value]) => /^GIT_CONFIG_KEY_\d+$/.test(key)
        && value === `url.${item.bare}.insteadOf`)?.[0].slice('GIT_CONFIG_KEY_'.length);
    assert.equal(options.env[`GIT_CONFIG_VALUE_${frozenIndex}`], args.at(-2));
    assert.equal(options.cwd, created.repositoryRoot);
    assert.equal(options.operation, 'remote-push');
    assert.ok(options.timeoutMs > 0);
    assert.equal(options.maxBuffer, 1024 * 1024);
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(options.env.GCM_INTERACTIVE, 'Never');
  }
  assert.equal(run('git', ['--git-dir', item.bare, 'rev-parse', targetRef]).stdout.trim(), item.commit);
});

test('async post-push observation outage preserves exact porcelain proof without another push', async () => {
  const item = await fixture();
  const targetRef = 'refs/heads/async-proof';
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef, expectedRemote: null
  }, item.options);
  let probes = 0;
  const result = await retryTransportIntent(created.intentId, {
    ...item.options,
    runAsyncProbeCommand: async (args, options) => {
      probes += 1;
      if (probes === 2) return { status: 1, stdout: '', stderr: '', timedOut: true };
      return runRemoteGitAsync(args, options);
    }
  });
  assert.equal(probes, 2);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.attempts.at(-1).stage, 'push-proof');
  assert.equal(result.attemptBudget.used, 1);
  assert.equal(run('git', ['--git-dir', item.bare, 'rev-parse', targetRef]).stdout.trim(), item.commit);
  assert.equal((await retryTransportIntent(created.intentId, item.options)).attemptBudget.used, 1);
});

test('an async dry-run deadline never authorizes or starts the real push', async () => {
  const item = await fixture();
  const targetRef = 'refs/heads/async-dry-run-timeout';
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef, expectedRemote: null
  }, item.options);
  const calls = [];
  const timedOut = await retryTransportIntent(created.intentId, {
    ...item.options,
    runAsyncCommand: async (args) => {
      calls.push([...args]);
      return {
        status: 1, stdout: '', stderr: '', timedOut: true,
        failure: { classification: 'network-transient', retryable: true }
      };
    }
  });
  assert.equal(timedOut.status, 'pending');
  assert.equal(timedOut.attempts.at(-1).stage, 'dry-run');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('--dry-run'));
  assert.notEqual(run('git', [
    '--git-dir', item.bare, 'show-ref', '--verify', '--quiet', targetRef
  ], { allowFailure: true }).status, 0);
  assert.equal((await retryTransportIntent(created.intentId, item.options)).status, 'succeeded');
});

test('an async real push with a lost bounded-output acknowledgement reconciles exact remote state', async () => {
  const item = await fixture();
  const targetRef = 'refs/heads/async-overflow-reconcile';
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef, expectedRemote: null
  }, item.options);
  let realPushes = 0;
  const result = await retryTransportIntent(created.intentId, {
    ...item.options,
    runAsyncCommand: async (args, options) => {
      const observed = await runRemoteGitAsync(args, options);
      if (!args.includes('--dry-run')) {
        realPushes += 1;
        assert.equal(observed.status, 0);
        return {
          status: 1, stdout: '', stderr: '', outputOverflow: true,
          failure: { classification: 'unknown', retryable: false }
        };
      }
      return observed;
    }
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(realPushes, 1);
  assert.equal(result.attemptBudget.used, 1);
  assert.equal(result.observedRemote, item.commit);
  assert.equal(run('git', ['--git-dir', item.bare, 'rev-parse', targetRef]).stdout.trim(), item.commit);
  assert.equal((await retryTransportIntent(created.intentId, item.options)).attemptBudget.used, 1,
    'a terminal exact receipt never replays the push');
});

test('transport retry does not steal a fresh acquisition and reclaims an abandoned ownerless lock', async () => {
  const item = await fixture();
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef: 'refs/heads/stale-lease', expectedRemote: null
  }, item.options);
  const lock = subjectLockPath(item.work, { kind: 'transport-intent', id: created.intentId });
  await mkdir(lock, { recursive: true });

  await assert.rejects(
    () => retryTransportIntent(created.intentId, item.options),
    (error) => error?.code === 'TRANSPORT_INTENT_BUSY'
  );
  assert.equal((await readTransportIntent(created.intentId, item.options)).attemptBudget.used, 0);

  const abandonedAt = new Date(Date.now() - 31_000);
  await utimes(lock, abandonedAt, abandonedAt);
  const recovered = await retryTransportIntent(created.intentId, item.options);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(run('git', [
    '--git-dir', item.bare, 'rev-parse', 'refs/heads/stale-lease'
  ]).stdout.trim(), item.commit);
});

test('a successful exact push remains proven when its post-push observation is unavailable', async () => {
  const item = await fixture();
  const targetRef = 'refs/heads/proven-without-observation';
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef, expectedRemote: null
  }, item.options);
  let observations = 0;
  const runCommand = (command, args, options) => {
    if (args[0] === 'ls-remote') {
      observations += 1;
      if (observations === 2) {
        return {
          status: 1, stdout: '', stderr: 'connection reset after receive-pack', signal: null
        };
      }
    }
    return run(command, args, options);
  };

  const result = await retryTransportIntent(created.intentId, { ...item.options, runCommand });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.observedRemote, item.commit);
  assert.equal(result.attempts.at(-1).stage, 'push-proof');
  assert.equal(result.attempts.at(-1).proof.kind, 'git-push-porcelain-transition');
  assert.equal(result.attempts.at(-1).proof.transition, '*');
  assert.match(result.attempts.at(-1).proof.outputSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.healers.at(-1).id, 'remote-push-already-succeeded');
  assert.equal(run('git', ['--git-dir', item.bare, 'rev-parse', targetRef]).stdout.trim(), item.commit);
  assert.equal((await retryTransportIntent(created.intentId, item.options)).status, 'succeeded',
    'the proven terminal receipt is reusable without another transport mutation');
});

test('transport failure evidence redacts credentials and has a hard byte bound', async () => {
  const item = await fixture();
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef: 'refs/heads/redacted-diagnostic', expectedRemote: null
  }, item.options);
  const secret = 'office-secret-do-not-retain';
  const result = await retryTransportIntent(created.intentId, {
    ...item.options,
    runCommand: (command, args, options) => args[0] === 'push' && args.includes('--dry-run')
      ? {
          status: 1,
          stdout: '',
          stderr: `fatal: https://alice:${secret}@corp.example/repo.git token=${secret}\n${'💥'.repeat(6000)}`,
          signal: null
        }
      : run(command, args, options)
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.ok(Buffer.byteLength(result.fault.evidence.diagnostic, 'utf8') <= 4096);
  assert.match(result.fault.evidence.outputSha256, /^sha256:[a-f0-9]{64}$/);
});

test('a pre-commit transport reservation cannot push until its exact local ref is installed', async () => {
  const item = await fixture();
  const targetRef = 'refs/heads/sflow/config-review/reserved';
  const unbound = await createTransportIntent({
    repositoryRoot: item.work,
    sourceCommit: item.commit,
    targetRef,
    expectedRemote: null
  }, item.options);
  const created = await createTransportIntent({
    repositoryRoot: item.work,
    sourceCommit: item.commit,
    targetRef,
    expectedRemote: null,
    scope: { requiredLocalRef: targetRef }
  }, item.options);
  assert.notEqual(created.intentId, unbound.intentId,
    'a generic intent cannot erase the reservation local-ref requirement during deduplication');

  await assert.rejects(
    () => retryTransportIntent(created.intentId, item.options),
    (error) => error?.code === 'TRANSPORT_SOURCE_NOT_INSTALLED'
  );
  assert.equal((await readTransportIntent(created.intentId, item.options)).attemptBudget.used, 0);
  assert.equal(run('git', [
    '--git-dir', item.bare, 'show-ref', '--verify', '--quiet', targetRef
  ], { allowFailure: true }).status, 1);

  run('git', ['update-ref', targetRef, item.commit], { cwd: item.work });
  const published = await retryTransportIntent(created.intentId, item.options);
  assert.equal(published.status, 'succeeded');
  assert.equal(run('git', ['--git-dir', item.bare, 'rev-parse', targetRef]).stdout.trim(), item.commit);
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

test('a historical succeeded receipt is not reused as current remote publication proof', async () => {
  const item = await fixture();
  const targetRef = 'refs/heads/sflow/config-republish';
  const input = {
    repositoryRoot: item.work,
    sourceCommit: item.commit,
    targetRef,
    expectedRemote: null
  };
  const first = await createTransportIntent(input, item.options);
  assert.equal((await retryTransportIntent(first.intentId, item.options)).status, 'succeeded');
  run('git', ['--git-dir', item.bare, 'update-ref', '-d', targetRef]);

  const second = await createTransportIntent(input, item.options);
  assert.notEqual(second.intentId, first.intentId);
  assert.equal(second.status, 'pending');
  assert.equal((await retryTransportIntent(second.intentId, item.options)).status, 'succeeded');
  assert.equal(run('git', ['--git-dir', item.bare, 'rev-parse', targetRef]).stdout.trim(), item.commit);
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
