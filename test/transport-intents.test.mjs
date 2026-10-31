import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '../src/util.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';
import {
  createTransportIntent, observeRemoteTarget, readTransportIntent, retryTransportIntent
} from '../src/transport-intents.mjs';
import { releaseLeaseAfterReview, subjectLockPath } from '../src/subject-lock.mjs';

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

test('SFlow bookkeeping never overwrites a divergent local tracking ref', async () => {
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
  const trackingWrites = [];
  const result = await retryTransportIntent(created.intentId, {
    ...item.options, runCommand: (command, args, options) => {
      if (args[0] === 'update-ref' && args.includes(trackingRef)) trackingWrites.push(args);
      return run(command, args, options);
    }
  });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(trackingWrites, [], 'the owner must not issue an update against somebody else’s value');
  // Some Git versions update matching remote-tracking refs during push-by-URL themselves. That
  // native convenience cache is not an SFlow CAS write, and cannot be used as publication proof.
  assert.ok([item.commit, sourceCommit].includes(run('git', ['rev-parse', trackingRef], { cwd: item.work }).stdout.trim()));
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

test('local intent authority and retention checks strip hostile Git selectors from the supplied environment', async () => {
  const item = await fixture();
  const targetRef = 'refs/heads/sanitized-local-checks';
  run('git', ['update-ref', targetRef, item.commit], { cwd: item.work });
  const decoy = path.join(item.base, 'decoy.git');
  run('git', ['init', '-q', '--bare', decoy]);
  const hostileEnv = {
    ...item.env,
    SFLOW_TEST_ENV_MARKER: 'preserved',
    GIT_DIR: decoy,
    git_work_tree: item.base,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${decoy}.insteadOf`,
    GIT_CONFIG_VALUE_0: item.bare,
    gIt_TrAcE: path.join(item.base, 'trace.log')
  };
  const localCalls = [];
  const localRunner = (command, args, options = {}) => {
    if (['rev-parse', 'config', 'for-each-ref', 'update-ref'].includes(args[0])) {
      localCalls.push({ args: [...args], env: { ...options.env } });
      assert.equal(options.env?.SFLOW_TEST_ENV_MARKER, 'preserved');
      const keys = Object.keys(options.env ?? {}).map((key) => key.toUpperCase());
      assert.ok(!keys.includes('GIT_DIR'));
      assert.ok(!keys.includes('GIT_WORK_TREE'));
      assert.ok(!keys.includes('GIT_CONFIG_COUNT'));
      assert.ok(!keys.some((key) => /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)));
      assert.ok(!keys.some((key) => /^GIT_TRACE/u.test(key)));
    }
    return run(command, args, options);
  };

  const created = await createTransportIntent({
    repositoryRoot: item.work,
    sourceCommit: item.commit,
    targetRef,
    expectedRemote: null,
    scope: { requiredLocalRef: targetRef }
  }, { env: hostileEnv, home: item.base, runCommand: localRunner });
  assert.equal(created.remoteUrl, item.bare,
    'command-scoped url.* rewrites cannot replace the raw configured authority');

  let probes = 0;
  const result = await retryTransportIntent(created.intentId, {
    env: hostileEnv,
    home: item.base,
    runCommand: localRunner,
    runAsyncProbeCommand: async () => {
      probes += 1;
      return probes === 1
        ? { status: 0, stdout: '', stderr: '' }
        : { status: 0, stdout: `${item.commit}\t${targetRef}\n`, stderr: '' };
    },
    runAsyncCommand: async (args) => ({
      status: 0,
      stdout: args.includes('--dry-run')
        ? ''
        : `*\t${item.commit}:${targetRef}\t[new branch]\n`,
      stderr: ''
    })
  });

  assert.equal(result.status, 'succeeded');
  assert.ok(localCalls.some(({ args }) => args[0] === 'config' && args.includes('remote.origin.url')));
  assert.ok(localCalls.some(({ args }) => args[0] === 'rev-parse'
    && args.includes(`${targetRef}^{commit}`)));
  assert.ok(localCalls.some(({ args }) => args[0] === 'for-each-ref'));
  assert.ok(localCalls.some(({ args }) => args[0] === 'update-ref'));
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

test('a transport lock another machine holds names its owner and reviewed release, never a retry', async () => {
  // TRANSPORT_INTENT_BUSY kept only the intent ID, and sync retried the same intent behind a lock
  // nothing here ever takes over (E2).
  const item = await fixture();
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef: 'refs/heads/held-elsewhere', expectedRemote: null
  }, item.options);
  const subject = { kind: 'transport-intent', id: created.intentId };
  const lock = subjectLockPath(item.work, subject);
  const lockToken = '7c0f2a51-9a36-4d0b-8b5e-0f6a1d2c3b4e';
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(lock, 'owner.json'), `${JSON.stringify({ schemaVersion: 1, subject, pid: 4242,
    host: 'other-laptop.example', machineId: '0a1b2c3d-0000-4000-8000-000000000000', processToken: 'elsewhere',
    lockToken, acquiredAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-01T03:00:00.000Z' })}\n`);
  const release = `singularity-flow lock release transport-intent ${created.intentId} --confirm ${lockToken}`;
  await assert.rejects(() => retryTransportIntent(created.intentId, item.options), (error) => {
    assert.equal(error.code, 'TRANSPORT_INTENT_BUSY');
    assert.equal(error.details.intentId, created.intentId);
    assert.equal(error.details.releaseCommand, release);
    assert.equal(error.details.owner.host, 'other-laptop.example');
    assert.match(error.message, /PID 4242 on other-laptop\.example/u);
    assert.ok(error.message.includes(release), error.message);
    return true;
  });
  assert.equal((await readTransportIntent(created.intentId, item.options)).attemptBudget.used, 0);
  await releaseLeaseAfterReview(item.work, subject, { expectedLockToken: lockToken });
  assert.equal((await retryTransportIntent(created.intentId, item.options)).status, 'succeeded');
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
          stderr: `fatal: https://reviewerone:${secret}@corp.example/repo.git token=${secret}\n${'💥'.repeat(6000)}`,
          signal: null
        }
      : run(command, args, options)
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.ok(Buffer.byteLength(result.fault.evidence.diagnostic, 'utf8') <= 4096);
  assert.doesNotMatch(result.fault.evidence.diagnostics, new RegExp(secret));
  assert.match(result.fault.evidence.outputSha256, /^sha256:[a-f0-9]{64}$/);
});

test('transport evidence preserves timeout and both streams even with oversized stdout', async () => {
  const item = await fixture();
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit, targetRef: 'refs/heads/timeout-evidence'
  }, item.options);
  const result = await retryTransportIntent(created.intentId, {
    ...item.options, runCommand: (command, args, options) => args[0] === 'push'
      ? { status: null, stdout: 'x'.repeat(20000), stderr: 'hook check timed out\nsecond line\n',
          timedOut: true, signal: 'SIGTERM', aborted: false, outputOverflow: false }
      : run(command, args, options)
  });
  assert.equal(result.fault.evidence.timedOut, true);
  assert.equal(result.fault.evidence.signal, 'SIGTERM');
  assert.equal(result.fault.evidence.exitCode, null);
  assert.match(result.fault.evidence.diagnostics, /stderr:\nhook check timed out\nsecond line/u);
  assert.ok(result.fault.evidence.diagnostics.length < 8400);
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
  // The match settles this intent's own operation, named with the digest of its bytes.
  assert.equal(recovered.healers.at(-1).proof.operationId, created.intentId);
  assert.equal(recovered.healers.at(-1).proof.payloadDigest, created.operation.payloadDigest);
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

test('a refusal only a person can clear names its cause, and push status says why and offers the retry', async () => {
  const item = await fixture();
  // An office repository's husky hook judges every push of its application branches, and Git runs it
  // for the dry-run too. SFlow's own branches (sflow/*) are not application code and skip it.
  const hook = path.join(item.work, '.git', 'hooks', 'pre-push');
  await writeFile(hook, '#!/bin/sh\necho "husky - pre-push hook exited with code 1 (npm run lint)" >&2\nexit 1\n');
  run('chmod', ['+x', hook]);
  const own = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit, targetRef: 'refs/heads/sflow/config', expectedRemote: null
  }, item.options);
  assert.equal((await retryTransportIntent(own.intentId, item.options)).status, 'succeeded', 'the hook does not judge sflow/config');
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit, targetRef: 'refs/heads/feature/hooked', expectedRemote: null
  }, item.options);
  const refused = await retryTransportIntent(created.intentId, item.options);
  assert.equal(refused.status, 'needs-user');
  assert.equal(refused.fault.classification, 'local-hook-failed');
  assert.match(refused.fault.evidence.diagnostic, /husky - pre-push hook exited with code 1/u);
  assert.equal(refused.nextAction.command, `singularity-flow push status ${created.intentId}`, 'retrying alone meets the same hook');
  // An automatic caller (a resumed workspace setup) gets the intent and its retry, not a loop back to resume.
  await assert.rejects(retryTransportIntent(created.intentId, item.options), (error) => error.code === 'TRANSPORT_INTENT_NEEDS_USER'
    && error.details.intentId === created.intentId
    && error.details.nextAction.command === `singularity-flow sync ${created.intentId}`
    && /Git refused it \(local-hook-failed: husky - pre-push hook exited with code 1/u.test(error.message));
  // A remote that could not be read leaves the outcome unknown: the retry reconciles it, not push status again.
  const unknown = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit, targetRef: 'refs/heads/feature/unknown', expectedRemote: null
  }, item.options);
  const unread = await retryTransportIntent(unknown.intentId, {
    ...item.options,
    runAsyncProbeCommand: async () => ({ status: 128, stdout: '', stderr: 'fatal: unable to access: Could not resolve host: git.example.invalid', signal: null })
  });
  assert.equal(unread.status, 'outcome-unknown');

  const cli = new URL('../bin/singularity-flow.mjs', import.meta.url).pathname;
  const status = run(process.execPath, [cli, '--no-model', 'push', 'status', created.intentId], { cwd: item.work, env: item.env }).stdout;
  assert.match(status, /is needs-user; commit [0-9a-f]{12} remains addressable\. Git refused it \(local-hook-failed: husky - pre-push hook exited with code 1 \(npm run lint\)\)\. Review the local Git hook output/u);
  assert.match(status, new RegExp(`singularity-flow sync ${created.intentId}`, 'u'), 'after the fix, the retry publishes the same commit');
  const unknownStatus = run(process.execPath, [cli, '--no-model', 'push', 'status', unknown.intentId], { cwd: item.work, env: item.env }).stdout;
  assert.match(unknownStatus, new RegExp(`Retry this preserved publication[\\s\\S]*singularity-flow sync ${unknown.intentId}`, 'u'));
  assert.doesNotMatch(unknownStatus, /Shell: singularity-flow push status/u, 'never a route back to itself');

  // A push the account may not make is a missing write permission, not read access.
  const denied = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit, targetRef: 'refs/heads/denied', expectedRemote: null
  }, item.options);
  const refusedWrite = await retryTransportIntent(denied.intentId, {
    ...item.options,
    runCommand: (command, args, options) => args[0] === 'push' && args.includes('--dry-run')
      ? { status: 128, stdout: '', stderr: 'remote: Permission to org/app.git denied to someone.\nfatal: unable to access: The requested URL returned error: 403', signal: null }
      : run(command, args, options)
  });
  assert.equal(refusedWrite.fault.classification, 'authorization-denied');
  assert.match(refusedWrite.fault.advice, /cannot push to it\. Ask the repository owner for write access/u);

  // The branch moved on (someone else pushed it): the retry explains instead of failing to render.
  await rm(hook);
  await writeFile(path.join(item.work, 'README.md'), 'second\n');
  run('git', ['commit', '-qam', 'second'], { cwd: item.work });
  run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/feature/hooked'], { cwd: item.work });
  const retried = run(process.execPath, [cli, '--no-model', 'push', 'retry', created.intentId], { cwd: item.work, env: item.env }).stdout;
  assert.match(retried, /is remote-diverged after the authorized retry\. Git refused it \(remote-diverged\)\. The remote branch moved after this commit was made/u);
  await assert.rejects(retryTransportIntent(created.intentId, { ...item.options, allowNeedsUser: true }),
    (error) => error.code === 'TRANSPORT_INTENT_NEEDS_USER' && /requires human reconciliation\. The remote branch moved/u.test(error.message));
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

