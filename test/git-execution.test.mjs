import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';

import {
  GitRemoteSession, gitRemoteProbeTimeout, gitTimeouts, nonInteractiveGitEnvironment, runRemoteGit,
  runRemoteGitAsync, requireRemoteObservation
} from '../src/git-execution.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import { signalProcessTree } from '../src/util.mjs';
import { enterpriseGitEnvironment } from '../src/git-enterprise-environment.mjs';
import { frozenRemoteTransport } from '../src/git-remote-diagnostics.mjs';

test('one remote session reuses an exact observation and parses the advertised authority', () => {
  const calls = [];
  const runCommand = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      status: 0,
      stdout: [
        'ref: refs/heads/main\tHEAD',
        `${'1'.repeat(40)}\tHEAD`,
        `${'2'.repeat(40)}\trefs/heads/main`,
        `${'3'.repeat(40)}\trefs/heads/sflow/config`
      ].join('\n'),
      stderr: '', timedOut: false
    };
  };
  const session = new GitRemoteSession({ runCommand });
  const options = { refs: ['refs/heads/sflow/config'], includeHead: true, includeAllHeads: true };
  const first = session.observe('https://example.com/acme/repository.git', options);
  const second = session.observe('https://example.com/acme/repository.git', options);

  assert.equal(first, second);
  assert.equal(calls.length, 1);
  assert.equal(first.defaultBranch, 'main');
  assert.equal(first.refs.get('refs/heads/sflow/config'), '3'.repeat(40));
  assert.deepEqual(first.branches, ['main', 'sflow/config']);
  assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(calls[0].options.env.GCM_INTERACTIVE, 'Never');
  assert.equal(calls[0].options.timeoutMs, gitTimeouts().probe);

  session.observe('https://example.com/acme/repository.git', { ...options, refresh: true });
  assert.equal(calls.length, 2);
});

test('remote sessions forward their verified cwd to sync and async Git observations', async () => {
  const cwd = path.join(os.tmpdir(), 'sflow-verified-repository');
  const syncCalls = [];
  const asyncCalls = [];
  const session = new GitRemoteSession({
    cwd,
    runCommand(_command, _args, options) {
      syncCalls.push(options);
      return {
        status: 0,
        stdout: `${'1'.repeat(40)}\trefs/heads/sflow/config\n`,
        stderr: '', timedOut: false, failure: null
      };
    },
    async runAsyncCommand(_args, options) {
      asyncCalls.push(options);
      return {
        status: 0,
        stdout: `${'2'.repeat(40)}\trefs/heads/state\n`,
        stderr: '', timedOut: false, failure: null
      };
    }
  });

  session.observe('https://example.com/acme/sync.git', {
    refs: ['refs/heads/sflow/config'], includeHead: false
  });
  await session.observeAsync('https://example.com/acme/async.git', {
    refs: ['refs/heads/state'], includeHead: false
  });

  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].cwd, cwd);
  assert.equal(asyncCalls.length, 1);
  assert.equal(asyncCalls[0].cwd, cwd);
});

test('remote sessions refuse non-HEAD symbolic authority instead of accepting its target OID', () => {
  const session = new GitRemoteSession({
    runCommand() {
      return {
        status: 0,
        stdout: [
          'ref: refs/heads/main\trefs/heads/proposal',
          `${'2'.repeat(40)}\trefs/heads/proposal`
        ].join('\n'),
        stderr: '', timedOut: false, failure: null
      };
    }
  });

  const observed = session.observe('https://example.com/acme/repository.git', {
    refs: ['refs/heads/proposal'], includeHead: false
  });
  assert.equal(observed.ok, false);
  assert.equal(observed.failure.code, 'REMOTE_SYMBOLIC_REF_UNSUPPORTED');
  assert.equal(observed.failure.retryable, false);
});

test('remote sessions refuse duplicate and malformed successful reference advertisements', () => {
  for (const stdout of [
    `${'1'.repeat(40)}\trefs/heads/sflow/config\n${'2'.repeat(40)}\trefs/heads/sflow/config\n`,
    `${'1'.repeat(40)}\trefs/heads/sflow/config\nunframed-provider-output\n`,
    `${'1'.repeat(40)}\trefs/heads/../configuration\n`,
    `${'1'.repeat(40)}\trefs/heads/.configuration\n`,
    `${'1'.repeat(40)}\trefs/heads/configuration.lock\n`,
    `${'1'.repeat(40)}\trefs/heads/configuration@{1}\n`,
    `ref: refs/tags/v1\tHEAD\n${'1'.repeat(40)}\tHEAD\n`,
    `ref: refs/heads/../main\tHEAD\n${'1'.repeat(40)}\tHEAD\n`
  ]) {
    const session = new GitRemoteSession({
      runCommand() {
        return { status: 0, stdout, stderr: '', timedOut: false, failure: null };
      }
    });
    const observed = session.observe('https://example.com/acme/repository.git', {
      refs: ['refs/heads/sflow/config'], includeHead: false
    });
    assert.equal(observed.ok, false);
    assert.equal(observed.failure.code, 'REMOTE_PROTOCOL_INVALID');
    assert.equal(observed.failure.retryable, false);
  }
});

test('remote sessions never admit invalid UTF-8 authority bytes as replacement-character refs', async () => {
  const invalid = Buffer.from([
    ...Buffer.from(`${'1'.repeat(40)}\trefs/heads/`, 'ascii'),
    0x80,
    0x0a
  ]);
  const sync = new GitRemoteSession({
    runCommand() {
      return { status: 0, stdout: invalid, stderr: Buffer.alloc(0), timedOut: false };
    }
  }).observe('https://example.com/acme/invalid-sync.git', {
    refs: ['refs/heads/main'], includeHead: false
  });
  assert.equal(sync.ok, false);
  assert.equal(sync.failure.code, 'REMOTE_PROTOCOL_INVALID');
  assert.equal(sync.refs.size, 0);

  const async = await new GitRemoteSession({
    async runAsyncCommand() {
      return { status: 0, stdout: invalid, stderr: Buffer.alloc(0), timedOut: false };
    }
  }).observeAsync('https://example.com/acme/invalid-async.git', {
    refs: ['refs/heads/main'], includeHead: false
  });
  assert.equal(async.ok, false);
  assert.equal(async.failure.code, 'REMOTE_PROTOCOL_INVALID');
  assert.equal(async.refs.size, 0);
});

