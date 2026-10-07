import { phaseContinuation } from './phase-continuation.mjs';
import { submissionReadiness } from './submission-readiness.mjs';
import { storyPublicationPending } from './state-stores.mjs';

function readinessReason(readiness) {
  if (readiness.reason || readiness.continuation?.actions?.[0]?.reason) {
    return readiness.reason ?? readiness.continuation.actions[0].reason;
  }
  if (readiness.classification === 'already-submitted') {
    return 'This publication is submitted. Review its bound packet and obtain an authorized human decision; viewing it is not approval.';
  }
  if (readiness.classification === 'generation-required') {
    return 'Resume this phase’s configured author. Preserve the private draft and publish only after its returned checks are ready.';
  }
  return readiness.lifecycleReady
    ? 'Run the configured checks and submit this publication. Viewing it is not submission or approval.'
    : 'Follow this phase’s verified authoring, review or recovery boundary before submission.';
}

/** Read the same lifecycle/recovery boundaries as submission, never tests or a model. */
export async function reviewContinuation(root, config, workflow, phase) {
  if (phase.id !== workflow.currentPhase) {
    return phaseContinuation(workflow, { reviewedPhaseId: phase.id });
  }
  try {
    const publicationPending = Boolean(await storyPublicationPending(root, config, workflow.workItem.id, { migrate: false }));
    if (publicationPending) return phaseContinuation(workflow, { publicationPending });
    if (!['in_progress', 'awaiting_approval'].includes(phase.status)) return phaseContinuation(workflow);
    if (phase.generationIntent?.status === 'consumed'
        && Number(phase.generationIntent.generation) === Number(phase.generation)) {
      const { recoveryPlan } = await import('./collaboration.mjs');
      const recovery = await recoveryPlan(root, config, workflow, { phaseId: phase.id });
      if (recovery.requiresRecovery) return phaseContinuation(workflow, { recovery });
    }
    const readiness = await submissionReadiness(root, config, workflow, { phaseId: phase.id });
    if (readiness.nextCommand) return phaseContinuation(workflow, { primary: {
      command: readiness.nextCommand, skill: readiness.nextSkill,
      reason: readinessReason(readiness)
    } });
    return phaseContinuation(workflow);
  } catch {
    return phaseContinuation(workflow, { primary: {
      command: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json`,
      skill: '/sf-recover', reason: 'The next action could not be verified. Inspect this phase’s recovery diagnostics; preserve the reviewed files and do not submit or approve unchanged.'
    } });
  }
}
