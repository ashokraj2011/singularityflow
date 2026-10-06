import { lstatSync } from 'node:fs';
import path from 'node:path';
import { applicationPathContext, isTransientTestResultPath } from './application-paths.mjs';
import { worktreeStatusDetail } from './git.mjs';
import { assertNoHiddenWorktreeChanges } from './worktree-fingerprint.mjs';
import { SingularityFlowError } from './util.mjs';

// Transport output is not authoring. Never make tracked reports, links, conflicts, submodules,
// or arbitrary generated directories disappear from a lifecycle boundary's review roster.
export function regularWorktreeFile(root, relative) {
  if (!relative || relative.includes('\\') || path.isAbsolute(relative)
      || /^[A-Za-z]:/u.test(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) return false;
  let cursor = root;
  try {
    const parts = relative.split('/');
    return parts.every((part, index) => {
      cursor = path.join(cursor, part);
      const stat = lstatSync(cursor);
      return !stat.isSymbolicLink() && (index === parts.length - 1 ? stat.isFile() : stat.isDirectory());
    });
  } catch { return false; }
}

export function inspectLifecycleWorktree(root, config = null, workflow = null) {
  const { entries } = worktreeStatusDetail(root);
  const ownership = applicationPathContext(config, workflow);
  const reports = entries.filter(entry => entry.type === 'untracked' && entry.path.kind === 'utf8'
    && isTransientTestResultPath(entry.path.value, ownership) && regularWorktreeFile(root, entry.path.value));
  return {
    entries: entries.filter(entry => !reports.includes(entry)),
    disposableUntrackedPaths: reports.map(entry => entry.path.value).sort()
  };
}

export function assertLifecycleWorktreeClean(root, config = null, workflow = null, { workId = null } = {}) {
  assertNoHiddenWorktreeChanges(root, 'Lifecycle decision');
  const inspection = inspectLifecycleWorktree(root, config, workflow);
  if (!inspection.entries.length) return inspection;
  const id = workflow?.workItem?.id ?? workId;
  const command = `singularity-flow recover${id ? ` ${id}` : ''} --json`;
  throw new SingularityFlowError(
    'Authored changes need review before this lifecycle decision. Preserve them; recovery offers an exact, confirmed commit for eligible code-phase changes, then revalidation. Untracked test reports alone do not block.',
    { code: 'LIFECYCLE_WORKTREE_REVIEW_REQUIRED', details: {
      workId: id, paths: inspection.entries.map(entry => entry.path.display),
      preserved: ['working-tree bytes', 'Git index', 'test reports', 'published generations'],
      recoveryCommand: command
    } }
  );
}
