import { createHash } from 'node:crypto';
import path from 'node:path';

import { incrementCommandCounter } from './dx-timing-context.mjs';
import { executeGitQuery, gitQueryDescriptor } from './git-query.mjs';
import { SingularityFlowError } from './util.mjs';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function cloneFrozen(value) {
  const copy = structuredClone(value);
  const freeze = (item) => {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) {
      Object.freeze(item);
      for (const child of healthValues(item)) freeze(child);
    }
    return item;
  };
  return freeze(copy);
}

function healthValues(value) {
  return Array.isArray(value) ? value : Object.values(value);
}

function localId(prefix, value) {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

// A context only joins a shared repository group after Git has identified its common directory.
// Weak references keep invocation-scoped contexts from becoming process-lifetime cache entries.
const sharedContexts = new Map();
const collectedContext = new FinalizationRegistry(({ commonDir, reference }) => {
  const members = sharedContexts.get(commonDir);
  members?.delete(reference);
  if (members?.size === 0) sharedContexts.delete(commonDir);
});
const MUTABLE_DEPENDENCIES = Object.freeze({
  'repository.head': ['configuration', 'shared', 'worktree'],
  'repository.branch': ['configuration', 'worktree'],
  'repository.local-branch-exists': ['configuration', 'shared'],
  'repository.index-detail': ['configuration', 'worktree'],
  'repository.tracked-paths': ['configuration', 'worktree']
});

function dependencies(id, descriptor) {
  if (descriptor.dependency === 'repository-instance') {
    return id === 'repository.paths' ? ['instance'] : ['instance', 'configuration'];
  }
  if (descriptor.dependency === 'configuration') return ['instance', 'configuration'];
  return ['instance', ...(MUTABLE_DEPENDENCIES[id]
    ?? ['configuration', 'shared', 'worktree'])];
}

function invalidationDomains({ scope = 'all', configuration = scope === 'all' } = {}) {
  if (scope === 'repository-instance') return ['instance'];
  if (scope === 'configuration') return ['configuration'];
  if (scope === 'shared') return ['shared', ...(configuration ? ['configuration'] : [])];
  if (scope === 'worktree') return ['worktree', ...(configuration ? ['configuration'] : [])];
  if (scope === 'all') return [
    'shared', 'worktree', ...(configuration ? ['instance', 'configuration'] : [])
  ];
  throw new SingularityFlowError(`Unknown repository invalidation scope '${scope}'.`, {
    code: 'REPO_CONTEXT_INVALIDATION_SCOPE_INVALID'
  });
}

function intersects(left, right) {
  return left.some((dependency) => right.includes(dependency));
}

export class RepoContext {
  #root;
  #execute;
  #epoch = 0;
  #generations = { instance: 0, configuration: 0, shared: 0, worktree: 0 };
  #cache = new Map();
  #pending = new Map();
  #mutation = false;
  #mutationDomains = [];
  #siblingBarriers = new Map();
  #commonDir = null;
  #cacheEnabled;

  constructor(root, { execute = executeGitQuery, cache = true } = {}) {
    this.#root = path.resolve(root);
    this.#execute = execute;
    this.#cacheEnabled = cache !== false;
  }

  get root() { return this.#root; }
  get epoch() { return this.#epoch; }

  #key(id, params, queryDependencies) {
    const suffix = JSON.stringify(stable(params));
    const generations = queryDependencies.map((dependency) => this.#generations[dependency]);
    return `${JSON.stringify(generations)}:${id}:${suffix}`;
  }

  #registerPaths(value) {
    if (!value?.commonDir || typeof value.commonDir !== 'string') return;
    const commonDir = path.resolve(value.commonDir);
    if (this.#commonDir === commonDir) return;
    this.#siblingBarriers.clear();
    this.#commonDir = commonDir;
    const members = sharedContexts.get(commonDir) ?? new Set();
    for (const reference of members) {
      const context = reference.deref();
      if (!context || context.#commonDir !== commonDir) {
        members.delete(reference);
      } else if (context.#mutation) {
        const affected = context.#mutationDomains.filter((domain) => domain !== 'worktree');
        if (affected.length) this.#siblingBarriers.set(context, affected);
      }
    }
    const reference = new WeakRef(this);
    members.add(reference);
    sharedContexts.set(commonDir, members);
    collectedContext.register(this, { commonDir, reference });
  }

  #invalidateLocal(domains) {
    incrementCommandCounter('cache.invalidations');
    this.#epoch += 1;
    for (const domain of domains) this.#generations[domain] += 1;
    for (const [key, entry] of this.#cache) {
      if (intersects(entry.dependencies, domains)) this.#cache.delete(key);
    }
    for (const [key, entry] of this.#pending) {
      if (intersects(entry.dependencies, domains)) this.#pending.delete(key);
    }
  }

  #invalidateDomains(domains) {
    if (!this.#commonDir || !intersects(domains, ['instance', 'configuration', 'shared'])) {
      this.#invalidateLocal(domains);
      return;
    }
    const members = sharedContexts.get(this.#commonDir);
    let selfSeen = false;
    for (const reference of members ?? []) {
      const context = reference.deref();
      if (!context || context.#commonDir !== this.#commonDir) {
        members.delete(reference);
        continue;
      }
      if (context === this) selfSeen = true;
      // A sibling's worktree-local generation is not affected by this checkout's mutation.
      const affected = context === this ? domains : domains.filter((domain) => domain !== 'worktree');
      if (affected.length) context.#invalidateLocal(affected);
    }
    if (!selfSeen) this.#invalidateLocal(domains);
    if (members?.size === 0) sharedContexts.delete(this.#commonDir);
  }

  #setSiblingBarrier(domains, enabled) {
    if (!this.#commonDir) return;
    const affected = domains.filter((domain) => domain !== 'worktree');
    if (!affected.length) return;
    const members = sharedContexts.get(this.#commonDir);
    for (const reference of members ?? []) {
      const context = reference.deref();
      if (!context || context.#commonDir !== this.#commonDir) {
        members.delete(reference);
      } else if (context !== this) {
        if (enabled) context.#siblingBarriers.set(this, affected);
        else context.#siblingBarriers.delete(this);
      }
    }
  }

  #isBarred(queryDependencies) {
    if (this.#mutation && intersects(queryDependencies, this.#mutationDomains)) return true;
    for (const domains of this.#siblingBarriers.values()) {
      if (intersects(queryDependencies, domains)) return true;
    }
    return false;
  }

  async observe(id, params = {}) {
    const descriptor = gitQueryDescriptor(id);
    const queryDependencies = dependencies(id, descriptor);
    if (this.#isBarred(queryDependencies)) throw new SingularityFlowError(
      'Repository observations are paused while a registered mutation is in progress.', {
        code: 'REPO_CONTEXT_MUTATION_IN_PROGRESS', details: { queryId: id }
      }
    );
    const key = this.#key(id, params, queryDependencies);
    if (this.#cacheEnabled && this.#cache.has(key)) {
      incrementCommandCounter('cache.hits');
      return cloneFrozen(this.#cache.get(key).value);
    }
    if (this.#cacheEnabled && this.#pending.has(key)) {
      incrementCommandCounter('cache.hits');
      incrementCommandCounter('git.coalesced-requests');
      return cloneFrozen(await this.#pending.get(key).promise);
    }
    incrementCommandCounter('cache.misses');
    const pending = Promise.resolve().then(() => this.#execute(this.#root, id, structuredClone(params)));
    const entry = { dependencies: queryDependencies, promise: pending };
    if (this.#cacheEnabled) this.#pending.set(key, entry);
    try {
      const value = cloneFrozen(await pending);
      if (key === this.#key(id, params, queryDependencies)) {
        if (id === 'repository.paths') this.#registerPaths(value);
        if (this.#cacheEnabled) this.#cache.set(key, { dependencies: queryDependencies, value });
      }
      return cloneFrozen(value);
    } finally {
      if (this.#cacheEnabled && this.#pending.get(key) === entry) this.#pending.delete(key);
    }
  }

  /**
   * A current-use observation never reuses an earlier invocation capture. It remains an
   * observation, not a lock against external Git processes; publication still needs exact
   * preconditions. A local mutation overlapping the read invalidates the result.
   */
  async observeFresh(id, params = {}) {
    const descriptor = gitQueryDescriptor(id);
    const queryDependencies = dependencies(id, descriptor);
    if (this.#mutation || this.#isBarred(queryDependencies)) throw new SingularityFlowError(
      'Repository observations are paused while a registered mutation is in progress.', {
        code: 'REPO_CONTEXT_MUTATION_IN_PROGRESS', details: { queryId: id }
      }
    );
    const observedEpoch = this.#epoch;
    const observedKey = this.#key(id, params, queryDependencies);
    incrementCommandCounter('cache.misses');
    const value = await this.#execute(this.#root, id, structuredClone(params));
    if (observedKey !== this.#key(id, params, queryDependencies)) throw new SingularityFlowError(
      'Repository state changed while a fresh observation was being collected.', {
        code: 'REPO_CONTEXT_EPOCH_CHANGED',
        details: { queryId: id, observedEpoch, currentEpoch: this.#epoch }
      }
    );
    if (id === 'repository.paths') this.#registerPaths(value);
    return cloneFrozen(value);
  }

  /**
   * The no-argument form preserves the conservative whole-repository invalidation contract.
   * Owners with a proven narrower effect may pass scope: worktree, shared, configuration, or
   * repository-instance. A shared/configuration scope reaches contexts already identified by
   * Git as linked worktrees of the same repository. Unidentified contexts remain invocation-local.
   */
  invalidate(options = {}) {
    this.#invalidateDomains(invalidationDomains(options));
  }

  /**
   * Advance the affected observation generations after an editor watcher event, overflow, machine
   * resume, or another explicitly detected external change. The reason is deliberately closed so
   * callers cannot turn arbitrary labels into evidence. Watcher silence is not freshness proof.
   */
  notifyExternalChange(reason, options = {}) {
    if (!['watcher', 'watcher-overflow', 'resume', 'external'].includes(reason)) {
      throw new SingularityFlowError(`Unknown external repository change reason '${reason}'.`, {
        code: 'REPO_CONTEXT_EXTERNAL_CHANGE_INVALID'
      });
    }
    this.invalidate(options);
    return this.#epoch;
  }

  /**
   * A status result is useful UI information, not authorization evidence. Bind all fields to one
   * cache epoch and label that boundary so downstream code cannot mistake a convenient snapshot
   * for sealed input bytes.
   */
  async statusObservation() {
    const observedEpoch = this.#epoch;
    const identity = await this.identity();
    const entries = await this.observe('repository.status');
    if (observedEpoch !== this.#epoch) {
      throw new SingularityFlowError(
        'Repository state changed while its observational status snapshot was being collected.', {
          code: 'REPO_CONTEXT_EPOCH_CHANGED',
          details: { observedEpoch, currentEpoch: this.#epoch }
        }
      );
    }
    return cloneFrozen({
      classification: 'observational',
      observedAt: new Date().toISOString(),
      epoch: observedEpoch,
      repositoryInstanceId: identity.repositoryInstanceId,
      worktreeInstanceId: identity.worktreeInstanceId,
      head: identity.head,
      entries
    });
  }

  /** Advance affected generations before and after every attempted effect, including refusal. */
  async mutate(action, options = {}) {
    if (this.#mutation) throw new SingularityFlowError(
      'A repository mutation is already in progress.', { code: 'REPO_CONTEXT_MUTATION_IN_PROGRESS' }
    );
    const domains = invalidationDomains(options);
    if (this.#isBarred(domains)) throw new SingularityFlowError(
      'A conflicting repository mutation is already in progress.', {
        code: 'REPO_CONTEXT_MUTATION_IN_PROGRESS'
      }
    );
    this.#mutation = true;
    this.#mutationDomains = domains;
    this.#invalidateDomains(domains);
    this.#setSiblingBarrier(domains, true);
    try {
      return await action();
    } finally {
      this.#invalidateDomains(domains);
      this.#setSiblingBarrier(domains, false);
      this.#mutationDomains = [];
      this.#mutation = false;
    }
  }

  async identity() {
    const [paths, root, objectFormat, bare, head, branch] = await Promise.all([
      this.observe('repository.paths'), this.observe('repository.root'),
      this.observe('repository.object-format'), this.observe('repository.bare'),
      this.observe('repository.head'), this.observe('repository.branch')
    ]);
    return cloneFrozen({
      root,
      gitDir: paths.gitDir,
      commonDir: paths.commonDir,
      objectFormat,
      bare,
      unborn: head == null,
      detached: head != null && branch == null,
      head,
      branch,
      repositoryInstanceId: localId('repo', paths.commonDir),
      worktreeInstanceId: localId('worktree', paths.gitDir)
    });
  }
}

export function createRepoContext(root, options) {
  return new RepoContext(root, options);
}
