import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';

import { gitDir } from './git.mjs';
import { canonicalJson } from './records.mjs';
import { run } from './util.mjs';

/**
 * Content-address the three Git trees that make up the repository state a governed action sees.
 *
 * Porcelain status is only a catalogue of paths and states. Its bytes do not change when a file
 * that is already dirty changes again, so it cannot bind a handle or acknowledgement to the bytes
 * a person reviewed. Git tree objects give us the exact invariant without reading paths using
 * application-level filesystem semantics: HEAD, the real index, and a private index containing the
 * complete visible working tree (including untracked paths, modes, deletions, and symlinks).
 *
 * The private index is essential. Running `git add` against the real index would mutate developer
 * state merely to inspect it.
 */
export function worktreeFingerprint(root) {
  const temporaryRoot = path.join(gitDir(root), 'singularity-flow', 'temporary-indexes');
  mkdirSync(temporaryRoot, { recursive: true });
  const scratch = mkdtempSync(path.join(temporaryRoot, 'worktree-'));
  const indexPath = path.join(scratch, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    const headResult = run('git', ['rev-parse', '--verify', 'HEAD^{tree}'], {
      cwd: root,
      allowFailure: true
    });
    // An unborn repository has no HEAD tree. Git's canonical empty-tree object lets the same
    // fingerprint contract cover it without treating an ordinary new repository as unreadable.
    const headTree = headResult.status === 0
      ? headResult.stdout.trim()
      : run('git', ['mktree'], { cwd: root, input: '' }).stdout.trim();
    const indexResult = run('git', ['write-tree'], { cwd: root, allowFailure: true });
    /**
     * An unmerged index has no tree object, but it still has exact content-addressed stage entries.
     * Treating that ordinary recovery state as "unreadable" made My Work disappear precisely while
     * a developer was resolving a merge. The fallback keeps every stage, mode, object ID, and path
     * in the binding without pretending the conflicted index is a valid Git tree.
     */
    const indexTree = indexResult.status === 0
      ? indexResult.stdout.trim()
      : `unmerged:${createHash('sha256').update(run('git', ['ls-files', '--stage', '-z'], { cwd: root }).stdout).digest('hex')}`;

    if (headResult.status === 0) run('git', ['read-tree', 'HEAD'], { cwd: root, env });
    else run('git', ['read-tree', '--empty'], { cwd: root, env });
    run('git', ['add', '-A'], { cwd: root, env });
    const workingTree = run('git', ['write-tree'], { cwd: root, env }).stdout.trim();
    const trees = { headTree, indexTree, workingTree };
    return Object.freeze({
      ...trees,
      sha256: createHash('sha256').update(canonicalJson(trees)).digest('hex'),
      dirty: headTree !== indexTree || headTree !== workingTree
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
