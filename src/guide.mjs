import { currentPhase } from './state.mjs';

function nextActions(workflow, phase) {
  if (!phase) return [
    { skill: '/sflow-progress', command: `singularity-flow progress ${workflow.workItem.id}`, reason: 'Review the completed workflow and final conformance.' }
  ];
  if (phase.status === 'awaiting_approval') return [
    { skill: '/sflow-approve', command: `singularity-flow approve ${workflow.workItem.id} --fetch`, reason: `Approve ${phase.id} using an approval-capable persona.` },
    { skill: '/sflow-reject', command: `singularity-flow reject ${workflow.workItem.id} --fetch --to <phase> --reason <reason>`, reason: `Return ${phase.id} for correction.` }
  ];
  const latestPhaseEvent = workflow.history.filter((item) => item.phase === phase.id).at(-1);
  const rejected = latestPhaseEvent?.event === 'phase_rejected';
  if (phase.generation < 1 || rejected) return [
    { skill: '/sflow-phase', command: `singularity-flow prepare ${phase.id}`, reason: `${rejected ? 'Regenerate' : 'Generate'} the required ${phase.label} artifact, then publish it.` }
  ];
  return [
    { skill: '/sflow-submit', command: `singularity-flow submit --phase ${phase.id}`, reason: `Run configured checks and submit ${phase.id} for approval.` }
  ];
}

export function workflowGuide(workflow) {
  const active = currentPhase(workflow);
  return {
    workId: workflow.workItem.id,
    template: { id: workflow.workItem.workType, label: workflow.workItem.workTypeLabel },
    source: workflow.workItem.source ?? { type: 'unknown', key: null, url: null },
    status: workflow.status,
    currentPhase: active?.id ?? null,
    phases: workflow.phaseOrder.map((id, index) => {
      const phase = workflow.phases[id];
      return {
        number: index + 1,
        id,
        label: phase.label,
        status: phase.status,
        artifact: phase.requiredArtifact?.path ?? null,
        suggestedPersonas: phase.suggestedPersonas ?? [],
        approvalPersonas: phase.approvalPolicy?.personas ?? [],
        approvalsRequired: phase.approvalPolicy?.minimum ?? 0
      };
    }),
    nextActions: nextActions(workflow, active)
  };
}

export function guideText(guide) {
  const lines = [
    `${guide.workId} — ${guide.template.label} (${guide.template.id})`,
    `Source: ${guide.source.type}${guide.source.key ? ` / ${guide.source.key}` : ''}`,
    `Status: ${guide.status}`,
    `Current phase: ${guide.currentPhase ?? 'complete'}`,
    '',
    'Workflow template:',
    ...guide.phases.map((phase) => `${phase.number}. ${phase.label} (${phase.id}) — ${phase.status}\n   Artifact: ${phase.artifact}\n   Suggested: ${phase.suggestedPersonas.join(', ') || 'any'}; approval: ${phase.approvalPersonas.join(', ') || 'none'} (${phase.approvalsRequired} required)`),
    '',
    'What to do next:',
    ...guide.nextActions.map((action) => `- ${action.skill}: ${action.reason}\n  CLI: ${action.command}`)
  ];
  return `${lines.join('\n')}\n`;
}
