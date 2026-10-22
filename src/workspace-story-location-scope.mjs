/** Invocation-only locations; no Git, workspace discovery, filesystem reads, or serialized authority. */
import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage();
export function withAutomaticStoryCheckout(preparation, action) { return scope.run(preparation, action); }
export function automaticStoryPreparation() { return scope.getStore(); }
export function automaticStoryRepositoryPath(repositoryId, branch) {
  return scope.getStore()?.repositories?.find(entry =>
    entry.repositoryId === repositoryId && entry.branch === branch)?.repositoryPath ?? null;
}
