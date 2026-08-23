import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runQualityCommand } from '../src/quality-command-runner.mjs';

test('quality timeout terminates descendants before reporting completion', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-quality-tree-'));
  const canary = path.join(root, 'descendant-survived');
  const child = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(canary)}, 'bad'), 750); setInterval(() => {}, 1000)`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], {stdio:'ignore'}); setInterval(() => {}, 1000)`;
  const result = await runQualityCommand(process.execPath, ['-e', parent], { cwd: root, timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  await new Promise((resolve) => setTimeout(resolve, 900));
  await assert.rejects(access(canary), { code: 'ENOENT' });
});
