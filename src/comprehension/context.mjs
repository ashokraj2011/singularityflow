/** Shared, read-only selection of the repository interval a comprehension observation describes. */
import { branch } from '../git.mjs';
import { buildRepositorySubjectIndex, resolveContext } from '../repository-subject-index.mjs';
import { SingularityFlowError } from '../util.mjs';

/** Prefer the exact active generation interval, then the strongest recorded delivery baseline. */
export function activeComprehensionBaseline(workflow, requestedPhase = null) {
  const phaseId = requestedPhase ?? workflow.currentPhase ?? null;
  if (!phaseId) return {
    base: workflow.workItem?.baseCommit ?? null,
    phase: null,
    source: workflow.workItem?.baseCommit ? 'story-base' : null
  };
  const phase = workflow.phases?.[phaseId];
  if (!phase) {
    throw new SingularityFlowError(`Story '${workflow.workItem?.id ?? 'unknown'}' has no phase '${phaseId}'.`, {
      code: 'CMP_PHASE_UNKNOWN'
    });
  }
  if (phase.generationIntent?.baseline?.commit) {
    return { base: phase.generationIntent.baseline.commit, phase: phaseId, source: 'generation-intent' };
  }
  const interval = workflow.workIntervals?.current;
  if (interval?.phaseId === phaseId && interval.sourceBaseCommit) {
    return { base: interval.sourceBaseCommit, phase: phaseId, source: 'work-interval' };
  }
  const deliveryBase = phase.deliveryEvidence?.baselineCommit
    ?? phase.deliveryEvidence?.changeSet?.base?.commit
    ?? phase.deliveryEvidence?.tree?.baselineCommit
    ?? null;
  if (deliveryBase) return { base: deliveryBase, phase: phaseId, source: 'delivery-evidence' };
  return {
    base: workflow.workItem?.baseCommit ?? null,
    phase: phaseId,
    source: workflow.workItem?.baseCommit ? 'story-base' : null
  };
}

/**
 * Resolve one Story-bound or repository-only comprehension subject.
 *
 * This function performs no write, model invocation, AST warm-up, or home-directory discovery.
 */
export async function resolveComprehensionBaseline(root, {
  base: explicit = null,
  workId: requestedWorkId = null,
  phase: requestedPhase = null,
  subjectIndex = null
} = {}) {
  if (explicit && !requestedWorkId && !requestedPhase) {
    return { base: explicit, source: 'explicit', workId: null, phase: null };
  }
  const reference = requestedWorkId ?? branch(root);
  const selected = resolveContext(subjectIndex ?? await buildRepositorySubjectIndex(root), {
    reference,
    kind: 'story',
    required: Boolean(requestedWorkId)
  });
  if (selected) {
    const selectedBaseline = activeComprehensionBaseline(selected.state, requestedPhase);
    if (explicit) {
      return {
        base: explicit,
        source: 'explicit',
        workId: selected.state.workItem.id,
        phase: selectedBaseline.phase
      };
    }
    if (selectedBaseline.base) {
      return { ...selectedBaseline, workId: selected.state.workItem.id };
    }
  }
  if (requestedPhase) {
    throw new SingularityFlowError(
      '--phase requires --work-id or an attached Story. For repository-only inspection, use --base without --phase.',
      { code: 'CMP_STORY_CONTEXT_REQUIRED' }
    );
  }
  return { base: 'HEAD', source: 'working-tree-head', workId: null, phase: null };
}
