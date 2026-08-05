import { currentPhase } from './state.mjs';
import { phaseNeedsGeneration } from './sequence.mjs';

export { phaseNeedsGeneration } from './sequence.mjs';

function nextActions(workflow, phase) {
  if (workflow.status === 'cancelled') return [
    { skill: '/sflow-documents', command: `singularity-flow documents list ${workflow.workItem.id}`, reason: 'Review the artifacts preserved with this archived Story.' }
  ];
  if (!phase) return [
    { skill: '/sflow-progress', command: `singularity-flow progress ${workflow.workItem.id}`, reason: 'Review the completed workflow and final conformance.' }
  ];
  if (phase.status === 'awaiting_approval') return [
    { skill: '/sflow-approve', command: `singularity-flow approve ${phase.id} --work-id ${workflow.workItem.id} --fetch`, reason: `Approve ${phase.id} using an authorized human Git identity; the phase-default agent is recorded automatically.` },
    { skill: '/sflow-reject', command: `singularity-flow reject ${phase.id} --work-id ${workflow.workItem.id} --fetch --to <phase> --reason <reason>`, reason: `Return ${phase.id} for correction.` }
  ];
  const regenerate = phaseNeedsGeneration(workflow, phase);
  if (regenerate) return [
    { skill: '/sflow-phase', command: `singularity-flow prepare ${phase.id}`, reason: `${phase.generation > 0 ? 'Regenerate' : 'Generate'} the required ${phase.label} artifact, then publish it.` }
  ];
  return [
    { skill: '/sflow-submit', command: `singularity-flow submit ${phase.id}`, reason: `Run configured checks and submit ${phase.id} for approval.` }
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
        agent: phase.defaultAgent ?? null,
        approvalAuthorities: phase.approvalPolicy?.authorities ?? [],
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
    `Current phase: ${guide.currentPhase ?? (guide.status === 'cancelled' ? 'cancelled and archived' : 'complete')}`,
    '',
    'Workflow template:',
    ...guide.phases.map((phase) => `${phase.number}. ${phase.label} (${phase.id}) — ${phase.status}\n   Artifact: ${phase.artifact}\n   Governed agent: ${phase.agent ?? 'unavailable'}; approval authority: ${phase.approvalAuthorities.join(', ') || 'none'} (${phase.approvalsRequired} required)`),
    '',
    'What to do next:',
    ...guide.nextActions.map((action) => `- ${action.skill}: ${action.reason}\n  CLI: ${action.command}`)
  ];
  return `${lines.join('\n')}\n`;
}
