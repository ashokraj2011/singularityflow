import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  executeGalAsyncRead, GAL_ASYNC_READ_DESCRIPTORS
} from 'singularity-flow/gal/async-read';
import { run } from '../src/util.mjs';
import { validateFactoryResetRepositoryDirectory } from '../apps/vscode/src/cli/runner.ts';

test('published GAL async root read keeps one exact argv, owner deadline, and cancellation signal', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const runner = async (args, options) => {
    calls.push({ args, options });
    return { status: 0, stdout: Buffer.from('/verified/root\n'), stderr: '', failure: null };
  };
  assert.deepEqual(await executeGalAsyncRead('repository.root', '/selected/root', { runner, signal }), {
    ok: true, value: '/verified/root'
  });
  assert.equal(GAL_ASYNC_READ_DESCRIPTORS['repository.root'].version, 1);
  assert.deepEqual(calls.map((call) => call.args), [['rev-parse', '--show-toplevel']]);
  assert.equal(calls[0].options.cwd, '/selected/root');
  assert.equal(calls[0].options.timeout, 15_000);
  assert.equal(calls[0].options.signal, signal);
  assert.equal(Object.isFrozen(GAL_ASYNC_READ_DESCRIPTORS['repository.root'].argv), true);
});

test('unknown or malformed async read requests never reach a Git runner', async () => {
  let calls = 0;
  const runner = async () => { calls += 1; throw new Error('must not launch'); };
  assert.deepEqual(await executeGalAsyncRead('repository.mutate', '/repo', { runner }), {
    ok: false, code: 'GAL_OPERATION_UNSUPPORTED'
  });
  assert.deepEqual(await executeGalAsyncRead('toString', '/repo', { runner }), {
    ok: false, code: 'GAL_OPERATION_UNSUPPORTED'
  });
  assert.deepEqual(await executeGalAsyncRead('repository.root', '/repo\0other', { runner }), {
    ok: false, code: 'GAL_INPUT_INVALID'
  });
  assert.equal(calls, 0);
});

test('async adapter keeps supervised failures typed and never exposes Git stderr', async () => {
  const result = (failure, status = null, stdout = Buffer.alloc(0)) => async () => ({
    status, stdout, stderr: 'https://user:secret@example.invalid/repo.git', failure
  });
  for (const [failure, code] of [
    ['timeout', 'GAL_TIMEOUT'], ['cancelled', 'GAL_CANCELLED'],
    ['git-unavailable', 'GAL_EXECUTABLE_UNAVAILABLE'], ['output-overflow', 'GAL_OUTPUT_LIMIT']
  ]) {
    const observed = await executeGalAsyncRead('repository.root', '/repo', {
      runner: result(failure)
    });
    assert.deepEqual(observed, { ok: false, code });
    assert.doesNotMatch(JSON.stringify(observed), /secret|example\.invalid/u);
  }
  assert.deepEqual(await executeGalAsyncRead('repository.root', '/repo', {
    runner: result(null, 128)
  }), { ok: false, code: 'GAL_GIT_FAILED' });
  assert.deepEqual(await executeGalAsyncRead('repository.root', '/repo', {
    runner: result(null, 0, Buffer.alloc(0))
  }), { ok: false, code: 'GAL_PROTOCOL_INVALID' });
});

test('VS Code root validation consumes the shared descriptor with one existing async Git runner call', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-gal-read-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'repository');
  run('git', ['init', '-q', '-b', 'main', root]);
  const calls = [];
  const localRunner = async (args, options) => {
    calls.push({ args, options });
    const observed = run('git', args, { cwd: options.cwd, allowFailure: true });
    return {
      status: observed.status, stdout: Buffer.from(observed.stdout),
      stderr: observed.stderr, failure: null
    };
  };
  assert.equal(await validateFactoryResetRepositoryDirectory(root, { localRunner }), await realpath(root));
  assert.deepEqual(calls.map((call) => call.args), [['rev-parse', '--show-toplevel']]);
  assert.equal(calls[0].options.timeout, 15_000);
});