test('local Git authorities retain a bounded configuration window instead of a network probe window', async () => {
  const env = {
    ...process.env,
    SINGULARITY_FLOW_GIT_PREFLIGHT_TIMEOUT_MS: '101',
    SINGULARITY_FLOW_GIT_CONFIGURATION_TIMEOUT_MS: '202'
  };
  assert.equal(gitRemoteProbeTimeout('https://example.com/repository.git', env), 101);
  assert.equal(gitRemoteProbeTimeout('/tmp/repository.git', env), 202);
  assert.equal(gitRemoteProbeTimeout('file:///tmp/repository.git', env), 202);
  assert.equal(gitRemoteProbeTimeout('C:\\source\\repository.git', env), 202);

  const calls = [];
  const session = new GitRemoteSession({
    env,
    async runAsyncCommand(_args, options) {
      calls.push(options);
      return { status: 0, stdout: '', stderr: '', timedOut: false, failure: null };
    }
  });
  await session.observeAsync('/tmp/repository.git');
  assert.equal(calls[0].timeoutMs, 202);
});

test('an all-heads observation satisfies later head subsets without another remote process', () => {
  const calls = [];
  const runCommand = (_command, args) => {
    calls.push(args);
    return {
      status: 0,
      stdout: [
        'ref: refs/heads/main\tHEAD',
        `${'1'.repeat(40)}\tHEAD`,
        `${'2'.repeat(40)}\trefs/heads/main`,
        `${'3'.repeat(40)}\trefs/heads/sflow/config`
      ].join('\n'),
      stderr: '', timedOut: false
    };
  };
  const session = new GitRemoteSession({ runCommand });
  const remote = 'https://example.com/acme/superset.git';
  const broad = session.observe(remote, { includeHead: true, includeAllHeads: true });
  const head = session.observe(remote, { includeHead: true });
  const config = session.observe(remote, {
    includeHead: false, refs: ['refs/heads/sflow/config']
  });

  assert.equal(head, broad);
  assert.equal(config, broad);
  assert.equal(calls.length, 1);
});

test('remote-session invalidation uses exact transport identity rather than a display-sanitized URL', () => {
  const calls = [];
  const blue = '/tmp/repository.git?blue';
  const red = '/tmp/repository.git?red';
  const runCommand = (_command, args, options) => {
    const transport = args[args.indexOf('--') + 1];
    const valueEntry = Object.entries(options.env).find(([key, value]) =>
      /^GIT_CONFIG_VALUE_\d+$/.test(key) && value === transport);
    const index = valueEntry?.[0].match(/\d+$/)?.[0];
    const key = index == null ? '' : options.env[`GIT_CONFIG_KEY_${index}`];
    const remote = key.startsWith('url.') && key.endsWith('.insteadOf')
      ? key.slice('url.'.length, -'.insteadOf'.length)
      : transport;
    calls.push(remote);
    return {
      status: 0,
      stdout: `${remote === blue ? 'a'.repeat(40) : 'b'.repeat(40)}\trefs/heads/main\n`,
      stderr: ''
    };
  };
  const session = new GitRemoteSession({ runCommand });
  session.observe(blue, { refs: ['refs/heads/main'], includeHead: false });
  session.observe(red, { refs: ['refs/heads/main'], includeHead: false });
  session.invalidate(blue);
  session.observe(red, { refs: ['refs/heads/main'], includeHead: false });
  session.observe(blue, { refs: ['refs/heads/main'], includeHead: false });

  assert.deepEqual(calls, [blue, red, blue],
    'invalidating one exact endpoint retains a distinct endpoint that has the same display URL');
});

test('one remote session coalesces exact async observations while distinct remotes run concurrently', async () => {
  const calls = [];
  const releases = [];
  let active = 0;
  let maximumActive = 0;
  const runAsyncCommand = (args) => new Promise((resolve) => {
    calls.push(args);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    releases.push(() => {
      active -= 1;
      resolve({
        status: 0,
        stdout: `ref: refs/heads/main\tHEAD\n${'1'.repeat(40)}\tHEAD\n${'2'.repeat(40)}\trefs/heads/main`,
        stderr: '', timedOut: false, failure: null
      });
    });
  });
  const session = new GitRemoteSession({ runAsyncCommand });
  const first = session.observeAsync('https://example.com/acme/one.git');
  const duplicate = session.observeAsync('https://example.com/acme/one.git');
  const independent = session.observeAsync('https://example.com/acme/two.git');

  await Promise.resolve();
  assert.equal(calls.length, 2, 'the exact duplicate shares one in-flight ls-remote');
  assert.equal(maximumActive, 2, 'independent authorities are observed concurrently');
  releases.splice(0).forEach((release) => release());
  const [one, same, two] = await Promise.all([first, duplicate, independent]);
  assert.equal(one, same);
  assert.equal(one.defaultBranch, 'main');
  assert.equal(two.defaultBranch, 'main');

  assert.equal(await session.observeAsync('https://example.com/acme/one.git'), one);
  assert.equal(calls.length, 2, 'the completed exact observation remains operation-scoped cached');
});

test('a pending all-heads observation coalesces concurrent subset requests', async () => {
  let release;
  let calls = 0;
  const session = new GitRemoteSession({
    runAsyncCommand: () => new Promise((resolve) => {
      calls += 1;
      release = () => resolve({
        status: 0,
        stdout: `ref: refs/heads/main\tHEAD\n${'1'.repeat(40)}\tHEAD\n${'2'.repeat(40)}\trefs/heads/main`,
        stderr: '', timedOut: false, failure: null
      });
    })
  });
  const remote = 'https://example.com/acme/pending-superset.git';
  const broad = session.observeAsync(remote, { includeHead: true, includeAllHeads: true });
  const subset = session.observeAsync(remote, {
    includeHead: false, refs: ['refs/heads/main']
  });

  assert.equal(calls, 1);
  release();
  const [all, main] = await Promise.all([broad, subset]);
  assert.equal(main, all);
  assert.equal(calls, 1);
});

