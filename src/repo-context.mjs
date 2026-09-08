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

export class RepoContext {
  #root;
  #execute;
  #epoch = 0;
  #cache = new Map();
  #pending = new Map();
  #mutation = false;
  #cacheEnabled;

  constructor(root, { execute = executeGitQuery, cache = true } = {}) {
    this.#root = path.resolve(root);
    this.#execute = execute;
    this.#cacheEnabled = cache !== false;
  }

  get root() { return this.#root; }
  get epoch() { return this.#epoch; }

  #key(id, params, dependency) {
    const suffix = JSON.stringify(stable(params));
    return `${dependency === 'mutable' ? this.#epoch : 'stable'}:${id}:${suffix}`;
  }

  async observe(id, params = {}) {
    const descriptor = gitQueryDescriptor(id);
    if (this.#mutation && descriptor.dependency === 'mutable') throw new SingularityFlowError(
      'Repository observations are paused while a registered mutation is in progress.', {
        code: 'REPO_CONTEXT_MUTATION_IN_PROGRESS', details: { queryId: id }
      }
    );
    const observedEpoch = this.#epoch;
    const key = this.#key(id, params, descriptor.dependency);
    if (this.#cacheEnabled && this.#cache.has(key)) {
      incrementCommandCounter('cache.hits');
      return cloneFrozen(this.#cache.get(key));
    }
    if (this.#cacheEnabled && this.#pending.has(key)) {
      incrementCommandCounter('cache.hits');
      incrementCommandCounter('git.coalesced-requests');
      return cloneFrozen(await this.#pending.get(key));
    }
    incrementCommandCounter('cache.misses');
    const pending = Promise.resolve().then(() => this.#execute(this.#root, id, structuredClone(params)));
    if (this.#cacheEnabled) this.#pending.set(key, pending);
    try {
      const value = cloneFrozen(await pending);
      if (this.#cacheEnabled
          && (descriptor.dependency !== 'mutable' || observedEpoch === this.#epoch)) {
        this.#cache.set(key, value);
      }
      return cloneFrozen(value);
    } finally {
      if (this.#cacheEnabled && this.#pending.get(key) === pending) this.#pending.delete(key);
    }
  }

  invalidate({ configuration = true } = {}) {
    incrementCommandCounter('cache.invalidations');
    this.#epoch += 1;
    for (const key of this.#cache.keys()) {
      if (key.startsWith('stable:')) {
        if (configuration && key.includes(':repository.remote')) this.#cache.delete(key);
      } else this.#cache.delete(key);
    }
  }

  /**
   * Advance the mutable observation epoch after an editor watcher event, overflow, machine resume,
   * or another explicitly detected external checkout change. The reason is deliberately closed so
   * callers cannot turn arbitrary labels into evidence.
   */
  notifyExternalChange(reason) {
    if (!['watcher', 'watcher-overflow', 'resume', 'external'].includes(reason)) {
      throw new SingularityFlowError(`Unknown external repository change reason '${reason}'.`, {
        code: 'REPO_CONTEXT_EXTERNAL_CHANGE_INVALID'
      });
    }
    this.invalidate();
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

  async mutate(action) {
    if (this.#mutation) throw new SingularityFlowError(
      'A repository mutation is already in progress.', { code: 'REPO_CONTEXT_MUTATION_IN_PROGRESS' }
    );
    this.#mutation = true;
    this.invalidate();
    try {
      return await action();
    } finally {
      this.invalidate();
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
