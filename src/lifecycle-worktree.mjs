import { lstatSync } from 'node:fs';
import path from 'node:path';
import { applicationPathContext, isTestRunnerOutputPath, isTransientTestResultPath } from './application-paths.mjs';
import { worktreeStatusDetail } from './git.mjs';
import { assertNoHiddenWorktreeChanges } from './worktree-fingerprint.mjs';
import { SingularityFlowError } from './util.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';

/** Drafts belong to authoring, not cleanup. Check lifecycle state before approval's clean-tree guard. */
export async function assertApprovalSubmitted(root, config, workflow, { phaseId = workflow?.currentPhase } = {}) {
  const phase = workflow?.phases?.[phaseId];
  if (!phase || phaseId !== workflow.currentPhase || phase.status !== 'in_progress') return;
  const { submissionReadiness } = await import('./submission-readiness.mjs');
  const readiness = await submissionReadiness(root, config, workflow, { phaseId });
  const command = readiness.nextCommand ?? readiness.command ?? 'singularity-flow nextsteps --json';
  const nextAction = readiness.authoringProgress?.next ?? safeCommandGuidance({
    command,
    skill: readiness.nextSkill ?? undefined
  }) ?? safeCommandGuidance(command) ?? safeCommandGuidance('singularity-flow nextsteps --json');
  throw new SingularityFlowError(
    `Phase '${phaseId}' has not been submitted for approval. Preserve the existing draft and follow its authoring, review or submission route in a new turn. No approval was prepared; draft cleanup is not required by this approval attempt.`, {
      code: 'PHASE_NOT_AWAITING_APPROVAL', details: { workId: workflow.workItem.id, phase: phaseId,
        phaseStatus: phase.status, classification: readiness.classification, preserveDraft: true,
        nextAction }
    });
}

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