test('a failed broad observation never suppresses a successful exact-ref retry', async () => {
  let calls = 0;
  const session = new GitRemoteSession({
    runAsyncCommand: async (args) => {
      calls += 1;
      const broad = args.includes('refs/heads/*');
      return broad
        ? {
            status: 1, stdout: '', stderr: '', timedOut: false, outputOverflow: true,
            failure: { code: 'REMOTE_OUTPUT_LIMIT', classification: 'unknown', retryable: true }
          }
        : {
            status: 0, stdout: `${'2'.repeat(40)}\trefs/heads/main\n`, stderr: '',
            timedOut: false, failure: null
          };
    }
  });
  const remote = 'https://example.com/acme/failed-broad.git';
  assert.equal((await session.observeAsync(remote, {
    includeHead: false, includeAllHeads: true
  })).ok, false);
  const exact = await session.observeAsync(remote, {
    includeHead: false, refs: ['refs/heads/main']
  });

  assert.equal(exact.ok, true);
  assert.equal(exact.refs.get('refs/heads/main'), '2'.repeat(40));
  assert.equal(calls, 2);
});

test('a narrow waiter retries after its pending broad observation fails', async () => {
  let releaseBroad;
  let calls = 0;
  const session = new GitRemoteSession({
    runAsyncCommand: (args) => {
      calls += 1;
      if (args.includes('refs/heads/*')) {
        return new Promise((resolve) => {
          releaseBroad = () => resolve({
            status: 1, stdout: '', stderr: '', timedOut: true,
            failure: { code: 'REMOTE_TIMEOUT', classification: 'network-transient', retryable: true }
          });
        });
      }
      return Promise.resolve({
        status: 0, stdout: `${'3'.repeat(40)}\trefs/heads/main\n`, stderr: '',
        timedOut: false, failure: null
      });
    }
  });
  const remote = 'https://example.com/acme/pending-failed-broad.git';
  const broad = session.observeAsync(remote, { includeHead: false, includeAllHeads: true });
  const narrow = session.observeAsync(remote, {
    includeHead: false, refs: ['refs/heads/main']
  });
  assert.equal(calls, 1);
  releaseBroad();

  assert.equal((await broad).ok, false);
  assert.equal((await narrow).ok, true);
  assert.equal(calls, 2);
});

test('refresh invalidates broader cached and in-flight observation shapes', async () => {
  let calls = 0;
  const session = new GitRemoteSession({
    runAsyncCommand: async () => {
      calls += 1;
      return {
        status: 0,
        stdout: `ref: refs/heads/main\tHEAD\n${String(calls).repeat(40)}\tHEAD\n${String(calls).repeat(40)}\trefs/heads/main`,
        stderr: '', timedOut: false, failure: null
      };
    }
  });
  const remote = 'https://example.com/acme/refresh-superset.git';
  await session.observeAsync(remote, { includeHead: true, includeAllHeads: true });
  await session.observeAsync(remote, {
    includeHead: false, refs: ['refs/heads/main'], refresh: true
  });
  await session.observeAsync(remote, { includeHead: true, includeAllHeads: true });

  assert.equal(calls, 3,
    'a narrow refresh must not leave a stale broad observation available for reuse');
});

test('invalidating a remote prevents its older in-flight observation from repopulating the cache', async () => {
  const releases = [];
  let calls = 0;
  const session = new GitRemoteSession({
    runAsyncCommand: () => new Promise((resolve) => {
      calls += 1;
      releases.push(() => resolve({
        status: 0,
        stdout: `ref: refs/heads/main\tHEAD\n${String(calls).repeat(40)}\tHEAD`,
        stderr: '', timedOut: false, failure: null
      }));
    })
  });
  const remote = 'https://example.com/acme/repository.git';
  const stale = session.observeAsync(remote);
  session.invalidate(remote);
  releases.shift()();
  await stale;

  const fresh = session.observeAsync(remote);
  assert.equal(calls, 2, 'invalidation forces a new observation after the stale request completes');
  releases.shift()();
  await fresh;
});

test('out-of-order refreshed observations never replace the newest requested generation', async () => {
  const releases = [];
  let calls = 0;
  const session = new GitRemoteSession({
    runAsyncCommand: () => new Promise((resolve) => {
      calls += 1;
      const sha = String(calls).repeat(40);
      releases.push(() => resolve({
        status: 0, stdout: `ref: refs/heads/main\tHEAD\n${sha}\tHEAD`,
        stderr: '', timedOut: false, failure: null
      }));
    })
  });
  const remote = 'https://example.com/acme/refresh-order.git';
  const older = session.observeAsync(remote, { refresh: true });
  const newer = session.observeAsync(remote, { refresh: true });
  releases[1]();
  const newestObservation = await newer;
  releases[0]();
  await older;

  assert.equal(await session.observeAsync(remote), newestObservation,
    'an older request completing last cannot overwrite the newer generation');
});

test('a synchronous observation supersedes an older asynchronous request', async () => {
  let release;
  const session = new GitRemoteSession({
    runCommand: () => ({
      status: 0, stdout: `ref: refs/heads/main\tHEAD\n${'2'.repeat(40)}\tHEAD`,
      stderr: '', timedOut: false
    }),
    runAsyncCommand: () => new Promise((resolve) => {
      release = () => resolve({
        status: 0, stdout: `ref: refs/heads/main\tHEAD\n${'1'.repeat(40)}\tHEAD`,
        stderr: '', timedOut: false, failure: null
      });
    })
  });
  const remote = 'https://example.com/acme/sync-wins.git';
  const older = session.observeAsync(remote);
  const newest = session.observe(remote, { refresh: true });
  release();
  await older;
  assert.equal(session.observe(remote), newest);
});

