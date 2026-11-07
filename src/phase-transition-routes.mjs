/** Host wording and command rendering for provider-neutral continuation actions. */
import { convergenceTransitionPlan } from './kernel/phase-policy.mjs';
import { generationSkillForPhase } from './code-delivery-policy.mjs';
import { decisionSubmitArguments } from './workflow-decisions.mjs';
import { SingularityFlowError } from './foundation/failures.mjs';

/** Semantic kinds are not shell fragments. Every command is constructed by this host adapter. */
export function continuationActionPresentation(action, { workflow, phase, authoringProgress = null } = {}) {
  if (action.transition) {
    const {transition,...semantic}=action;
    return {classification:transition.classification,lifecycleReady:transition.lifecycleReady,reasonCode:transition.reasonCode,
      ...continuationActionPresentation(semantic,{workflow,phase,authoringProgress})};
  }
  const id = action.phaseId, workId = action.workId;
  const route = (skill, command, reason, fields = {}) => ({ skill, command, reason, ...fields });
  switch (action.kind) {
    case 'acknowledge-intent-amendment': return {
      command: `singularity-flow story intent-amendment acknowledge ${action.amendmentId} --work-id ${workId}`,
      reason: 'Review the changed clauses and affected phases, then acknowledge only with the contributor\'s explicit choice.' };
    case 'select-phase-author': return route('/sf-agent', `singularity-flow agent --agent ${action.agentId}`,
      'Select the accepted phase author; do not relabel the published generation.');
    case 'return-phase': return action.purpose === 'reviewer-authored-generation'
      ? route('/sf-reject', `singularity-flow reject ${id} --work-id ${workId} --fetch --to ${action.targetPhase} --reason "Re-author under the accepted phase author for independent review"`,
        'An authorized human must return the submitted generation before authoring its successor.')
      : route('/sflow-reject', `singularity-flow reject ${id} --work-id ${workId} --fetch --to ${action.targetPhase} --reason <reason>`,
        `Request an authorized correction within ${id}; prior phase approvals remain unchanged.`);
    case 'review-code-successor': return route('/sf-recover', `singularity-flow phase rollover ${id} --json`,
      action.purpose === 'reviewer-authored-generation'
        ? 'Preview and review the exact successor-generation digest before reopening code authoring.'
        : 'Review the guarded code successor boundary; preserve the published generation and its tests.');
    case 'prepare-phase': {
      const reason = action.purpose === 'reviewer-authored-generation'
        ? 'Re-author against the current approved inputs and publish a new generation, preserving all prior evidence.'
        : action.purpose === 'source-review-correction'
          ? `Resume the phase author and prepare generation ${action.targetGeneration}. Preserve any private corrected draft, author it at the returned artifact path, then draft-check and prepublish. Publish only when the returned gates are ready; ${action.sourceReviewRequired ? 'review the published successor afterward' : 'follow its returned submission handoff'}.`
          : action.deterministicConvergence
            ? 'Compute the deterministic convergence projection, then follow its returned adjudication, rework, amendment, or publication action.'
            : `${action.regenerate ? 'Regenerate' : 'Generate'} the required ${phase.label} artifact, then publish it.`;
      return route(generationSkillForPhase(phase, workflow), `singularity-flow prepare ${id}`, reason);
    }
    case 'prepare-convergence': return route('/sflow-converge', `singularity-flow prepare ${id}`,
      'Compute a fresh deterministic Convergence projection before publication or advancement.');
    case 'recover-publication-record': return route('/sflow-recover', `singularity-flow recover ${workId} --phase ${id} --json`,
      'Repair the missing publication record before requesting exact Convergence review; a soft sequence exception cannot replace it.');
    case 'advance-convergence': return route('/sflow-submit', `singularity-flow story advance --work-id ${workId}`,
      'Review the exact deterministic Convergence result and confirm its digest before human approval.');
    case 'inspect-lifecycle': return route('/sf-nextsteps', `singularity-flow nextsteps ${workId} --json`,
      'Inspect the current lifecycle. Submitted evidence requires an authorized return before authoring a successor.');
    case 'decide-source-review-finding': return route('/sf-review-decide',
      `singularity-flow review-source decision-context ${id} --work-id ${workId} --finding ${action.findingId} --reason <TEXT> --json`,
      'An authorized human must decide this exact pending disposition; the reviewer cannot accept it.');
    case 'submit-phase': return action.purpose === 'reviewed-source'
      ? route('/sf-submit', `singularity-flow submit ${id} --work-id ${workId}${decisionSubmitArguments(workflow, id)}`,
        'Run configured checks and submit the reviewed publication; this review is not approval.')
      : route('/sflow-submit', `singularity-flow submit ${id}${decisionSubmitArguments(workflow, id)}`, action.approvalRequired
        ? `Run configured checks and submit ${id} for approval.`
        : `Run configured checks, complete ${id} without approval, and advance to the next phase.`);
    case 'review-published-source': return route('/sf-review-source', `singularity-flow review-source context ${id} --json`,
      'Review the exact published generation and its pinned answers; never review an unpublished draft as a successor.');
    case 'check-source-review-status': return route('/sflow-review-source', `singularity-flow review-source status ${id}`,
      `Check the independent source review of ${id} and any human decisions it still needs, then submit.`);
    case 'view-phase-documents': return route('/sflow-phase-documents', `singularity-flow phase show ${id} --show-artifact`,
      `Optionally view the documents produced in ${id} before submitting.`, { optional: true });
    case 'view-archived-documents': return route('/sflow-documents', `singularity-flow documents list ${workId}`,
      'Review the artifacts preserved with this archived Story.');
    case 'inspect-workflow-decision': return route('/sflow-decide', `singularity-flow decision show ${workId}`,
      `See what '${action.label}' offers and who may choose.`);
    case 'choose-workflow-route': return route('/sflow-decide',
      `singularity-flow decision choose ${workId} --option ${action.optionId} --reason <reason> --expected ${action.expected}`,
      `Choose '${action.optionLabel}' for '${action.label}'.`);
    case 'inspect-workflow-progress': return route('/sflow-progress', `singularity-flow progress ${workId}`,
      'Review the completed workflow and final conformance.');
    case 'approve-phase': return route('/sflow-approve', `singularity-flow approve ${id} --work-id ${workId} --fetch`,
      `Approve ${id} using an authorized human Git identity; the phase-default agent is recorded automatically.`);
    case 'resume-phase-authoring': {
      if (!authoringProgress?.next) throw new SingularityFlowError('The continuation has no captured authoring presentation.', { code: 'ENGINE_PORT_RESULT_INVALID' });
      return { ...authoringProgress.next, reason: authoringProgress.instruction,
        authoringStage: authoringProgress.stage, preserveExistingWork: true };
    }
    case 'propose-intent-amendment': return route('/sflow-reject',
      `singularity-flow story intent-amendment propose --work-id ${workId} --file <AMENDED-SPEC.md> --reason <reason>`,
      'If the approved intent must change, propose a reviewed amendment; no convergence finding or revision loop is required. Existing intent stays approved until the scope authority decides.',
      { optional: true });
    default: throw new SingularityFlowError(`Unknown continuation action '${action.kind}'.`, { code: 'ENGINE_CONTINUATION_UNSUPPORTED' });
  }
}

/** Existing raw Convergence route contract; the shared kernel alone decides its classification. */
export function convergenceTransitionRoute(workflow, phase, options = {}) {
  const plan = convergenceTransitionPlan(workflow, phase, options);
  if (!plan) return null;
  return { classification: plan.classification, lifecycleReady: plan.lifecycleReady, reasonCode: plan.reasonCode,
    ...continuationActionPresentation(plan.actions[0], { workflow, phase }) };
}

/**
 * A cancelled Story is final. Prepare said "reopen it", reopen said "use reject", and resume named a
 * phase 'unknown' with no agent: each pointed at another that refused too (2026-10-28).
 */
export function cancelledStoryRefusal(workflow) {
  const id = workflow?.workItem?.id ?? 'this Story';
  const start = 'singularity-flow start <NEW-WORK-ID>';
  const release = `singularity-flow cancel ${id} --release`;
  return new SingularityFlowError(
    `Story '${id}' was cancelled, and a cancelled Story is final: it is not prepared, reopened or resumed again. `
    + `Start a new Story for the work with ${start}, or release what it still holds with ${release}.`,
    { code: 'STORY_CANCELLED', details: { workId: id, nextAction: start, recoveryCommands: [start, release] } }
  );
}
