/** Lightweight invocation/surface selection. No configuration, lifecycle or Git imports. */
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { SingularityFlowError } from './util.mjs';
const scopes = new AsyncLocalStorage();
export const SURFACE_CONTEXT_ENV = 'SINGULARITY_FLOW_SURFACE_CONTEXT';
export function surfaceContext(env = process.env) {
  const raw = env[SURFACE_CONTEXT_ENV];
  if (!raw) return null;
  let value;
  if (raw.length <= 16384) try { value = JSON.parse(raw); } catch { /* Fail closed below. */ }
  if (!value || value.schemaVersion !== 1 || typeof value.repositoryPath !== 'string' // schema-transient: process-only selector
      || !path.isAbsolute(value.repositoryPath) || value.repositoryPath.includes('\0') || value.repositoryPath.length > 8192) {
    throw new SingularityFlowError('The surface context is invalid. Reopen the selected repository.', { code: 'EXECUTION_CONTEXT_BINDING_INVALID' });
  }
  return Object.freeze({ schemaVersion: 1, repositoryPath: path.resolve(value.repositoryPath) });
}
export function withExecutionContextScope(root, callback, { boundRoot = null } = {}) {
  return scopes.run({ root: root ? path.resolve(root) : null, boundRoot, pending: new Map() }, callback);
}
export function executionContextScope() { return scopes.getStore() ?? null; }
export function executionContextRoot() { return executionContextScope()?.root ?? null; }
export function boundExecutionContextRoot() { return executionContextScope()?.boundRoot ?? surfaceContext()?.repositoryPath ?? null; }
export function executionContextArguments(argv) {
  const args = [], roots = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--') { args.push(...argv.slice(index)); break; }
    if (item === '--context-root') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new SingularityFlowError('--context-root needs an absolute checkout path.', { code: 'EXECUTION_CONTEXT_BINDING_INVALID' });
      roots.push(value);
    } else if (item.startsWith('--context-root=')) roots.push(item.slice('--context-root='.length));
    else args.push(item);
  }
  if (roots.length > 1 || roots.some(value => !path.isAbsolute(value) || value.includes('\0'))) {
    throw new SingularityFlowError('Choose one absolute --context-root checkout path.', { code: 'EXECUTION_CONTEXT_BINDING_INVALID' });
  }
  return { argv: args, root: roots[0] ? path.resolve(roots[0]) : null };
}