test('cached enterprise Git policy does not freeze operation-local process environment', (t) => {
  const key = 'SINGULARITY_FLOW_CAPABILITY_PUSH_RECOVERY';
  const previous = process.env[key];
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });

  const before = enterpriseGitEnvironment();
  const recoveryDirectory = path.join(os.tmpdir(), `sflow-recovery-${process.pid}`);
  process.env[key] = recoveryDirectory;
  const after = enterpriseGitEnvironment();

  assert.notEqual(after, before, 'the attested environment itself must not be process-cached');
  assert.equal(after[key], recoveryDirectory,
    'a later operation retains its current recovery context while reusing reviewed Git policy');
});

test('remote execution is bounded, non-interactive, and classifies failures once', () => {
  let invocation;
  const result = runRemoteGit(['fetch', 'origin'], {
    cwd: '/tmp/example', operation: 'remote-configuration', timeoutMs: 4321,
    env: { PATH: process.env.PATH, CUSTOM_PROXY: 'preserved' },
    runCommand(command, args, options) {
      invocation = { command, args, options };
      return {
        status: 1, stdout: '', stderr: 'fatal: could not read Username: terminal prompts disabled',
        timedOut: false
      };
    }
  });

  assert.equal(invocation.options.timeoutMs, 4321);
  assert.equal(invocation.options.env.CUSTOM_PROXY, 'preserved');
  assert.equal(invocation.options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(result.failure.classification, 'authentication-required');
  assert.equal(result.failure.retryable, true);
});

test('zero-exit Git results are accepted only when every execution boundary is clean', async (t) => {
  const oid = '7'.repeat(40);
  const advertised = [
    'ref: refs/heads/main\tHEAD',
    `${oid}\tHEAD`,
    `${oid}\trefs/heads/main`
  ].join('\n');
  const clean = {
    status: 0,
    stdout: advertised,
    stderr: '',
    error: undefined,
    signal: null,
    timedOut: false,
    aborted: false,
    outputOverflow: false,
    blocked: false
  };
  const poisoned = [
    ['error', { error: Object.assign(new Error('bounded execution failed'), { code: 'ETIMEDOUT' }) }],
    ['signal', { signal: 'SIGTERM' }],
    ['timedOut', { timedOut: true }],
    ['aborted', { aborted: true }],
    ['outputOverflow', { outputOverflow: true }],
    ['blocked', { blocked: true }]
  ];

  await t.test('clean zero exit remains a reusable successful observation', () => {
    const result = runRemoteGit(['ls-remote', 'origin'], {
      runCommand: () => ({ ...clean })
    });
    assert.equal(result.failure, null);

    let calls = 0;
    const session = new GitRemoteSession({
      runCommand() {
        calls += 1;
        return { ...clean };
      }
    });
    const first = session.observe('https://example.com/acme/clean.git');
    const second = session.observe('https://example.com/acme/clean.git');
    assert.equal(first, second);
    assert.equal(calls, 1);
    assert.equal(first.ok, true);
    assert.equal(first.defaultBranch, 'main');
    assert.equal(first.refs.get('refs/heads/main'), oid);
  });

  for (const [name, poison] of poisoned) {
    await t.test(name, () => {
      const runCommand = () => ({ ...clean, ...poison });
      const result = runRemoteGit(['ls-remote', 'origin'], { runCommand });
      assert.ok(result.failure, `${name} must classify a zero-exit result as failed`);

      assert.throws(() => runRemoteGit(['ls-remote', 'origin'], {
        runCommand,
        allowFailure: false
      }), (error) => typeof error?.code === 'string' && error.code.startsWith('REMOTE_'));

      const session = new GitRemoteSession({ runCommand });
      const observed = session.observe(`https://example.com/acme/${name}.git`);
      assert.equal(observed.ok, false);
      assert.equal(observed.defaultBranch, null);
      assert.equal(observed.refs.size, 0,
        `${name} must not admit refs from an incomplete execution`);
      assert.deepEqual(observed.branches, []);
      assert.ok(observed.failure);
    });
  }
});

test('remote execution strips mixed-case repository selectors and hostile counted config', () => {
  let invocation;
  const result = runRemoteGit(['ls-remote', 'origin'], {
    cwd: '/tmp/example',
    env: {
      ...process.env,
      HTTPS_PROXY: 'http://proxy.example.test',
      git_dir: 'C:\\hostile\\repository.git',
      Git_Work_Tree: 'C:\\hostile\\worktree',
      gIt_InDeX_fIlE: 'C:\\hostile\\index',
      git_terminal_prompt: '1',
      Gcm_Interactive: 'Always',
      Git_Config_Count: '1',
      git_config_key_0: 'url.https://attacker.invalid/.insteadOf',
      GIT_CONFIG_VALUE_0: 'https://approved.example.test/'
    },
    runCommand(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stdout: '', stderr: '', timedOut: false };
    }
  });

  assert.equal(result.status, 0);
  const keys = Object.keys(invocation.options.env).map((key) => key.toUpperCase());
  assert.equal(keys.includes('GIT_DIR'), false);
  assert.equal(keys.includes('GIT_WORK_TREE'), false);
  assert.equal(keys.includes('GIT_INDEX_FILE'), false);
  assert.equal(keys.filter((key) => key === 'GIT_TERMINAL_PROMPT').length, 1);
  assert.equal(keys.filter((key) => key === 'GCM_INTERACTIVE').length, 1);
  assert.equal(invocation.options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(invocation.options.env.GCM_INTERACTIVE, 'Never');
  const count = Number(invocation.options.env.GIT_CONFIG_COUNT);
  for (let index = 0; index < count; index += 1) {
    assert.notEqual(
      invocation.options.env[`GIT_CONFIG_KEY_${index}`],
      'url.https://attacker.invalid/.insteadOf'
    );
  }
  assert.equal(invocation.options.env.HTTPS_PROXY, 'http://proxy.example.test');
});

test('remote execution preserves only marked enterprise entries and its SFlow frozen alias', () => {
  const query = (_command, args) => {
    if (args.includes('--system')) {
      return {
        status: 0, stdout: 'credential.helper\nsflow-enterprise-helper\0', stderr: '',
        error: undefined, timedOut: false, outputOverflow: false, blocked: false, aborted: false,
        signal: null
      };
    }
    return {
      status: 1, stdout: '', stderr: '', error: undefined, timedOut: false,
      outputOverflow: false, blocked: false, aborted: false, signal: null
    };
  };
  const approved = enterpriseGitEnvironment({ ...process.env }, { runCommand: query });
  const transport = frozenRemoteTransport('https://git.example.test/team/repository.git', {
    push: true, env: approved
  });
  let invocation;
  const result = runRemoteGit(['ls-remote', transport.remote], {
    // Transport intents add the no-prompt policy before handing the environment to the shared
    // executor. That derived object must retain the private alias attestation.
    env: nonInteractiveGitEnvironment(transport.env),
    runCommand(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stdout: '', stderr: '', timedOut: false };
    }
  });

  assert.equal(result.status, 0);
  const entries = Array.from({ length: Number(invocation.options.env.GIT_CONFIG_COUNT) }, (_, index) => [
    invocation.options.env[`GIT_CONFIG_KEY_${index}`],
    invocation.options.env[`GIT_CONFIG_VALUE_${index}`]
  ]);
  assert.ok(entries.some(([key, value]) => key === 'credential.helper'
    && value === 'sflow-enterprise-helper'));
  assert.ok(entries.some(([key, value]) => key === 'url.https://git.example.test/team/repository.git.insteadOf'
    && value === transport.remote));
  assert.ok(entries.some(([key, value]) => key === 'url.https://git.example.test/team/repository.git.pushInsteadOf'
    && value === transport.remote));
});

