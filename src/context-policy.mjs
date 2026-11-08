import { normalizeContextPolicy } from './kernel/configuration-policy.mjs';
export { CONTEXT_BOUNDARY_MODES, normalizeContextPolicy } from './kernel/configuration-policy.mjs';
import { formatCommandRouteLines } from './model-free-commands.mjs';
import { nextPhaseGeneration } from './kernel/phase-policy.mjs';

export function contextBoundaryMode(policy, phaseId, event = 'approval') {
  const normalized = normalizeContextPolicy(policy);
  if (event === 'rejection') return normalized.onRejection;
  return normalized.phaseOverrides[phaseId] ?? normalized.onApproval;
}

export function contextBoundaryHandoff(policy, phaseId, {
  event = 'approval',
  nextPhase = null,
  nextSkill = '/sf-next',
  complete = false
} = {}) {
  const selected = contextBoundaryMode(policy, phaseId, event);
  const commands = selected === 'new'
    ? ['/clear', ...(complete ? [] : [nextSkill])]
    : selected === 'compact'
      ? ['/compact', ...(complete ? [] : [nextSkill])]
      : complete ? [] : [nextSkill];
  return {
    mode: selected,
    event,
    phase: phaseId,
    nextPhase,
    complete,
    commands,
    reason: selected === 'new'
      ? 'The approved phase is committed and pushed; start a clean Copilot conversation and rebuild the next phase from Git context.'
      : selected === 'compact'
        ? 'Compact this Copilot conversation before loading the next phase.'
        : 'Continue in the current Copilot conversation.'
  };
}

export function formatContextBoundaryHandoff(handoff) {
  if (!handoff) return [];
  const lines = [`Context boundary: ${handoff.mode}. ${handoff.reason}`];
  if (handoff.commands.length) {
    lines.push('Next Copilot actions:');
    handoff.commands.forEach(command => lines.push(...formatCommandRouteLines({ copilotCommand: command }), ''));
  }
  return lines;
}

/** Chat operations are display-only prerequisites, never executable Shell or model-free actions. */
export function contextBoundaryPresentation(handoff) {
  if (!handoff || handoff.mode === 'keep') return null;
  return { ...handoff, condition: 'conversation-worked-on-earlier-phase',
    instruction: handoff.instruction ?? (handoff.complete
      ? `The Story is closed. End this approval turn; ${handoff.commands.join(', then ')} is a chat cleanup action, not another phase.`
      : `End this approval turn. Run ${handoff.commands.join(', then ')} before next-phase authoring.`),
    commandGuidance: { copilotCommand: handoff.commands.join(', then '), command: null,
      modelFreeCommand: null, copyable: false,
      shellReason: 'Conversation reset is a Copilot chat operation, not a Shell or Story mutation.' } };
}

/**
 * The context boundary a conversation owes before it starts the current phase.
 *
 * An approval made in the conversation returns its boundary (`/clear`, then `/sf-next`). One made
 * elsewhere (the CLI, the VS Code approvals view, another person) never reaches the conversation that
 * will author the next phase, which then carries every earlier phase into each model call: in one live
 * Copilot run the last phase started each call with 154K tokens of earlier work. Until the current
 * phase is prepared, agent entries repeat the boundary of the approval that opened it.
 */
export function pendingContextBoundary(workflow) {
  const phaseId = workflow?.currentPhase;
  const phase = phaseId ? workflow.phases?.[phaseId] : null;
  if (!phase || phase.status !== 'in_progress') return null;
  // Preparation records the authoring baseline, or the rendered inputs, of the generation it opens.
  const generation = nextPhaseGeneration(phase);
  if ((phase.artifacts ?? []).length || phase.authoringBaseline?.generation === generation
      || phase.inputContext?.generation === generation) return null;
  const order = workflow.phaseOrder ?? [];
  const previous = order[order.indexOf(phaseId) - 1];
  if (!previous || workflow.phases?.[previous]?.status !== 'approved') return null;
  const handoff = contextBoundaryHandoff(workflow.resolution?.contextPolicy ?? {}, previous, { nextPhase: phaseId });
  if (handoff.mode === 'keep') return null;
  return { ...handoff, instruction: `If this conversation already worked on an earlier phase of this Story, ask the user to run ${handoff.commands.join(', then ')} and stop. A conversation that starts here continues.` };
}
