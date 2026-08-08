import { AsyncLocalStorage } from 'node:async_hooks';
import { SingularityFlowError } from './util.mjs';

const storage = new AsyncLocalStorage();
const POLICY_RANK = Object.freeze({ optional: 1, required: 2, never: 3 });

function mostRestrictivePolicy(stack) {
  return stack.reduce((selected, operation) => (
    POLICY_RANK[operation.modelPolicy] > POLICY_RANK[selected] ? operation.modelPolicy : selected
  ), 'optional');
}

export function withOperationContext(context, callback) {
  const parent = storage.getStore();
  const stack = [...(parent?.stack ?? []), context.operation];
  const effectivePolicy = mostRestrictivePolicy(stack);
  return storage.run(Object.freeze({
    schemaVersion: 1,
    ...context,
    rootOperationId: parent?.rootOperationId ?? context.operation.id,
    stack: Object.freeze(stack),
    operationStack: Object.freeze(stack.map((operation) => operation.id)),
    modelPolicy: context.operation.modelPolicy,
    effectivePolicy
  }), callback);
}

export function runOperation(operation, callback) {
  const parent = requireOperationContext();
  return withOperationContext({
    operation,
    modelMode: parent.modelMode,
    root: parent.root,
    argvSha256: parent.argvSha256,
    argvHash: parent.argvHash,
    command: operation.command
  }, callback);
}

export function operationContext() {
  return storage.getStore() ?? null;
}

export function requireOperationContext() {
  const context = operationContext();
  if (!context) {
    throw new SingularityFlowError('Model execution requires a registered Singularity Flow operation context.', {
      code: 'MODEL_CONTEXT_MISSING'
    });
  }
  return context;
}

export function assertModelInvocationAllowed() {
  const context = requireOperationContext();
  if (context.effectivePolicy === 'never') {
    throw new SingularityFlowError(`Operation '${context.operation.id}' forbids model execution.`, {
      code: 'MODEL_FORBIDDEN'
    });
  }
  if (!context.modelMode.enabled) {
    throw new SingularityFlowError(`Operation '${context.operation.id}' requires model execution, but model mode is disabled.`, {
      code: 'MODEL_UNAVAILABLE',
      details: { operationId: context.operation.id, fallback: context.operation.fallback ?? null }
    });
  }
  return context;
}