test('remote execution honors the offline contract without spawning Git', () => {
  let called = false;
  const result = runRemoteGit(['ls-remote', 'https://example.com/repository.git'], {
    env: { SINGULARITY_FLOW_NO_NETWORK: '1' },
    runCommand() { called = true; }
  });
  assert.equal(called, false);
  assert.equal(result.blocked, true);
  assert.equal(result.failure.classification, 'offline');
});

test('remote execution records privacy-safe operation, verb, and outcome counters', async () => {
  const timer = commandTimer('capability', { commandClass: 'mutation' });
  await withCommandTiming(timer, async () => {
    runRemoteGit(['fetch', 'origin'], {
      operation: 'remote-configuration',
      runCommand: () => ({ status: 0, stdout: '', stderr: '', timedOut: false })
    });
    runRemoteGit(['push', 'origin', 'HEAD:refs/heads/example'], {
      operation: 'remote-push',
      runCommand: () => ({ status: 1, stdout: '', stderr: 'remote rejected', timedOut: false })
    });
    await runRemoteGitAsync(['ls-remote', 'origin'], {
      operation: 'remote-probe',
      spawnCommand() {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      }
    });
  });
  const counters = timer.finish().counters;
  const serviceMs = counters['git.service-ms'];
  assert.ok(Number.isSafeInteger(serviceMs) && serviceMs >= 0);
  assert.deepEqual({ ...counters, 'git.service-ms': 0 }, {
    'git.requests': 3,
    'git.spawns': 3,
    'git.service-ms': 0,
    'git.remote.total': 3,
    'git.remote.operation.configuration': 1,
    'git.remote.command.fetch': 1,
    'git.remote.operation.push': 1,
    'git.remote.command.push': 1,
    'git.remote.outcome.failure': 1,
    'git.remote.operation.probe': 1,
    'git.remote.command.ls-remote': 1
  });
});

test('remote observation refusals distinguish unreachable from unreadable authorities', () => {
  assert.throws(() => requireRemoteObservation({
    ok: false,
    failure: {
      classification: 'remote-not-found', code: 'REMOTE_REMOTE_NOT_FOUND', retryable: false,
      advice: 'Verify the repository URL and your access to it, then retry.'
    }
  }, 'workspace repository'), /Cannot reach workspace repository/);
  assert.throws(() => requireRemoteObservation({
    ok: false,
    failure: {
      classification: 'authorization-denied', code: 'REMOTE_AUTHORIZATION_DENIED', retryable: false,
      advice: 'Ask the repository owner for read access, then retry.'
    }
  }, 'configuration branch'), /Cannot read configuration branch/);
});

test('non-interactive environment retains managed proxy and trust configuration', () => {
  const environment = nonInteractiveGitEnvironment({
    HTTPS_PROXY: 'http://proxy.example', GIT_SSL_CAINFO: '/managed/ca.pem'
  });
  assert.equal(environment.HTTPS_PROXY, 'http://proxy.example');
  assert.equal(environment.GIT_SSL_CAINFO, '/managed/ca.pem');
  assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
  assert.equal(environment.GCM_INTERACTIVE, 'Never');
});

test('asynchronous remote execution keeps the same bounded result contract', async () => {
  const result = await runRemoteGitAsync(['--version'], {
    operation: 'remote-probe', timeoutMs: 5_000
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^git version /);
  assert.equal(result.timeoutMs, 5_000);
});

test('async Git executor preserves raw stdout only when Buffer mode is selected', async () => {
  const bytes = Buffer.from([0x61, 0x00, 0x80, 0x0a]);
  const execute = (encoding) => runRemoteGitAsync(['--version'], {
    operation: 'local-read', timeoutMs: 5_000, encoding,
    spawnCommand() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stdout.write(bytes.subarray(0, 2));
        child.stdout.write(bytes.subarray(2));
        child.emit('close', 0, null);
      });
      return child;
    }
  });
  const raw = await execute('buffer');
  assert.equal(raw.status, 0);
  assert.deepEqual(raw.stdout, bytes);
  const text = await execute('utf8');
  assert.equal(typeof text.stdout, 'string');
  assert.equal(text.stdout, bytes.toString('utf8'));
});

