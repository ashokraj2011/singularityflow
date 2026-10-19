/**
 * Whether a branch's work is already on another branch, from local Git objects only.
 *
 * A merge commit keeps the branch tip as an ancestor of its target. A squash or rebase merge does
 * not: the target receives new commits with the same changes, and hosts commonly delete the
 * source branch afterwards. Asking only "is the tip an ancestor" then reports such work as never
 * merged, forever. The equivalence proof is strict: merging the tip into the target must change
 * nothing, so a later revert of any part of the work on the target is not mistaken for a merge.
 */
import { run } from './util.mjs';

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** The exact commit a revision names locally, or null when Git does not have it. */
export function localCommit(root, revision) {
  // A revision read from a record is data: never let it reach Git as an option.
  if (typeof revision !== 'string' || !revision || revision.startsWith('-')) return null;
  const result = run('git', ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], {
    cwd: root, allowFailure: true
  });
  const sha = result.status === 0 ? result.stdout.trim().toLowerCase() : '';
  return OBJECT_ID.test(sha) ? sha : null;
}

/**
 * How `commit` is on `target`: 'ancestor' (merged with history), 'equivalent' (squashed or
 * rebased: merging it into the target changes nothing), or null when neither is proven, including
 * when either object is missing locally or this Git cannot compute a merge without a worktree.
 */
export function commitLandedOn(root, commit, target) {
  const source = localCommit(root, commit);
  const destination = localCommit(root, target);
  if (!source || !destination) return null;
  if (run('git', ['merge-base', '--is-ancestor', source, destination], {
    cwd: root, allowFailure: true
  }).status === 0) return 'ancestor';
  // Without a common ancestor there is nothing to compare the changes against.
  if (run('git', ['merge-base', source, destination], { cwd: root, allowFailure: true }).status !== 0) return null;
  const merged = run('git', ['merge-tree', '--write-tree', '--no-messages', destination, source], {
    cwd: root, allowFailure: true
  });
  if (merged.status !== 0) return null;
  const tree = merged.stdout.split(/\r?\n/u)[0]?.trim().toLowerCase();
  const destinationTree = run('git', ['rev-parse', '--verify', '--quiet', `${destination}^{tree}`], {
    cwd: root, allowFailure: true
  }).stdout.trim().toLowerCase();
  return OBJECT_ID.test(tree ?? '') && tree === destinationTree ? 'equivalent' : null;
}
