import { SingularityFlowError } from './util.mjs';

export const CONTEXT_BOUNDARY_MODES = new Set(['keep', 'compact', 'new']);

function mode(value, label, fallback) {
  const selected = value ?? fallback;
  if (!CONTEXT_BOUNDARY_MODES.has(selected)) {
    throw new SingularityFlowError(`${label} must be keep, compact, or new.`);
  }
  return selected;
}

export function normalizeContextPolicy(value = {}, { phaseIds = null, label = 'contextPolicy' } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`${label} must be an object.`);
  }
  const allowed = new Set(['phaseBoundary', 'onApproval', 'onRejection', 'phaseOverrides']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new SingularityFlowError(`${label} contains unknown field '${key}'.`);
  }
  if (value.phaseBoundary != null && value.onApproval != null && value.phaseBoundary !== value.onApproval) {
    throw new SingularityFlowError(`${label}.phaseBoundary and ${label}.onApproval must match when both are configured.`);
  }
  const onApproval = mode(value.onApproval ?? value.phaseBoundary, `${label}.onApproval`, 'keep');
  const onRejection = mode(value.onRejection, `${label}.onRejection`, 'keep');
  const overrides = value.phaseOverrides ?? {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new SingularityFlowError(`${label}.phaseOverrides must be an object.`);
  }
  const known = phaseIds ? new Set(phaseIds) : null;
  const phaseOverrides = {};
  for (const [phaseId, selected] of Object.entries(overrides)) {
    if (known && !known.has(phaseId)) {
      throw new SingularityFlowError(`${label}.phaseOverrides references unknown phase '${phaseId}'.`);
    }
    phaseOverrides[phaseId] = mode(selected, `${label}.phaseOverrides.${phaseId}`);
  }
  return { onApproval, onRejection, phaseOverrides };
}

export function contextBoundaryMode(policy, phaseId, event = 'approval') {
  const normalized = normalizeContextPolicy(policy);
  if (event === 'rejection') return normalized.onRejection;
  return normalized.phaseOverrides[phaseId] ?? normalized.onApproval;
}

export function contextBoundaryHandoff(policy, phaseId, {
  event = 'approval',
  nextPhase = null,
  nextSkill = '/sflow-next',
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
      ? 'The approved phase is committed and pushed; start a clean Copilot conversation and rebuild the next phase from governed Git context.'
      : selected === 'compact'
        ? 'Compact this Copilot conversation before loading the next governed phase.'
        : 'Continue in the current Copilot conversation.'
  };
}

export function formatContextBoundaryHandoff(handoff) {
  if (!handoff) return [];
  const lines = [`Context boundary: ${handoff.mode}. ${handoff.reason}`];
  if (handoff.commands.length) {
    lines.push('Next Copilot actions:');
    handoff.commands.forEach((command, index) => lines.push(`  ${index + 1}. ${command}`));
  }
  return lines;
}