test('async Git text framing preserves split 2-, 3-, and 4-byte UTF-8 code points', async (t) => {
  for (const character of ['é', '€', '😀']) {
    const encoded = Buffer.from(character, 'utf8');
    for (let boundary = 1; boundary < encoded.length; boundary += 1) {
      await t.test(`${encoded.length}-byte code point at byte ${boundary}`, async () => {
        const stdoutPrefix = Buffer.from('stdout:');
        const stdoutSuffix = Buffer.from(':done\n');
        const stderrPrefix = Buffer.from('stderr:');
        const stderrSuffix = Buffer.from(':done\n');
        const result = await runRemoteGitAsync(['--version'], {
          operation: 'local-read',
          timeoutMs: 5_000,
          encoding: 'utf8',
          spawnCommand() {
            const child = new EventEmitter();
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            queueMicrotask(() => {
              child.stdout.write(Buffer.concat([stdoutPrefix, encoded.subarray(0, boundary)]));
              child.stdout.write(Buffer.concat([encoded.subarray(boundary), stdoutSuffix]));
              child.stderr.write(Buffer.concat([stderrPrefix, encoded.subarray(0, boundary)]));
              child.stderr.write(Buffer.concat([encoded.subarray(boundary), stderrSuffix]));
              child.emit('close', 0, null);
            });
            return child;
          }
        });

        assert.equal(result.status, 0);
        assert.equal(result.stdout, `stdout:${character}:done\n`);
        assert.equal(result.stderr, `stderr:${character}:done\n`);
      });
    }
  }
});

test('async Git output ceiling is measured in exact bytes', async () => {
  const output = Buffer.from('Aé€😀Z', 'utf8');
  const execute = (maxBuffer) => runRemoteGitAsync(['--version'], {
    operation: 'local-read',
    timeoutMs: 5_000,
    terminationGraceMs: 40,
    maxBuffer,
    encoding: 'utf8',
    spawnCommand() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stdout.write(output.subarray(0, 3));
        child.stdout.write(output.subarray(3));
        if (output.byteLength <= maxBuffer) child.emit('close', 0, null);
      });
      return child;
    },
    terminateTree(child, signal) {
      queueMicrotask(() => child.emit('close', null, signal));
      return true;
    }
  });

  const exact = await execute(output.byteLength);
  assert.equal(exact.status, 0);
  assert.equal(exact.outputOverflow, false);
  assert.equal(exact.stdout, output.toString('utf8'));

  const overflow = await execute(output.byteLength - 1);
  assert.equal(overflow.status, 1);
  assert.equal(overflow.outputOverflow, true);
  assert.equal(overflow.failure.code, 'REMOTE_OUTPUT_LIMIT');
});

test('asynchronous remote execution resolves an absolute Git executable on Windows', async () => {
  const calls = [];
  const environment = {
    SystemRoot: 'C:\\Windows',
    PATH: 'C:\\Program Files\\Git\\cmd',
    PATHEXT: '.EXE',
    MANAGED_PROXY: 'preserved'
  };
  const result = await runRemoteGitAsync(['ls-remote', '--heads', 'origin'], {
    platform: 'win32',
    cwd: 'C:\\workspaces\\repository',
    env: environment,
    timeoutMs: 5_000,
    platformLookupCommand(command, args, options) {
      calls.push({ kind: 'lookup', command, args, options });
      return {
        status: 0,
        stdout: 'C:\\Program Files\\Git\\cmd\\git.exe\r\n',
        stderr: ''
      };
    },
    spawnCommand(command, args, options) {
      calls.push({ kind: 'spawn', command, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    }
  });

  assert.equal(result.status, 0);
  assert.equal(calls[0].kind, 'lookup');
  assert.equal(calls[0].command, 'C:\\Windows\\System32\\where.exe');
  assert.deepEqual(calls[0].args, ['$PATH:git.exe']);
  assert.equal(calls[0].options.cwd, 'C:\\Windows\\System32');
  assert.equal(calls[1].kind, 'spawn');
  assert.equal(calls[1].command, 'C:\\Program Files\\Git\\cmd\\git.exe');
  assert.deepEqual(calls[1].args, ['ls-remote', '--heads', 'origin']);
  assert.equal(calls[1].options.shell, false);
  assert.equal(calls[1].options.detached, false);
  assert.equal(calls[1].options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(calls[1].options.env.GCM_INTERACTIVE, 'Never');
  assert.equal(calls[1].options.env.MANAGED_PROXY, 'preserved');
});

test('asynchronous remote execution refuses Windows PATH resolution failure before spawning', async () => {
  let spawned = false;
  const result = await runRemoteGitAsync(['ls-remote', 'origin'], {
    platform: 'win32',
    cwd: 'C:\\workspaces\\repository',
    env: {
      SystemRoot: 'C:\\Windows', PATH: 'C:\\Program Files\\Git\\cmd', PATHEXT: '.EXE'
    },
    timeoutMs: 5_000,
    platformLookupCommand() {
      return { status: 1, stdout: '', stderr: '' };
    },
    spawnCommand() {
      spawned = true;
      throw new Error('must not spawn a bare command');
    }
  });

  assert.equal(spawned, false);
  assert.equal(result.status, 1);
  assert.equal(result.failure.classification, 'git-unavailable');
  assert.equal(result.failure.code, 'REMOTE_GIT_UNAVAILABLE');
});

test('asynchronous remote execution terminates a command at its operation deadline', async () => {
  const signals = [];
  const spawnCommand = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      signals.push(signal);
      queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    return child;
  };
  const result = await runRemoteGitAsync(['ls-remote', 'origin'], {
    timeoutMs: 10, spawnCommand
  });
  assert.equal(result.status, 1);
  assert.equal(result.timedOut, true);
  assert.equal(result.failure.classification, 'network-transient');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('asynchronous remote execution has a hard settlement deadline when close never arrives', async () => {
  const signals = [];
  const spawnCommand = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      signals.push(signal);
      // Deliberately never emit close: this models a descendant retaining the output pipes after
      // the immediate wrapper ignored graceful and forced termination.
      return true;
    };
    return child;
  };
  const startedAt = performance.now();
  const result = await runRemoteGitAsync(['ls-remote', 'origin'], {
    timeoutMs: 20,
    terminationGraceMs: 40,
    spawnCommand
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.status, 1);
  assert.equal(result.timedOut, true);
  assert.equal(result.failure.classification, 'network-transient');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(elapsedMs >= 15, `deadline fired too early after ${elapsedMs}ms`);
  assert.ok(elapsedMs < 300, `operation escaped its deadline plus grace (${elapsedMs}ms)`);
});

test('a wrapper exiting zero after the deadline remains a timeout failure', async () => {
  const spawnCommand = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      queueMicrotask(() => child.emit('close', 0, signal));
      return true;
    };
    return child;
  };
  const result = await runRemoteGitAsync(['fetch', 'origin'], {
    timeoutMs: 10,
    terminationGraceMs: 40,
    spawnCommand
  });
  assert.equal(result.status, 1);
  assert.equal(result.timedOut, true);
  assert.equal(result.failure.classification, 'network-transient');
});

test('hard async boundaries preserve timeout, cancellation, and output-limit error codes', async (t) => {
  const childThat = (start) => () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    queueMicrotask(() => start(child));
    return child;
  };

  await t.test('timeout', async () => {
    await assert.rejects(runRemoteGitAsync(['fetch', 'origin'], {
      timeoutMs: 10,
      terminationGraceMs: 40,
      allowFailure: false,
      spawnCommand: childThat(() => {})
    }), (error) => error?.code === 'REMOTE_NETWORK_TRANSIENT'
      && error?.details?.timedOut === true);
  });

  await t.test('cancellation', async () => {
    const controller = new AbortController();
    await assert.rejects(runRemoteGitAsync(['fetch', 'origin'], {
      timeoutMs: 5_000,
      terminationGraceMs: 40,
      allowFailure: false,
      signal: controller.signal,
      spawnCommand: childThat(() => controller.abort(new Error('cancelled')))
    }), (error) => error?.code === 'REMOTE_OPERATION_ABORTED');
  });

  await t.test('output overflow', async () => {
    await assert.rejects(runRemoteGitAsync(['fetch', 'origin'], {
      timeoutMs: 5_000,
      terminationGraceMs: 40,
      maxBuffer: 4,
      allowFailure: false,
      spawnCommand: childThat((child) => child.stdout.write('more than four bytes'))
    }), (error) => error?.code === 'REMOTE_OUTPUT_LIMIT'
      && error?.details?.outputOverflow === true);
  });

  await t.test('returned output overflow keeps the same code when the caller handles failure', async () => {
    const result = await runRemoteGitAsync(['fetch', 'origin'], {
      timeoutMs: 5_000,
      terminationGraceMs: 40,
      maxBuffer: 4,
      spawnCommand: childThat((child) => child.stderr.write('secret-bearing output beyond bound'))
    });
    assert.equal(result.status, 1);
    assert.equal(result.outputOverflow, true);
    assert.equal(result.failure.code, 'REMOTE_OUTPUT_LIMIT');
    assert.equal(result.failure.retryable, true);
  });
});

