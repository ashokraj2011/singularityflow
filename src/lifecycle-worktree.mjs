import { lstatSync } from 'node:fs';
import path from 'node:path';
import { applicationPathContext, isTestRunnerOutputPath, isTransientTestResultPath } from './engine-compatibility/node-source-policy.mjs';
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

// The temporary file an SFlow atomic write leaves when it is interrupted (util.mjs writeAtomic):
// `<file>.tmp-<pid>-<uuid>`. Only inside this Story's own folder; elsewhere it could be anyone's.
const ABANDONED_ATOMIC_WRITE = /\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function abandonedStoryWrite(relative, config, workflow) {
  const id = workflow?.workItem?.id;
  if (!id || !ABANDONED_ATOMIC_WRITE.test(relative)) return false;
  const itemRoot = `${config?.workItemRoot ?? workflow.resolution?.workItemRoot ?? 'singularity/work-items'}/${id}/`;
  return relative.startsWith(itemRoot);
}

export function inspectLifecycleWorktree(root, config = null, workflow = null) {
  const { entries } = worktreeStatusDetail(root);
  const ownership = applicationPathContext(config, workflow);
  const reports = entries.filter(entry => entry.type === 'untracked' && entry.path.kind === 'utf8'
    && (isTransientTestResultPath(entry.path.value, ownership) || isTestRunnerOutputPath(entry.path.value, ownership)
      || abandonedStoryWrite(entry.path.value, config, workflow))
    && regularWorktreeFile(root, entry.path.value));
  return {
    entries: entries.filter(entry => !reports.includes(entry)),
    disposableUntrackedPaths: reports.map(entry => entry.path.value).sort()
  };
}

/**
 * The exact set-aside command for a held checkout, on the refusal itself: all 3 real sessions that met this
 * stopped there, with a read as their route. Recovery holds the plan hash a person confirms. Any doubt adds nothing.
 */
export async function withSetAsideRoute(error, root, config, workflow) {
  if (error?.code !== 'LIFECYCLE_WORKTREE_REVIEW_REQUIRED' || !workflow) return error;
  try {
    const plan = await (await import('./collaboration.mjs')).recoveryPlan(root, config, workflow, { inspectActivePhase: true });
    const action = plan.actions.find((entry) => entry.id === 'set-aside-worktree');
    if (action?.command) error.details = { ...error.details, setAside: { command: action.command, paths: action.paths } };
  } catch { /* The refusal stands on its own words. */ }
  return error;
}

export function assertLifecycleWorktreeClean(root, config = null, workflow = null, { workId = null } = {}) {
  assertNoHiddenWorktreeChanges(root, 'Lifecycle decision');
  const inspection = inspectLifecycleWorktree(root, config, workflow);
  if (!inspection.entries.length) return inspection;
  const id = workflow?.workItem?.id ?? workId;
  const command = `singularity-flow recover${id ? ` ${id}` : ''} --json`;
  throw new SingularityFlowError(
    'The checkout has changes that are not part of this lifecycle decision. A person reviews them and sets them aside with the confirmed set-aside-worktree route recovery returns (a private recovery copy is kept), or moves them out of the checkout. Do not commit them by hand: a commit after submission makes approval refuse until the step is returned and resubmitted. Eligible code-phase changes can be committed through recovery, then revalidated. Untracked test reports alone do not block.',
    { code: 'LIFECYCLE_WORKTREE_REVIEW_REQUIRED', details: {
      workId: id, paths: inspection.entries.map(entry => entry.path.display),
      preserved: ['working-tree bytes', 'Git index', 'test reports', 'published generations'],
      recoveryCommand: command
    } }
  );
}
