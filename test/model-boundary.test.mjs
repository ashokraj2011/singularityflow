import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { invokeModel } from '../src/model-runner.mjs';
import { launchHostSession } from '../src/host-session-launcher.mjs';
import { withOperationContext } from '../src/operation-context.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the static model boundary admits only the registered provider and host launchers', () => {
  const result = spawnSync(process.execPath, ['scripts/audit-model-boundary.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});

test('a never-model operation rejects before provider lookup, process start, or audit creation', async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-model-boundary-'));
  await assert.rejects(() => withOperationContext({
    operation: { id: 'tripwire.read', modelPolicy: 'never' },
    modelMode: { enabled: true },
    root: repository,
    command: 'tripwire'
  }, () => invokeModel({
    provider: 'provider-that-must-not-be-resolved',
    cwd: repository,
    allowedRoots: [repository],
    auditRoot: repository,
    channel: 'test',
    prompt: { text: 'This prompt must never cross the boundary.' },
    tools: { mode: 'none', names: [] },
    limits: { timeoutMs: 1000, outputBytes: 1024 }
  })), (error) => error.code === 'MODEL_FORBIDDEN');
  await assert.rejects(access(path.join(repository, '.git', 'singularity-flow', 'model-invocations')));
});

test('a real host launch is refused before telemetry preparation or process start', async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-host-boundary-'));
  await assert.rejects(() => withOperationContext({
    operation: { id: 'tripwire.host', modelPolicy: 'never' },
    modelMode: { enabled: true },
    root: repository,
    command: 'copilot'
  }, () => launchHostSession({ cwd: repository })), (error) => error.code === 'MODEL_FORBIDDEN');
});
