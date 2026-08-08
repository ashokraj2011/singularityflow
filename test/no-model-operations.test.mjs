import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { operationCatalog, validateOperationRegistry } from '../src/command-registry.mjs';
import { invokeModel } from '../src/model-runner.mjs';
import { withOperationContext } from '../src/operation-context.mjs';

test('every registered never-model operation has a runtime boundary tripwire', async () => {
  assert.equal(validateOperationRegistry(), true);
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-operation-tripwires-'));
  const operations = operationCatalog().filter((entry) => entry.modelPolicy === 'never');
  assert.ok(operations.length > 80);
  assert.equal(new Set(operations.map((entry) => entry.noModelFixture)).size, operations.length);
  for (const operation of operations) {
    await assert.rejects(() => withOperationContext({
      operation,
      modelMode: { enabled: true },
      root,
      command: operation.command
    }, () => invokeModel({})), (error) => {
      assert.equal(error.code, 'MODEL_FORBIDDEN', operation.id);
      return true;
    });
  }
});

test('optional operations resolve to an automatic never-model fallback', () => {
  const catalog = operationCatalog();
  for (const operation of catalog.filter((entry) => entry.modelPolicy === 'optional')) {
    assert.equal(operation.fallback?.mode, 'automatic');
    assert.equal(catalog.find((entry) => entry.id === operation.fallback.operationId)?.modelPolicy, 'never');
  }
});
