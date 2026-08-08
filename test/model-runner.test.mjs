import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { invokeModel } from '../src/model-runner.mjs';
import { withOperationContext } from '../src/operation-context.mjs';

function request(root, overrides = {}) {
  return {
    provider: 'copilot-cli', providerConfig: { executable: process.execPath, arguments: ['-e', 'process.stdout.write("ok")'] },
    cwd: root, allowedRoots: [root], auditRoot: root, channel: 'test', prompt: { text: 'test' },
    tools: { mode: 'none', names: [] }, limits: { timeoutMs: 1000, outputBytes: 1024 }, ...overrides
  };
}

test('the model runner rejects calls without registered operation context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-model-runner-'));
  await assert.rejects(() => invokeModel(request(root)), (error) => error.code === 'MODEL_CONTEXT_MISSING');
});

test('unknown providers fail before audit creation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-model-provider-'));
  await assert.rejects(() => withOperationContext({
    operation: { id: 'model.test', modelPolicy: 'required' }, modelMode: { enabled: true }, root, command: 'test'
  }, () => invokeModel(request(root, { provider: 'unknown-provider', providerConfig: undefined }))), (error) => error.code === 'MODEL_PROVIDER_UNKNOWN');
  await assert.rejects(access(path.join(root, '.git', 'singularity-flow', 'model-invocations')));
});

test('an invocation cannot redirect its audit record outside the trusted operation root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-model-root-'));
  const other = await mkdtemp(path.join(os.tmpdir(), 'sflow-model-other-'));
  await assert.rejects(() => withOperationContext({
    operation: { id: 'model.test', modelPolicy: 'required' }, modelMode: { enabled: true }, root, command: 'test'
  }, () => invokeModel(request(root, { auditRoot: other }))), (error) => error.code === 'MODEL_AUDIT_ROOT_INVALID');
});
