import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { SingularityFlowError } from './util.mjs';

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