test('saving a push operation again returns its first intent, and its ID with other bytes is refused', async () => {
  const item = await fixture();
  const targetRef = 'refs/heads/sflow/config-operation';
  const input = {
    repositoryRoot: item.work, sourceCommit: item.commit, targetRef, expectedRemote: null,
    operationId: 'sflow.test:operation-1'
  };
  const first = await createTransportIntent(input, item.options);
  assert.equal(first.operation.id, 'sflow.test:operation-1');
  assert.match(first.operation.payloadDigest, /^[0-9a-f]{64}$/u);
  assert.equal((await retryTransportIntent(first.intentId, item.options)).status, 'succeeded');
  // The same operation after its outcome is known: the first outcome, not a second push.
  run('git', ['--git-dir', item.bare, 'update-ref', '-d', targetRef]);
  const again = await createTransportIntent(input, item.options);
  assert.deepEqual([again.intentId, again.status], [first.intentId, 'succeeded']);
  await assert.rejects(
    createTransportIntent({ ...input, targetRef: 'refs/heads/sflow/config-elsewhere' }, item.options),
    (error) => error.code === 'TRANSPORT_OPERATION_ID_REUSED' && error.outcomeClass === 'OPERATION_ID_REUSE'
      && error.details.intentId === first.intentId
  );
  await assert.rejects(
    createTransportIntent({ ...input, operationId: '-not an id' }, item.options),
    (error) => error.code === 'TRANSPORT_OPERATION_ID_INVALID'
  );
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
  // '?' is not a Windows filename; '#' is legal there and still exercises sanitizer collisions.
  const colliding = path.join(item.base, 'remote#blue.git');
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

// A damaged record had no route: no discard, a silent skip in every listing, and `sync <INTENT-ID>`
// refused with the generic plan (sweep B4). It names its file and the person's way to set it aside.
test('a damaged saved push names its file and the person\'s way to set it aside, and listing names it', async () => {
  const item = await fixture();
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit, targetRef: 'refs/heads/review', expectedRemote: null
  }, item.options);
  const file = path.join(item.env.SINGULARITY_FLOW_TRANSPORT_OUTBOX, 'intents', `${created.intentId}.json`);
  const record = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, `${JSON.stringify({ ...record, targetRef: 'refs/heads/main' }, null, 2)}\n`);
  let refusal = null;
  try { await readTransportIntent(created.intentId, item.options); } catch (error) { refusal = error; }
  assert.equal(refusal?.code, 'TRANSPORT_INTENT_INTEGRITY_INVALID');
  assert.equal(refusal.details.file, file);
  assert.equal(refusal.details.nextAction, 'singularity-flow push status --json');
  assert.match(refusal.message, /never authorizes a push/u);
  assert.match(refusal.message, /move that file out of the transport outbox in your own terminal/u);
  const { refusalRemediationPlan } = await import('../src/refusal-remediation.mjs');
  const plan = refusalRemediationPlan(refusal, ['sync', created.intentId]);
  assert.equal(plan.steps[0].command, null, 'the set-aside is the person\'s own step');
  assert.ok(plan.steps[0].label.includes(file), plan.steps[0].label);
  assert.equal(plan.steps[1].command, 'singularity-flow push status --json');

  const { listTransportIntents } = await import('../src/transport-intents.mjs');
  const damaged = [];
  assert.deepEqual(await listTransportIntents({ ...item.options, damaged }), [], 'never offered for retry');
  assert.deepEqual(damaged, [{ intentId: created.intentId, file }]);
  const cli = new URL('../bin/singularity-flow.mjs', import.meta.url).pathname;
  const status = run(process.execPath, [cli, '--no-model', 'push', 'status'], { cwd: item.work, env: item.env }).stdout;
  assert.match(status, /1 saved push record\(s\) failed their integrity check and never authorize a push/u);
  const listed = JSON.parse(run(process.execPath, [cli, '--no-model', 'push', 'status', '--json'], { cwd: item.work, env: item.env }).stdout);
  assert.deepEqual(listed.data.damaged, [{ intentId: created.intentId, file }]);
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
