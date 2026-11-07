import { phaseHandoffPlan, workflowGuidePlan } from './kernel/phase-policy.mjs';
import { continuationActionPresentation } from './phase-transition-routes.mjs';
import { copilotAction } from './copilot-guidance.mjs';
import { safeCommandGuidance, commandRouteLines } from './safe-command-guidance.mjs';
import { phaseAuthoringProgress } from './phase-authoring-progress.mjs';
export { phaseNeedsGeneration } from './kernel/phase-policy.mjs';

/** The host renders semantic actions; source-review/hold/transition priority stays in the kernel. */
export function phaseHandoff(workflow, phase, options = {}) {
  return phaseHandoffPlan(workflow, phase, options).actions
    .map(action => copilotAction(continuationActionPresentation(action, { workflow, phase })));
}

/** Project the exact SDK plan without re-running routing or admitting any mutation. */
export function workflowGuidePresentation(workflow, plan, { authoringProgress = null } = {}) {
  const active = workflow.currentPhase ? workflow.phases?.[workflow.currentPhase] ?? null : null;
  let capturedProgress = authoringProgress;
  return {
    workId: workflow.workItem.id,
    template: { id: workflow.workItem.workType, label: workflow.workItem.workTypeLabel },
    source: workflow.workItem.source ?? { type: 'unknown', key: null, url: null },
    status: workflow.status, currentPhase: active?.id ?? null,
    phases: workflow.phaseOrder.map((id, index) => {
      const phase = workflow.phases[id];
      return { number: index + 1, id, label: phase.label, status: phase.status,
        artifact: phase.requiredArtifact?.path ?? null, agent: phase.defaultAgent ?? null,
        approvalAuthorities: phase.approvalPolicy?.authorities ?? [], approvalsRequired: phase.approvalPolicy?.minimum ?? 0 };
    }),
    nextActions: plan.actions.map(action => {
      if (action.kind === 'resume-phase-authoring') capturedProgress ??= phaseAuthoringProgress(workflow, active);
      return copilotAction(continuationActionPresentation(action, { workflow, phase: active, authoringProgress: capturedProgress }));
    })
  };
}

export function workflowGuide(workflow, { sourceReviewEvidence = null, authoringProgress = null } = {}) {
  const authoringState = authoringProgress == null ? null : { available: Boolean(authoringProgress.next),
    stage: authoringProgress.stage ?? null, generation: authoringProgress.generation ?? null };
  const plan = workflowGuidePlan(workflow, { sourceReviewEvidence, authoringState });
  return workflowGuidePresentation(workflow, plan, { authoringProgress });
}

export function guideText(guide) {
  const lines = [
    `${guide.workId} — ${guide.template.label} (${guide.template.id})`,
    `Source: ${guide.source.type}${guide.source.key ? ` / ${guide.source.key}` : ''}`,
    `Status: ${guide.status}`,
    `Current phase: ${guide.currentPhase ?? (guide.status === 'cancelled' ? 'cancelled and archived' : 'none — every step is decided')}`,
    '',
    'Workflow template:',
    ...guide.phases.map((phase) => `${phase.number}. ${phase.label} (${phase.id}) — ${phase.status}\n   Artifact: ${phase.artifact}\n   Agent: ${phase.agent ?? 'unavailable'}; approval authority: ${phase.approvalAuthorities.join(', ') || 'none'} (${phase.approvalsRequired} required)`),
    '',
    'What to do next:',
    ...guide.nextActions.flatMap((action) => [action.reason, '', ...commandRouteLines(safeCommandGuidance(action) ?? safeCommandGuidance(action.command) ?? {}), ''])
  ];
  return `${lines.join('\n')}\n`;
}
