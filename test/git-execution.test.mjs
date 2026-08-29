import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  GitRemoteSession, gitTimeouts, nonInteractiveGitEnvironment, runRemoteGit,
  runRemoteGitAsync, requireRemoteObservation
} from '../src/git-execution.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';

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
  assert.deepEqual(timer.finish().counters, {
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
  assert.deepEqual(signals, ['SIGTERM']);
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
  assert.deepEqual(signals, ['SIGTERM']);
});
