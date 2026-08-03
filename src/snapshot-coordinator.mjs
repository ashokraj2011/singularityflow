import { createHash } from 'node:crypto';
import { branch, head } from './git.mjs';
import { SingularityFlowError, run } from './util.mjs';

function worktreeHash(root) {
  const status = run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root });
  return createHash('sha256').update(status.stdout).digest('hex');
}

function revision(root) {
  return {
    branch: branch(root),
    head: head(root),
    worktreeHash: worktreeHash(root)
  };
}

function sameRevision(left, right) {
  return left.branch === right.branch && left.head === right.head && left.worktreeHash === right.worktreeHash;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function subjectRevision(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

/** Captures one coherent repository moment for every requested read-model slice. */
export class SnapshotCoordinator {
  constructor(root) { this.root = root; }

  async capture(loader, { included = null } = {}) {
    const before = revision(this.root);
    const value = await loader({ revision: before, included: included ? [...included] : null });
    const after = revision(this.root);
    if (!sameRevision(before, after)) {
      throw new SingularityFlowError('Repository state changed while the snapshot was being assembled. Refresh and retry.');
    }
    const requested = included?.length ? [...new Set(included)] : null;
    const selected = requested
      ? Object.fromEntries(requested.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]))
      : value;
    const includedSlices = requested ?? Object.keys(value).filter((key) => !['schemaVersion', 'revision', 'included', 'warnings'].includes(key));
    return {
      ...selected,
      schemaVersion: 2,
      revision: { ...before, subjectRevision: subjectRevision(selected) },
      included: includedSlices,
      warnings: [...(value.warnings ?? [])]
    };
  }
}
