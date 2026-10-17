/** Canonical strict Story load. Amendments retain their original forensic revalidation owners. */
import path from 'node:path';
import { branch } from './git.mjs';
import { SingularityFlowError, readJson, invariant } from './util.mjs';
import { buildRepositorySubjectIndex, resolveContext } from './repository-subject-index.mjs';
import { normalizeCurrentWorkflow } from './story-state-normalization.mjs';
import { needsAcceptedPhaseInterpretation } from './phase-semantics.mjs';
import { resolveStoryExecutionCatalog, verifyStoryCatalogAmendments } from './story-execution-context.mjs';
import { verifyRejectedSkillVersionReviews } from './workflow-snapshots.mjs';
import { workflowBranchAllowed } from './story-paths.mjs';

export function attachLegacyGovernedRoots(workflow, config) {
  if (!Array.isArray(workflow.resolution?.governedRoots)
      && Array.isArray(config?.governedRoots)) {
    Object.defineProperty(workflow.resolution, 'governedRoots', {
      value: config.governedRoots,
      enumerable: false,
      configurable: true
    });
  }
  return workflow;
}

export async function loadWorkflow(root, config, id = undefined) {
  return (await readWorkflow(root, config, id, false)).workflow;
}

/** Strict load with its freshly verified catalog; no optional bypass or cross-load cache. */
export async function loadWorkflowWithExecution(root, config, id = undefined) {
  return readWorkflow(root, config, id, true);
}

async function readWorkflow(root, config, id, includeExecution) {
  const index = await buildRepositorySubjectIndex(root, { definition: config });
  let selected = resolveContext(index, {
    reference: id ?? branch(root),
    kind: 'story',
    required: false
  });
  if (id == null && !selected) {
    const session = await (await import('./session.mjs')).loadSession(root, { required: false });
    if (session?.workId) selected = resolveContext(index, { reference: session.workId, kind: 'story', required: false });
  }
  if (!selected) {
    const requested = id ?? branch(root);
    // A state file that exists but will not parse is the likeliest reason a Story "does not exist",
    // and saying so is the difference between fixing a file and hunting for a missing directory.
    const unreadable = index.unreadable ?? [];
    const requestedStateUnreadable = unreadable.some((entry) => (
      path.posix.basename(path.posix.dirname(String(entry.path ?? '').replaceAll('\\', '/')))
        === requested
    ));
    throw new SingularityFlowError(
      `No workflow found for ${requested}. The repository subject index contains no matching Story ID or registered branch alias.`
      + (unreadable.length
        ? ` These state files exist but could not be read: ${unreadable.map((entry) => `${entry.path} (${entry.reason})`).join('; ')}.`
        : ''),
      {
        code: requestedStateUnreadable ? 'STORY_STATE_UNREADABLE' : 'STORY_NOT_FOUND',
        details: { requested }
      }
    );
  }
  const file = path.join(root, selected.location.path);
  const workflow = attachLegacyGovernedRoots(normalizeCurrentWorkflow(await readJson(file)), config);
  invariant(workflow.workItem?.id === selected.id, `Workflow ID does not match indexed Story ${selected.id}.`);
  if (id == null && !workflowBranchAllowed(workflow, branch(root))) {
    throw new SingularityFlowError(`Current branch '${branch(root)}' is not registered for Story '${workflow.workItem.id}'. Run singularity-flow story branch attach --parent ${workflow.workItem.id}.`);
  }
  let executionCatalog = null;
  if (Number(workflow.workflowSnapshot?.revision ?? 1) > 1) {
    if (includeExecution) {
      executionCatalog = await resolveStoryExecutionCatalog(root, config, workflow);
      await verifyStoryCatalogAmendments(root, config, workflow, executionCatalog);
    } else {
      // Ordinary domain reads retain their existing forensic-only contract. Asking for a
      // catalog adds interpretation; it must not make this API depend on agent selection.
      const { verifyAcceptedSkillAmendmentRevalidation } = await import('./state.mjs');
      const { verifyAcceptedTestCommandAmendment } = await import('./story-test-command-amendment.mjs');
      const verified = await verifyAcceptedSkillAmendmentRevalidation(root, config, workflow);
      await verifyAcceptedTestCommandAmendment(root, config, workflow, verified);
    }
  }
  verifyRejectedSkillVersionReviews(root, config, workflow);
  if (!executionCatalog && needsAcceptedPhaseInterpretation(workflow)) {
    executionCatalog = await resolveStoryExecutionCatalog(root, config, workflow);
  }
  return { workflow, executionCatalog };
}

