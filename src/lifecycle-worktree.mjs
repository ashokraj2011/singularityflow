import { lstatSync } from 'node:fs';
import path from 'node:path';
import { applicationPathContext, isApplicationChangePath, isTestRunnerOutputPath, isTransientTestResultPath } from './application-paths.mjs';
import { isWorkspaceLocalPath } from './workspace-local-paths.mjs';
import { worktreeStatusDetail } from './git.mjs';
import { assertNoHiddenWorktreeChanges } from './worktree-fingerprint.mjs';
import { SingularityFlowError } from './util.mjs';
import { storyLocation } from './story-paths.mjs';

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
// `<file>.tmp-<pid>-<uuid>`, and SFlow's screenshot for a visual sign-off, which the sign-off commits
// (visual-sign-off-capture.mjs). Only inside this Story's own folder; elsewhere it could be anyone's.
const ABANDONED_ATOMIC_WRITE = /\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function abandonedStoryWrite(relative, config, workflow) {
  const id = workflow?.workItem?.id;
  if (!id) return false;
  const itemRoot = `${storyLocation(null, [config, workflow], id).prefix}/`;
  return relative.startsWith(itemRoot) && (ABANDONED_ATOMIC_WRITE.test(relative) || /^evidence\/visual-sign-offs\/[\w.-]+\.png$/u.test(relative.slice(itemRoot.length)));
}

export function inspectLifecycleWorktree(root, config = null, workflow = null, { held = null, leaveCode = false } = {}) {
  const { entries } = worktreeStatusDetail(root);
  const ownership = applicationPathContext(config, workflow);
  const reports = entries.filter(entry => entry.type === 'untracked' && entry.path.kind === 'utf8'
    && (isTransientTestResultPath(entry.path.value, ownership) || isTestRunnerOutputPath(entry.path.value, ownership)
      || abandonedStoryWrite(entry.path.value, config, workflow))
    && regularWorktreeFile(root, entry.path.value));
  // `held`: what is kept in place for a later code step (heldForLaterCode), not this decision's.
  const kept = (entry) => Boolean(held?.size) && [entry.path, entry.sourcePath].filter(Boolean).every(item => item.kind === 'utf8' && held.has(item.value));
  // Unstaged, a workspace-local file (an editor's settings, a local-only file, test output) is nobody's decision [WCB:REQ-002],
  // and so is a document step's code base file, which the code step ahead takes up [WCB:REQ-006]: no SFlow commit takes
  // either. A staged one could be, so it is still held.
  const unstaged = (entry) => ['untracked', 'ordinary'].includes(entry.type) && (entry.type === 'untracked' || entry.xy?.index === '.')
    && entry.path.kind === 'utf8';
  const local = (entry) => !reports.includes(entry) && unstaged(entry) && isWorkspaceLocalPath(entry.path.value);
  const code = (entry) => leaveCode && unstaged(entry) && !local(entry)
    && isApplicationChangePath(entry.path.value, { ...ownership, untracked: entry.type === 'untracked' });
  return {
    entries: entries.filter(entry => !reports.includes(entry) && !kept(entry) && !local(entry) && !code(entry)),
    disposableUntrackedPaths: reports.map(entry => entry.path.value).sort(),
    ...(held?.size ? { heldPaths: entries.filter(kept).flatMap(entry => [entry.path, entry.sourcePath].filter(Boolean).map(item => item.value)).sort() } : {}),
    // What stays where it is, as nobody's decision here: recovery leaves it out of its review roster too.
    ...(entries.some((entry) => local(entry) || code(entry)) ? { leftInPlace: entries.filter((entry) => local(entry) || code(entry)).map(entry => entry.path.value).sort() } : {})
  };
}

/** Whether the Story's current step writes documents only: its decisions leave code base files where they are [WCB:REQ-006]. */
export function documentStepOpen(workflow) {
  const current = workflow?.phases?.[workflow?.currentPhase];
  return Boolean(current) && (current.writeScope ?? 'artifact-only') === 'artifact-only';
}

/**
 * The paths kept in place for a later code step, unchanged since an amendment closed its generation or a return left it
 * open (SPEC-CIC switch 2, amended-drafts.mjs): an earlier document step's decision does not count them. Null when none.
 */
export async function heldForLaterCode(root, config, workflow) {
  const phase = workflow?.phases?.[workflow.currentPhase];
  if (!phase || !Object.values(workflow.phases).some(step => step?.scopePin?.closedChangeSet || step?.heldCode)) return null;
  return (await import('./amended-drafts.mjs')).heldCodePaths(root, config, workflow, phase);
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
  return withChangesAfterPublication(error, root, config, workflow);
}

/**
 * The current code step's own files changed after its publication lead the hold with its in-step repair (N7).
 * Read from the CLI source, so the editor bundles that approve do not carry the check.
 */
export async function withChangesAfterPublication(error, root, config, workflow) {
  if (error?.code !== 'LIFECYCLE_WORKTREE_REVIEW_REQUIRED') return error;
  const [{ pathToFileURL }, { PACKAGE_ROOT }] = await Promise.all([import('node:url'), import('./package-root.mjs')]);
  return (await import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'changes-after-publication.mjs')).href))
    .withChangesAfterPublicationRoutes(error, root, config, workflow);
}

export function assertLifecycleWorktreeClean(root, config = null, workflow = null, { workId = null, held = null } = {}) {
  assertNoHiddenWorktreeChanges(root, 'Lifecycle decision');
  // A document step's decision never holds for code base files left in the checkout [WCB:REQ-006].
  const inspection = inspectLifecycleWorktree(root, config, workflow, { held, leaveCode: documentStepOpen(workflow) });
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
