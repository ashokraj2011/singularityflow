import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';

import { runQualityCommand, verifyCompletedQualityLaunch, verifyUnavailableQualityLaunch } from '../src/quality-command-runner.mjs';

test('native completed provenance binds exact streamed bytes and cannot be copied or rebound', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sflow-native-completed-'));
  const stdoutFile = path.join(cwd, 'output.xml');
  const command = process.execPath;
  const args = ['-e', 'process.stdout.write("actual execution output");process.exitCode=1'];
  const result = await runQualityCommand(command, args, { cwd, stdoutFile, captureBytes: 4, timeoutMs: 5000 });
  const binding = { command, args, cwd, stdoutFile,
    environmentSha256: createHash('sha256').update(JSON.stringify(Object.entries(process.env).sort())).digest('hex') };
  const proof = verifyCompletedQualityLaunch(result, binding);
  assert.equal(result.status, 1);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(proof.stdoutSha256, `sha256:${createHash('sha256').update(await readFile(stdoutFile)).digest('hex')}`);
  assert.equal(proof.stdoutBytes, 23);
  assert.equal(verifyCompletedQualityLaunch({ ...result }, binding), null);
  assert.equal(verifyCompletedQualityLaunch(result, { ...binding, stdoutFile: `${stdoutFile}.other` }), null);
  assert.equal(verifyCompletedQualityLaunch(result, { ...binding, environmentSha256: 'wrong' }), null);
  assert.equal(verifyCompletedQualityLaunch(result, { ...binding, args: [] }), null);
  result.status = 0;
  assert.equal(verifyCompletedQualityLaunch(result, binding), null);
});

test('only an unchanged native ENOENT launch can authenticate unavailable validation', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sflow-native-launch-'));
  const command = path.join(cwd, 'does-not-exist');
  const args = ['--checked-argument'];
  const result = await runQualityCommand(command, args, { cwd, timeoutMs: 1000 });
  const binding = { command, args, cwd,
    environmentSha256: createHash('sha256').update(JSON.stringify(Object.entries(process.env).sort())).digest('hex') };
  const proof = verifyUnavailableQualityLaunch(result, binding);
  assert.equal(result.error.code, 'ENOENT');
  assert.ok(proof);
  assert.ok(Date.parse(proof.completedAt) >= Date.parse(proof.startedAt));
  assert.equal(verifyUnavailableQualityLaunch({ ...result }, binding), null);
  assert.equal(verifyUnavailableQualityLaunch(result, { ...binding, command: process.execPath }), null);
  assert.equal(verifyUnavailableQualityLaunch(result, { ...binding, args: [] }), null);
  result.status = 0;
  assert.equal(verifyUnavailableQualityLaunch(result, binding), null);
});

test('injected launch transports cannot mint unavailable-validation provenance', async () => {
  const command = 'fake-missing-executable';
  const cwd = process.cwd();
  const result = await runQualityCommand(command, [], { cwd, timeoutMs: 1000, spawnCommand() {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    setImmediate(() => {
      const error = new Error('fake missing executable'); error.code = 'ENOENT';
      child.emit('error', error); child.emit('close', null, null);
    });
    return child;
  } });
  assert.equal(verifyUnavailableQualityLaunch(result, { command, args: [], cwd }), null);
});

test('argv quality commands use the safe Windows npm shim without enabling shell mode', async () => {
  const calls = [];
  const args = ['test', '--', 'argument with spaces'];
  const environment = {
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    SystemRoot: 'C:\\Windows'
  };
  const result = await runQualityCommand('npm', args, {
    platform: 'win32',
    env: environment,
    platformLookupCommand(command, lookupArgs, options) {
      assert.equal(command, 'C:\\Windows\\System32\\where.exe');
      assert.deepEqual(lookupArgs, ['$PATH:npm.cmd']);
      assert.equal(options.shell, false);
      return {
        status: 0,
        stdout: '.\\npm.cmd\r\nC:\\Program Files\\nodejs\\npm.cmd\r\n',
        stderr: ''
      };
    },
    timeoutMs: 5_000,
    killTree: false,
    spawnCommand(command, physicalArgs, options) {
      calls.push({ command, args: physicalArgs, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.killed = false;
      child.kill = () => { child.killed = true; return true; };
      setImmediate(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0, null);
      });
      return child;
    }
  });
  assert.equal(result.status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, environment.ComSpec);
  assert.deepEqual(calls[0].args.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
  assert.match(calls[0].args[4], /Program\^ Files.*npm\.cmd/);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.deepEqual(args, ['test', '--', 'argument with spaces']);
});

test('Windows quality commands execute only explicit regular repository-local wrappers', async () => {
  const calls = [];
  const environment = {
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    SystemRoot: 'C:\\Windows'
  };
  const result = await runQualityCommand('.\\mvnw.cmd', ['test'], {
    platform: 'win32', cwd: 'C:\\workspace', env: environment,
    platformLstatCommand(candidate) {
      assert.equal(candidate, 'C:\\workspace\\mvnw.cmd');
      return { isFile: () => true, isSymbolicLink: () => false };
    },
    platformRealpathCommand: (candidate) => candidate,
    timeoutMs: 5_000,
    killTree: false,
    spawnCommand(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => true;
      setImmediate(() => {
        child.stdout.end(); child.stderr.end();
        child.emit('close', 0, null);
      });
      return child;
    }
  });
  assert.equal(result.status, 0);
  assert.equal(calls[0].command, environment.ComSpec);
  assert.match(calls[0].args[4], /C:\\workspace\\mvnw\.cmd.*test/);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
});

test('bounded diagnostics preserve UTF-8 at every retained boundary', async () => {
  const result = await runQualityCommand(process.execPath, [
    '-e', 'process.stdout.write("😀".repeat(20))'
  ], { captureBytes: 9, timeoutMs: 5_000 });
  assert.equal(result.status, 0);
  assert.equal(result.stdoutTruncated, true);
  assert.doesNotMatch(result.stdout, /�/);
  assert.match(result.stdout, /😀/);
});

test('result stream errors become governed infrastructure failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-quality-stream-'));
  const directory = path.join(root, 'not-a-file');
  await mkdir(directory);
  const result = await runQualityCommand(process.execPath, [
    '-e', 'process.stdout.write("result")'
  ], { stdoutFile: directory, timeoutMs: 5_000 });
  assert.ok(result.error);
  assert.match(result.error.message, /EISDIR|illegal operation|directory/i);
});

test('a delayed event loop does not label an already-finished command as timed out', async () => {
  const execution = runQualityCommand(process.execPath, [
    '-e', 'process.exit(0)'
  ], { timeoutMs: 25 });

  // The child runs in another process while this event loop is deliberately unavailable. When
  // the loop resumes, both the expired timer and the child exit are pending—the macOS full-suite
  // race that previously turned an instant AST fixture into AST_WARM_TIMEOUT.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  const result = await execution;
  assert.equal(result.status, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, null);
});

test('cancellation remains cancellation when its timeout is already queued', async () => {
  const controller = new AbortController();
  const execution = runQualityCommand(process.execPath, [
    '-e', 'setTimeout(() => {}, 10_000)'
  ], { timeoutMs: 25, signal: controller.signal });

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  controller.abort();
  const result = await execution;
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
});
