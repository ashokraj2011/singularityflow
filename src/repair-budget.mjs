import { SingularityFlowError } from './util.mjs';

const PHASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A declared loop is a bounded, reviewer-directed backward rejection edge. */
export function normalizeReworkLoops(value = [], { workTypeId = 'work type', phases = [] } = {}) {
  if (!Array.isArray(value)) {
    throw new SingularityFlowError(`Work type '${workTypeId}' reworkLoops must be an array.`);
  }
  const seen = new Set();
  const targetPolicies = new Map();
  return value.map((entry, index) => {
    const label = `Work type '${workTypeId}' reworkLoops[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SingularityFlowError(`${label} must be an object.`);
    }
    for (const key of Object.keys(entry)) {
      if (!['from', 'to', 'maxAttempts', 'resetOnPhase'].includes(key)) {
        throw new SingularityFlowError(`${label} contains unknown field '${key}'.`);
      }
    }
    if (!PHASE_ID.test(entry.from ?? '') || !PHASE_ID.test(entry.to ?? '')
        || !phases.includes(entry.from) || !phases.includes(entry.to)) {
      throw new SingularityFlowError(`${label} must name two active phases in this Story workflow.`);
    }
    if (phases.indexOf(entry.to) >= phases.indexOf(entry.from)) {
      throw new SingularityFlowError(`${label} must return from a later phase to an earlier phase.`);
    }
    if (!Number.isInteger(entry.maxAttempts) || entry.maxAttempts < 1 || entry.maxAttempts > 100) {
      throw new SingularityFlowError(`${label}.maxAttempts must be an integer from 1 through 100.`);
    }
    const resetOnPhase = entry.resetOnPhase ?? null;
    if (resetOnPhase != null && (!PHASE_ID.test(resetOnPhase)
        || !phases.includes(resetOnPhase) || phases.indexOf(resetOnPhase) >= phases.indexOf(entry.to))) {
      throw new SingularityFlowError(`${label}.resetOnPhase must name an active phase before '${entry.to}'.`);
    }
    const edge = `${entry.from}\0${entry.to}`;
    if (seen.has(edge)) throw new SingularityFlowError(`${label} repeats the same backward edge.`);
    seen.add(edge);
    const policy = `${entry.maxAttempts}\0${resetOnPhase ?? ''}`;
    if (targetPolicies.has(entry.to) && targetPolicies.get(entry.to) !== policy) {
      throw new SingularityFlowError(`${label} conflicts with another loop targeting '${entry.to}': repair budgets must agree.`);
    }
    targetPolicies.set(entry.to, policy);
    return {
      from: entry.from, to: entry.to, maxAttempts: entry.maxAttempts,
      ...(resetOnPhase != null ? { resetOnPhase } : {})
    };
  });
}

export function normalizeRepairBudget(value = null, { phaseId = 'phase', phases = [] } = {}) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`Phase '${phaseId}' repairBudget must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!['maxAttempts', 'resetOnPhase'].includes(key)) {
      throw new SingularityFlowError(`Phase '${phaseId}' repairBudget contains unknown field '${key}'.`);
    }
  }
  if (!Number.isInteger(value.maxAttempts) || value.maxAttempts < 1 || value.maxAttempts > 100) {
    throw new SingularityFlowError(`Phase '${phaseId}' repairBudget.maxAttempts must be an integer from 1 through 100.`);
  }
  const resetOnPhase = value.resetOnPhase ?? null;
  if (resetOnPhase != null && !phases.includes(resetOnPhase)) {
    throw new SingularityFlowError(`Phase '${phaseId}' repairBudget.resetOnPhase references unknown phase '${resetOnPhase}'.`);
  }
  return { maxAttempts: value.maxAttempts, resetOnPhase };
}

/**
 * The reachable way past an exhausted budget: a return to the phase whose new approved generation
 * resets it, when the submitted phase may return there. Otherwise only people can decide.
 */
