/**
 * Changes in a published code step's write scope that its published draft does not hold (N7, seen live
 * 2026-11-11): a code step's own uncommitted edit to a file no plan names (index.html), made after the step
 * was published, passed submission and first showed at approval, as a checkout hold routed to /sf-recover.
 *
 * Prepublish refuses such a file while a draft is open; nothing looked again after publication. Submission,
 * the readiness answer that offers it, and approval now read the same thing here: application files changed
 * after the published draft, uncommitted or committed since its commit. Each is repaired in the step: start
 * the next draft that includes the change (the person confirms it), or the person sets the change aside.
 * Approval's checkout hold for these files leads with the same two routes, never with recovery.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { applicationPathContext, isApplicationChangePath } from './application-paths.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { publishedGenerationCommit } from './generation-publication-store.mjs';
import { committedChangedPaths } from './git.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { SingularityFlowError } from './util.mjs';

export const CHANGED_AFTER_PUBLICATION = 'CODE_CHANGED_AFTER_PUBLICATION';

/** Whether `phase` is a current code step whose draft is published (submitted or not). */
function publishedCodeStep(workflow, phase) {
  return Boolean(phase) && phaseRequiresCodeDelivery(phase) && workflow?.currentPhase === phase.id
    && ['in_progress', 'awaiting_approval'].includes(phase.status) && Number(phase.generation ?? 0) > 0
    && phase.generationIntent?.status === 'consumed' && Number(phase.generationIntent.generation) === Number(phase.generation);
}

/**
 * The application files changed after `phase`'s published draft: `uncommitted` in this checkout (the files
 * approval's checkout check holds), and `committed` since the draft's commit. Null when there are none, when
 * the step is not a published code step, or when Git cannot say (the gates themselves still check).
 */
export async function changesAfterPublication(root, config, workflow, phase) {
  if (!publishedCodeStep(workflow, phase)) return null;
  let generationCommit;
  try { generationCommit = publishedGenerationCommit(root, workflow, phase, phase.generation); }
  catch { return null; }
  if (!generationCommit) return null;
  const context = applicationPathContext(config, workflow);
  const { inspectLifecycleWorktree } = await import('./lifecycle-worktree.mjs');
  let uncommitted;
  try {
    uncommitted = [...new Set(inspectLifecycleWorktree(root, config, workflow).entries.flatMap((entry) =>
      [entry.path, entry.originalPath].filter((item) => item?.kind === 'utf8')
        .filter((item) => isApplicationChangePath(item.value, { ...context, untracked: entry.type === 'untracked' }))
        .map((item) => item.value)))].sort();
  } catch { return null; }
  const committed = [...new Set(committedChangedPaths(root, generationCommit)
    .filter((candidate) => isApplicationChangePath(candidate, context)))].sort();
  if (!uncommitted.length && !committed.length) return null;
  return { phase: phase.id, generation: Number(phase.generation), generationCommit, uncommitted, committed,
    paths: [...new Set([...uncommitted, ...committed])].sort() };
}

const listed = (paths) => `${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ` and ${paths.length - 5} more` : ''}`;

/**
 * The in-step repair: start the next draft with the change, or set it aside. Before submission the next
 * draft opens from `phase rollover` (a preview the person confirms); once submitted, an approver returns
 * the step to itself first. `setAside` is the person's own command from recovery, when it covers the files.
 */
