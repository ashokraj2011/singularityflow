import { workflowNextSteps } from './nextsteps.mjs';
import { copilotAction } from './copilot-guidance.mjs';
import { commandRouteLines, safeCommandGuidance } from './safe-command-guidance.mjs';
import { contextBoundaryPresentation, pendingContextBoundary } from './context-policy.mjs';

/** Presentation of post-state only: this neither executes a next action nor grants authority. */
export function phaseContinuation(workflow, { reviewedPhaseId = null, primary = null, snapshot = null, ...options } = {}) {
  const historical = reviewedPhaseId && reviewedPhaseId !== workflow.currentPhase;
  const actions = historical ? [copilotAction({
    timing: 'now', skill: '/sf-nextsteps',
    command: `singularity-flow nextsteps ${workflow.workItem.id} --json`,
    reason: 'This is not the active phase. Inspect the current lifecycle before taking another action.'
  })] : primary ? [copilotAction({ timing: 'now', ...primary })] : snapshot?.actions ?? workflowNextSteps(workflow, options);
  const nextAction = actions.find(entry => ['now', 'blocked'].includes(entry.timing)) ?? null;
  const contextBoundary = snapshot?.contextBoundary ?? (options.publicationPending || options.recovery?.requiresRecovery
    || workflow.pendingDecision || options.stepActionHold?.missing?.length ? null : contextBoundaryPresentation(pendingContextBoundary(workflow)));
  return { workId: workflow.workItem.id, phase: workflow.currentPhase ?? null, reviewedPhaseId,
    ...(contextBoundary ? { contextBoundary } : {}),
    automaticAdvance: false, actions, nextAction, nextCommand: nextAction?.command ?? null,
    nextSkill: nextAction?.skill ?? null, copilotCommand: nextAction?.copilotCommand ?? null,
    modelFreeCommand: nextAction ? safeCommandGuidance(nextAction)?.modelFreeCommand ?? null : null };
}

/** Render just the immediate, verified action. The structured projection retains later choices. */
export function phaseContinuationLines(continuation) {
  const boundaryLines = continuation?.contextBoundary ? ['Next in Copilot (if this chat worked on an earlier phase):',
    continuation.contextBoundary.instruction,
    `Copilot: ${continuation.contextBoundary.commandGuidance.copilotCommand}`,
    'Shell: not available for this conversation operation',
    'VS Code (model-free): not available for this conversation operation',
    'A fresh conversation continues with the following phase action:'] : [];
  const first = continuation?.nextAction;
  if (!first) return [...boundaryLines, 'Next action: no immediate action returned.'];
  const guidance = safeCommandGuidance(first);
  if (!guidance) return [...boundaryLines, 'Next action: inspect the returned diagnostics; no safe command pair was verified.'];
  return [...boundaryLines, 'Next action:', first.reason ?? 'Follow the current lifecycle; this inspection is not approval.',
    ...commandRouteLines(guidance)];
}
