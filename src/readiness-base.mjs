/** Evaluate an immutable selected base without switching or cleaning the user's checkout. */
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { head } from './git.mjs';
import { run, removeTemporaryTree, SingularityFlowError } from './util.mjs';
import { withoutGitProcessOverrides } from './git-enterprise-environment.mjs';
import { gitDisabledHooksPath } from './git-isolation-paths.mjs';

function baselineGit(root, args, { allowFailure = false } = {}) {
  return run('git', ['-c', `core.hooksPath=${gitDisabledHooksPath()}`, ...args], {
    cwd: root, allowFailure,
    env: { ...withoutGitProcessOverrides(), GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' }
  });
}

export async function withReadinessBase(root, commit, callback) {
  if (!commit) return callback(root);
  if (!/^[a-f0-9]{40,64}$/u.test(commit)) throw new SingularityFlowError(
    '--base-commit requires an exact local Git commit, not a branch or path.', { code: 'TEST_BASELINE_CHOICE_INVALID' });
  const verified = baselineGit(root, ['rev-parse', '--verify', `${commit}^{commit}`]).stdout.trim();
  if (verified !== commit) throw new SingularityFlowError('The selected baseline commit is unavailable.', { code: 'TEST_BASELINE_UNKNOWN' });
  if (head(root) === commit && !baselineGit(root,
    ['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=normal']).stdout.trim()) return callback(root);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sf-baseline-'));
  const target = path.join(directory, 'r');
  let added = false;
  try {
    baselineGit(root, ['worktree', 'add', '--detach', '--no-checkout', '--', target, commit]);
    added = true;
    const sparse = baselineGit(root, ['config', '--bool', 'core.sparseCheckout'], { allowFailure: true });
    if (![0, 1].includes(sparse.status)) throw new SingularityFlowError('Sparse checkout policy could not be inspected; baseline checkout was not populated.', { code: 'TEST_BASELINE_UNKNOWN' });
    const checkoutArgs = [];
    if (sparse.status === 0 && sparse.stdout.trim() === 'true') {
      const source = baselineGit(root, ['rev-parse', '--git-path', 'info/sparse-checkout']).stdout.trim();
      const destination = baselineGit(target, ['rev-parse', '--git-path', 'info/sparse-checkout']).stdout.trim();
      const absoluteDestination = path.resolve(target, destination);
      await mkdir(path.dirname(absoluteDestination), { recursive: true });
      await writeFile(absoluteDestination, await readFile(path.resolve(root, source)));
      const cone = baselineGit(root, ['config', '--bool', 'core.sparseCheckoutCone'], { allowFailure: true });
      if (![0, 1].includes(cone.status)) throw new SingularityFlowError('Sparse cone policy could not be inspected.', { code: 'TEST_BASELINE_UNKNOWN' });
      checkoutArgs.push('-c', 'core.sparseCheckout=true', '-c', `core.sparseCheckoutCone=${cone.stdout.trim() === 'true'}`);
    }
    baselineGit(target, [...checkoutArgs, 'read-tree', '-mu', 'HEAD']);
    return await callback(target);
  } finally {
    let retained = null;
    try {
      // A timed-out add can have registered its checkout before the runner reported failure.
      const registered = added || baselineGit(root, ['worktree', 'list', '--porcelain'], { allowFailure: true })
        .stdout.split('\n').includes(`worktree ${target}`);
      const removed = registered ? baselineGit(root, ['worktree', 'remove', '--force', '--', target], { allowFailure: true }) : { status: 0 };
      if (removed.status !== 0) retained = target;
      else await removeTemporaryTree(directory);
    } catch {
      retained = directory;
    }
    if (retained) {
      // Only our newly allocated checkout is retained. Cleanup must not mask completed evidence
      // or the original refusal, and returned records may be immutable or already printed.
      process.stderr.write(`Baseline temporary checkout retained for cleanup: ${retained}\n`);
    }
  }
}