export function changesAfterPublicationRoutes(workflow, phase, changes, setAside = null) {
  const workId = workflow.workItem.id;
  const next = Math.max(Number(phase.generation ?? 0), Number(phase.generationHighWatermark ?? 0)) + 1;
  const kept = `draft ${phase.generation} stays as published`;
  const include = phase.status === 'awaiting_approval'
    ? { command: `singularity-flow reject ${phase.id} --work-id ${workId} --to ${phase.id} --reason <REASON>`, skill: '/sf-reject',
      label: `To keep the change: an approver of ${phase.id} returns it to itself, and its author makes draft ${next} with ${listed(changes.paths)}; ${kept}.` }
    : { command: `singularity-flow phase rollover ${phase.id} --json`, skill: '/sf-recover', copilotCommand: `/sf-code ${phase.id}`,
      label: `To keep the change: start draft ${next} of ${phase.id} that includes ${listed(changes.paths)}. Preview it, and the person confirms; ${kept}.` };
  const aside = setAside?.command && changes.uncommitted.length && changes.uncommitted.every((entry) => (setAside.paths ?? []).includes(entry))
    ? { command: setAside.command, paths: setAside.paths, humanOnly: true,
      label: `Or, to leave it out: the person sets ${listed(changes.uncommitted)} aside in their own terminal (a private copy is kept); then ${phase.status === 'awaiting_approval' ? 'approve' : 'submit'} draft ${phase.generation} as it is.` }
    : null;
  return { include, setAside: aside };
}

/** The person's set-aside command from recovery for this checkout, or null when recovery offers none. */
export async function setAsideFor(root, config, workflow) {
  try {
    // Read from the CLI source: the editor bundles that read readiness do not carry the recovery plan.
    const plan = await (await import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'collaboration.mjs')).href))
      .recoveryPlan(root, config, workflow, { inspectActivePhase: true });
    const action = plan.actions.find((entry) => entry.id === 'set-aside-worktree');
    return action?.command ? { command: action.command, paths: action.paths ?? [] } : null;
  } catch { return null; }
}

/** The refusal submission gives for changes after publication, with the in-step routes. */
export function changesAfterPublicationError(workflow, phase, changes, setAside = null) {
  const routes = changesAfterPublicationRoutes(workflow, phase, changes, setAside);
  const how = [changes.uncommitted.length ? `${listed(changes.uncommitted)} ${changes.uncommitted.length === 1 ? 'is' : 'are'} changed in this checkout` : null,
    changes.committed.length ? `${listed(changes.committed)} ${changes.committed.length === 1 ? 'was' : 'were'} committed since` : null].filter(Boolean).join(', and ');
  return new SingularityFlowError(
    `${phase.id} draft ${phase.generation} is published, and ${how}: the published draft does not hold ${changes.paths.length === 1 ? 'that change' : 'those changes'}, so it is not submitted with ${changes.paths.length === 1 ? 'it' : 'them'}. `
    + `Repair it in this step. ${routes.include.label}${routes.setAside ? ` ${routes.setAside.label}` : ''} Nothing was submitted.`,
    { code: CHANGED_AFTER_PUBLICATION, details: {
      workId: workflow.workItem.id, phase: phase.id, generation: phase.generation, paths: changes.paths,
      uncommitted: changes.uncommitted, committed: changes.committed, repairScope: 'current-phase',
      nextAction: routes.include, ...(routes.setAside ? { setAside: routes.setAside } : {})
    } });
}

/**
 * Approval's checkout hold, when what it holds is the current code step's own files changed after its
 * publication: its routes lead with the same in-step repair (a return to itself for the next draft, or the
 * person's set-aside), not with recovery. Any doubt leaves the refusal as it is.
 */
export async function withChangesAfterPublicationRoutes(error, root, config, workflow) {
  if (error?.code !== 'LIFECYCLE_WORKTREE_REVIEW_REQUIRED' || !workflow?.currentPhase) return error;
  try {
    const phase = workflow.phases?.[workflow.currentPhase];
    const changes = await changesAfterPublication(root, config, workflow, phase);
    const held = error.details?.paths ?? [];
    if (!changes?.uncommitted.length || !changes.uncommitted.some((entry) => held.includes(entry))) return error;
    // The checkout's own files: a commit after submission is the approval gate's other refusal.
    const routes = changesAfterPublicationRoutes(workflow, phase, { ...changes, paths: changes.uncommitted, committed: [] }, error.details?.setAside ?? null);
    error.details = { ...error.details, nextAction: routes.include,
      changedAfterPublication: { phase: phase.id, generation: phase.generation, paths: changes.uncommitted, include: routes.include,
        ...(routes.setAside ? { setAside: routes.setAside } : {}) } };
  } catch { /* The refusal stands on its own routes. */ }
  return error;
}