test('remote timeout terminates a pipe-holding descendant process tree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-remote-git-tree-'));
  const canary = path.join(root, 'descendant-survived');
  const descendant = [
    "const fs = require('node:fs');",
    "process.stdout.write('descendant-ready\\n');",
    "process.on('SIGTERM', () => {});",
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(canary)}, 'bad'), 700);`,
    'setInterval(() => {}, 1000);'
  ].join(' ');
  const parent = [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);'
  ].join(' ');
  let spawnOptions;
  const spawnCommand = (_command, _args, options) => {
    spawnOptions = options;
    return spawn(process.execPath, ['-e', parent], options);
  };

  const startedAt = performance.now();
  const result = await runRemoteGitAsync(['fetch', 'origin'], {
    cwd: root,
    timeoutMs: 500,
    terminationGraceMs: 200,
    spawnCommand
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.status, 1);
  assert.equal(result.timedOut, true);
  assert.match(result.stdout, /descendant-ready/, 'the pipe-holding descendant actually started');
  assert.equal(spawnOptions.detached, process.platform !== 'win32');
  assert.ok(elapsedMs < 1_000, `process tree exceeded its deadline plus grace (${elapsedMs}ms)`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await assert.rejects(access(canary), { code: 'ENOENT' });
});

test('process-tree signalling uses POSIX groups and observes Windows descendant-tree commands', async () => {
  const posixSignals = [];
  const directSignals = [];
  const child = {
    pid: 321,
    kill: (signal) => { directSignals.push(signal); return true; }
  };
  assert.equal(await signalProcessTree(child, 'SIGTERM', {
    platform: 'darwin',
    killProcess: (pid, signal) => posixSignals.push([pid, signal])
  }), true);
  assert.deepEqual(posixSignals, [[-321, 'SIGTERM']]);
  assert.deepEqual(directSignals, []);

  const taskkillCalls = [];
  const taskkill = new EventEmitter();
  const windowsSignal = signalProcessTree(child, 'SIGKILL', {
    platform: 'win32',
    environment: { SystemRoot: 'C:\\Windows' },
    spawnCommand: (command, args, options) => {
      taskkillCalls.push({ command, args, options });
      return taskkill;
    }
  });
  queueMicrotask(() => taskkill.emit('close', 0, null));
  assert.equal(await windowsSignal, true);
  assert.equal(taskkillCalls[0].command, 'C:\\Windows\\System32\\taskkill.exe');
  assert.deepEqual(taskkillCalls[0].args, ['/PID', '321', '/T', '/F']);
  assert.equal(taskkillCalls[0].options.shell, false);
  assert.equal(taskkillCalls[0].options.stdio, 'ignore');
  assert.deepEqual(directSignals, [], 'successful taskkill does not signal only the direct child');
});

test('Windows process-tree signalling falls back safely when taskkill fails or hangs', async (t) => {
  const exercise = async ({ outcome, timeoutMs = 15, requireTree = false }) => {
    const directSignals = [];
    const killerSignals = [];
    const child = {
      pid: 654,
      kill(signal) { directSignals.push(signal); return true; }
    };
    const killer = new EventEmitter();
    killer.kill = (signal) => { killerSignals.push(signal); return true; };
    const pending = signalProcessTree(child, 'SIGKILL', {
      platform: 'win32',
      environment: { SystemRoot: 'C:\\Windows' },
      timeoutMs,
      requireTree,
      spawnCommand(command, args, options) {
        assert.equal(command, 'C:\\Windows\\System32\\taskkill.exe');
        assert.deepEqual(args, ['/PID', '654', '/T', '/F']);
        assert.equal(options.stdio, 'ignore');
        if (outcome === 'throw') throw new Error('taskkill is blocked');
        return killer;
      }
    });
    if (outcome === 'nonzero') queueMicrotask(() => killer.emit('close', 128, null));
    if (outcome === 'error') {
      queueMicrotask(() => killer.emit('error', new Error('credential=must-not-escape')));
    }
    const accepted = await pending;
    return { accepted, directSignals, killerSignals };
  };

  await t.test('non-zero exit', async () => {
    const result = await exercise({ outcome: 'nonzero' });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.directSignals, ['SIGKILL']);
    assert.deepEqual(result.killerSignals, []);
    assert.doesNotMatch(JSON.stringify(result), /must-not-escape/);
  });

  await t.test('spawn error', async () => {
    const result = await exercise({ outcome: 'error' });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.directSignals, ['SIGKILL']);
    assert.deepEqual(result.killerSignals, []);
    assert.doesNotMatch(JSON.stringify(result), /must-not-escape/);
  });

  await t.test('strict tree verification rejects a direct-child-only fallback', async () => {
    const result = await exercise({ outcome: 'nonzero', requireTree: true });
    assert.equal(result.accepted, false);
    assert.deepEqual(result.directSignals, ['SIGKILL'],
      'strict verification still makes the bounded direct-child best-effort attempt');
    assert.deepEqual(result.killerSignals, []);
  });

  await t.test('strict tree verification rejects a synchronous taskkill launch failure', async () => {
    const result = await exercise({ outcome: 'throw', requireTree: true });
    assert.equal(result.accepted, false);
    assert.deepEqual(result.directSignals, ['SIGKILL']);
    assert.deepEqual(result.killerSignals, []);
  });

  await t.test('hung taskkill', async () => {
    const taskkillTimeoutMs = 15;
    const startedAt = performance.now();
    // Compare settlement with a timer carrying the same requested deadline. An absolute 200 ms
    // ceiling made this a scheduler benchmark: under full-suite CPU pressure both this control
    // timer and signalProcessTree's timer can be delayed by hundreds of milliseconds even though
    // the configured cleanup deadline is honoured. Their relative delay still detects a missing,
    // ignored, or materially longer taskkill timeout, while the outer bound below proves a hung
    // system utility cannot retain the test indefinitely.
    const controlDeadline = new Promise((resolve) => {
      setTimeout(() => resolve(performance.now()), taskkillTimeoutMs);
    });
    const result = await exercise({ outcome: 'hang', timeoutMs: taskkillTimeoutMs });
    const elapsedMs = performance.now() - startedAt;
    const controlElapsedMs = (await controlDeadline) - startedAt;
    assert.equal(result.accepted, true);
    assert.deepEqual(result.directSignals, ['SIGKILL']);
    assert.deepEqual(result.killerSignals, ['SIGKILL']);
    assert.ok(elapsedMs >= 10, `taskkill timed out too early after ${elapsedMs}ms`);
    assert.ok(elapsedMs - controlElapsedMs < 100,
      `taskkill ignored its configured cleanup deadline by ${elapsedMs - controlElapsedMs}ms`);
    assert.ok(elapsedMs < 2_000, `taskkill escaped its outer non-hang bound (${elapsedMs}ms)`);
  });
});

test('remote execution waits for bounded cleanup and rejects a late zero exit', async () => {
  const cleanupSignals = [];
  const child = new EventEmitter();
  child.pid = 777;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const startedAt = performance.now();
  const result = await runRemoteGitAsync(['fetch', 'origin'], {
    timeoutMs: 5,
    terminationGraceMs: 100,
    spawnCommand: () => child,
    terminateTree(_child, treeSignal) {
      cleanupSignals.push(treeSignal);
      return new Promise((resolve) => {
        setTimeout(() => {
          if (treeSignal === 'SIGTERM') child.emit('close', 0, treeSignal);
          resolve(true);
        }, treeSignal === 'SIGTERM' ? 20 : 35);
      });
    }
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.status, 1);
  assert.equal(result.timedOut, true);
  assert.equal(result.failure.classification, 'network-transient');
  assert.deepEqual(cleanupSignals, ['SIGTERM', 'SIGKILL']);
  assert.ok(elapsedMs >= 50, `remote operation settled before forced cleanup (${elapsedMs}ms)`);
  assert.ok(elapsedMs < 200, `remote cleanup exceeded the hard grace (${elapsedMs}ms)`);
  child.emit('close', 0, null);
  assert.equal(result.status, 1, 'a later zero close cannot erase the timeout boundary');
});

test('asynchronous remote execution propagates cancellation and terminates the child', async () => {
  const controller = new AbortController();
  const signals = [];
  const spawnCommand = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      signals.push(signal);
      queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    queueMicrotask(() => controller.abort(new Error('user cancelled')));
    return child;
  };
  const result = await runRemoteGitAsync(['fetch', 'origin'], {
    timeoutMs: 5_000, spawnCommand, signal: controller.signal
  });
  assert.equal(result.aborted, true);
  assert.equal(result.failure.code, 'REMOTE_OPERATION_ABORTED');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('pre-aborted remote execution never discloses the caller-owned abort reason', async () => {
  const controller = new AbortController();
  controller.abort({ credential: 'secret-material-must-not-escape' });
  let spawned = false;
  const result = await runRemoteGitAsync(['fetch', 'origin'], {
    timeoutMs: 5_000,
    signal: controller.signal,
    spawnCommand() { spawned = true; throw new Error('must not spawn'); }
  });

  assert.equal(spawned, false);
  assert.equal(result.aborted, true);
  assert.equal(result.failure.code, 'REMOTE_OPERATION_ABORTED');
  assert.equal(result.error, undefined);
  assert.doesNotMatch(JSON.stringify(result), /secret-material-must-not-escape/);
});