function budgetResetRoute(workflow, policy, sourcePhase, targetPhase) {
  const reset = policy.resetOnPhase;
  if (!reset || !sourcePhase || reset === targetPhase) return null;
  const allowed = sourcePhase.approvalPolicy?.rejectTo ?? [sourcePhase.id];
  const order = workflow.phaseOrder ?? [];
  if (!allowed.includes(reset) || order.indexOf(reset) < 0 || order.indexOf(reset) > order.indexOf(sourcePhase.id)) return null;
  return `singularity-flow reject ${sourcePhase.id} --work-id ${workflow.workItem?.id} --to ${reset} --reason <reason>`;
}

export function consumeRepairAttempt(workflow, phase, { targetPhase, actor, at, changeRequestId, sourcePhase = null }) {
  const policy = phase.repairBudget;
  if (!policy) return null;
  const resetPhase = policy.resetOnPhase ? workflow.phases?.[policy.resetOnPhase] : null;
  const resetGeneration = resetPhase?.generation ?? 0;
  workflow.repairBudgets ??= {};
  let state = workflow.repairBudgets[phase.id];
  if (!state || state.resetPhase !== policy.resetOnPhase || state.resetGeneration !== resetGeneration) {
    state = {
      schemaVersion: 1,
      phase: phase.id,
      maximum: policy.maxAttempts,
      resetPhase: policy.resetOnPhase,
      resetGeneration,
      attempts: []
    };
  }
  if (policy.resetOnPhase && targetPhase === policy.resetOnPhase) {
    workflow.repairBudgets[phase.id] = state;
    return { ...structuredClone(state), resetRequested: true };
  }
  if (state.attempts.length >= policy.maxAttempts) {
    const resetCommand = budgetResetRoute(workflow, policy, sourcePhase, targetPhase);
    throw new SingularityFlowError(
      `Phase '${phase.id}' repair budget is exhausted (${state.attempts.length}/${policy.maxAttempts}). `
      + (resetCommand
        ? `Return the submission to '${policy.resetOnPhase}' instead, which resets the budget once it has a new approved generation: ${resetCommand}. Otherwise ask the approvers for direction.`
        : 'No allowed return resets it from here; ask the approvers for direction (approve the submission as it stands, or have a workflow maintainer change the budget for new Stories).'),
      { code: 'REPAIR_BUDGET_EXHAUSTED', details: {
        phase: phase.id, currentPhase: sourcePhase?.id ?? null, upstreamPhase: phase.id === sourcePhase?.id ? null : phase.id,
        maximum: policy.maxAttempts, consumed: state.attempts.length,
        resetPhase: policy.resetOnPhase ?? null, resetCommand
      } }
    );
  }
  state.attempts.push({ number: state.attempts.length + 1, targetPhase, actor, at, changeRequestId });
  workflow.repairBudgets[phase.id] = state;
  return structuredClone(state);
}

export function repairBudgetPhaseForRejection(workflow, sourcePhase, targetPhaseId) {
  const sourceIndex = workflow.phaseOrder?.indexOf(sourcePhase.id) ?? -1;
  const targetIndex = workflow.phaseOrder?.indexOf(targetPhaseId) ?? -1;
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex > sourceIndex) return null;
  const declared = (workflow.resolution?.reworkLoops ?? []).find((loop) =>
    loop.from === sourcePhase.id && loop.to === targetPhaseId);
  if (declared) {
    const target = workflow.phases?.[targetPhaseId];
    if (!target?.repairBudget || target.repairBudget.maxAttempts !== declared.maxAttempts
        || target.repairBudget.resetOnPhase !== (declared.resetOnPhase ?? null)) {
      throw new SingularityFlowError(
        `Declared rework loop '${sourcePhase.id}' to '${targetPhaseId}' differs from its pinned repair budget.`,
        { code: 'REWORK_LOOP_POLICY_MISMATCH' }
      );
    }
    return target;
  }
  const candidates = workflow.phaseOrder
    .slice(targetIndex, sourceIndex + 1)
    .map((id) => workflow.phases?.[id])
    .filter((phase) => phase?.repairBudget)
    .filter((phase) => phase.id !== sourcePhase.id || sourcePhase.validationVerdict === 'failed');
  return candidates.at(-1) ?? null;
}
