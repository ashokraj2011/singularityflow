import assert from 'node:assert/strict';
import test from 'node:test';
import { assertModelInvocationAllowed, operationContext, runOperation, withOperationContext } from '../src/operation-context.mjs';

test('model permission requires an operation context', () => {
  assert.equal(operationContext(), null);
  assert.throws(() => assertModelInvocationAllowed(), (error) => error.code === 'MODEL_CONTEXT_MISSING');
});

test('the most restrictive ancestor policy dominates nested operations', async () => {
  await withOperationContext({
    operation: { id: 'root.read', command: 'read', modelPolicy: 'never' },
    modelMode: { enabled: true }, root: process.cwd(), command: 'read'
  }, async () => {
    await runOperation({ id: 'child.generate', command: 'generate', modelPolicy: 'required' }, async () => {
      const context = operationContext();
      assert.equal(context.effectivePolicy, 'never');
      assert.deepEqual(context.operationStack, ['root.read', 'child.generate']);
      assert.throws(() => assertModelInvocationAllowed(), (error) => error.code === 'MODEL_FORBIDDEN');
    });
  });
});

test('disabled model mode rejects a required operation', async () => {
  await withOperationContext({
    operation: { id: 'generate.required', command: 'generate', modelPolicy: 'required' },
    modelMode: { enabled: false }, root: process.cwd(), command: 'generate'
  }, async () => assert.throws(() => assertModelInvocationAllowed(), (error) => error.code === 'MODEL_UNAVAILABLE'));
});
