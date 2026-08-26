import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runQualityCommand } from '../src/quality-command-runner.mjs';

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
