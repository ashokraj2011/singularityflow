import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { branch, head } from './git.mjs';
import { TimingCollector } from './dx-timings.mjs';
import { SingularityFlowError, run } from './util.mjs';

async function worktreeHash(root) {
  const status = run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root });
  const diff = run('git', ['diff', '--binary', '--no-ext-diff', '--'], { cwd: root });
  const staged = run('git', ['diff', '--cached', '--binary', '--no-ext-diff', '--'], { cwd: root });
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }).stdout
    .split('\0').filter(Boolean).sort();
  const digest = createHash('sha256')
    .update(status.stdout)
    .update('\0WORKTREE-DIFF\0')
    .update(diff.stdout)
    .update('\0INDEX-DIFF\0')
    .update(staged.stdout);
  for (const file of untracked) {
    const absolute = path.join(root, file);
    const stat = await lstat(absolute);
    digest.update('\0UNTRACKED\0').update(file).update('\0');
    if (stat.isSymbolicLink()) digest.update('symlink\0').update(await readlink(absolute));
    else if (stat.isFile()) digest.update('file\0').update(await readFile(absolute));
    else digest.update(`other:${stat.mode}`);
  }
  return digest.digest('hex');
}

async function revision(root) {
  return {
    branch: branch(root),
    head: head(root),
    worktreeHash: await worktreeHash(root)
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
  constructor(root, options = {}) {
    this.root = root;
    this.clock = options.clock;
  }

  async capture(loader, { included = null, ifRevision = null, timings = false } = {}) {
    const timer = new TimingCollector({ enabled: timings, clock: this.clock });
    const before = await timer.measure('revisionBefore', async () => revision(this.root));
    const value = await timer.measure('load', async () => loader({ revision: before, included: included ? [...included] : null }));
    const after = await timer.measure('revisionAfter', async () => revision(this.root));
    if (!sameRevision(before, after)) {
      throw new SingularityFlowError('Repository state changed while the snapshot was being assembled. Refresh and retry.');
    }
    const requested = included?.length ? [...new Set(included)] : null;
    const selected = requested
      ? Object.fromEntries(requested.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]))
      : value;
    const includedSlices = requested ?? Object.keys(value).filter((key) => !['schemaVersion', 'revision', 'included', 'warnings'].includes(key));
    const sliceRevisions = Object.fromEntries(includedSlices
      .filter((key) => Object.hasOwn(selected, key))
      .map((key) => [key, subjectRevision(selected[key])]));
    const selectedRevision = subjectRevision(Object.fromEntries(includedSlices
      .filter((key) => Object.hasOwn(selected, key))
      .map((key) => [key, selected[key]])));
    const notModified = Boolean(ifRevision && ifRevision === selectedRevision);
    const result = {
      schemaVersion: 2,
      revision: { ...before, subjectRevision: selectedRevision, slices: sliceRevisions },
      included: includedSlices,
      warnings: [...(value.warnings ?? [])],
      notModified
    };
    if (!notModified) Object.assign(result, selected);
    const measured = timer.finish();
    if (measured) result.timings = measured;
    return result;
  }
}
