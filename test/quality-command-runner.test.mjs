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
