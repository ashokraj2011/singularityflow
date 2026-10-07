import assert from 'node:assert/strict';
import test from 'node:test';
import { assertModelInvocationAllowed, operationContext, runOperation, warnOnce, withOperationContext } from '../src/operation-context.mjs';

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

test('warnings deduplicate within nested operations, not across invocations or distinct observations', async () => {
  const seen = [];
  const emit = message => seen.push(message);
  const operation = { id: 'warnings.read', command: 'read', modelPolicy: 'never' };
  for (let invocation = 0; invocation < 2; invocation++) {
    await withOperationContext({ operation, modelMode: { enabled: false } }, async () => {
      assert.equal(warnOnce('8679 bytes', { emit }), true);
      await runOperation(operation, async () => {
        assert.equal(warnOnce('8679 bytes', { emit }), false);
        assert.equal(warnOnce('9563 bytes', { emit }), true);
      });
    });
  }
  assert.deepEqual(seen, ['8679 bytes', '9563 bytes', '8679 bytes', '9563 bytes']);
  // Library callers outside the CLI's operation context retain every warning.
  warnOnce('outside', { emit }); warnOnce('outside', { emit });
  assert.deepEqual(seen.slice(-2), ['outside', 'outside']);
});

test('concurrent root operations do not share warning suppression', async () => {
  const seen = [];
  await Promise.all([1, 2].map(id => withOperationContext({
    operation: { id: `read-${id}`, modelPolicy: 'never' }, modelMode: { enabled: false }
  }, async () => {
    await Promise.resolve();
    warnOnce('same warning', { emit: () => seen.push(id) });
    warnOnce('same warning', { emit: () => seen.push(id) });
  })));
  assert.deepEqual(seen.sort(), [1, 2]);
});
