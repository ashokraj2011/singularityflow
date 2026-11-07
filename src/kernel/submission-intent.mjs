/** Submission preflight policy. No host discovery, I/O, provider or command renderer. */
import { SingularityFlowError } from '../foundation/failures.mjs';
import { isConvergencePhase } from './phase-policy.mjs';
import { submittedDecisionInputPlan } from './lifecycle-transitions.mjs';

export function submissionDecisionIntent(workflow, phase, values = {}) {
  const supplied = Object.keys(values).length > 0;
  if (phase.status === 'awaiting_approval') return { ignoredDecisionValues: supplied };
  submittedDecisionInputPlan(workflow,phase,values);
  return { ignoredDecisionValues: false };
}

/** The ordinary operation cannot acquire convergence authority from an input flag. */
export function assertSubmissionIntent(workflow, phase, { confirmedConvergence = false, confirmation = null } = {}) {
  if (confirmedConvergence && !isConvergencePhase(phase)) throw new SingularityFlowError(
    'A confirmed convergence submission requires the convergence phase.', { code: 'CONVERGENCE_PHASE_REQUIRED' });
  if (!isConvergencePhase(phase)) return;
  const workId = workflow.workItem.id;
  if (!confirmedConvergence || typeof confirmation !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(confirmation)) {
    throw new SingularityFlowError(
      `Convergence can be submitted only through explicit human advancement. Run singularity-flow story advance --work-id ${workId} to review the deterministic result and receive its digest-bound confirmation command.`,
      { code: 'CONVERGENCE_ADVANCE_CONFIRMATION_REQUIRED', details: { workId, nextAction: `singularity-flow story advance --work-id ${workId}` } });
  }
  if (phase.approvalPolicy?.mode !== 'required') throw new SingularityFlowError(
    `Convergence phase '${phase.id}' requires a non-waivable human approval after explicit advancement; approval modes 'none' and 'policy' are not permitted.`,
    { code: 'CONVERGENCE_HUMAN_APPROVAL_REQUIRED' });
}

/** Confirm the exact reviewed convergence result; no actor or approval is supplied by this claim. */
export function assertConvergenceAdvanceConfirmation(workId, supplied, expected) {
  if (supplied !== expected) throw new SingularityFlowError(
    `The convergence result changed after preview. Review it again and confirm ${expected}.`, {
      code: 'CONVERGENCE_ADVANCE_CONFIRMATION_STALE',
      details: {workId, supplied, expected}
    }
  );
}
