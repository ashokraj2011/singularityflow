import { workflowNextSteps } from './nextsteps.mjs';
import { copilotAction } from './copilot-guidance.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';

/** Presentation of post-state only: this neither executes a next action nor grants authority. */
export function phaseContinuation(workflow, { reviewedPhaseId = null, primary = null, snapshot = null, ...options } = {}) {
  const historical = reviewedPhaseId && reviewedPhaseId !== workflow.currentPhase;
  const actions = historical ? [copilotAction({
    timing: 'now', skill: '/sf-nextsteps',
    command: `singularity-flow nextsteps ${workflow.workItem.id} --json`,
    reason: 'This is not the active phase. Inspect the current lifecycle before taking another action.'
  })] : primary ? [copilotAction({ timing: 'now', ...primary })] : snapshot?.actions ?? workflowNextSteps(workflow, options);
  const nextAction = actions.find(entry => ['now', 'blocked'].includes(entry.timing)) ?? null;
  return { workId: workflow.workItem.id, phase: workflow.currentPhase ?? null, reviewedPhaseId,
    automaticAdvance: false, actions, nextAction, nextCommand: nextAction?.command ?? null,
    nextSkill: nextAction?.skill ?? null, copilotCommand: nextAction?.copilotCommand ?? null };
}

/** Render just the immediate, verified action. The structured projection retains later choices. */
export function phaseContinuationLines(continuation) {
  const first = continuation?.nextAction;
  if (!first) return ['Next action: no immediate action returned.'];
  const guidance = safeCommandGuidance(first);
  if (!guidance) return ['Next action: inspect the returned diagnostics; no safe command pair was verified.'];
  return ['Next action:', first.reason ?? 'Follow the current lifecycle; this inspection is not approval.',
    `Shell: ${guidance.command}`, `Copilot: ${guidance.copilotCommand}`];
}
