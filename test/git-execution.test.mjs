import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  GitRemoteSession, gitTimeouts, nonInteractiveGitEnvironment, runRemoteGit,
  runRemoteGitAsync, requireRemoteObservation
} from '../src/git-execution.mjs';

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
