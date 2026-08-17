import { SingularityFlowError } from './util.mjs';

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

export function consumeRepairAttempt(workflow, phase, { targetPhase, actor, at, changeRequestId }) {
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
    throw new SingularityFlowError(
      `Phase '${phase.id}' repair budget is exhausted (${state.attempts.length}/${policy.maxAttempts}). Start a new approved '${policy.resetOnPhase ?? phase.id}' generation or request human direction.`,
      { code: 'REPAIR_BUDGET_EXHAUSTED', details: { phase: phase.id, maximum: policy.maxAttempts, consumed: state.attempts.length } }
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
  const candidates = workflow.phaseOrder
    .slice(targetIndex, sourceIndex + 1)
    .map((id) => workflow.phases?.[id])
    .filter((phase) => phase?.repairBudget)
    .filter((phase) => phase.id !== sourcePhase.id || sourcePhase.validationVerdict === 'failed');
  return candidates.at(-1) ?? null;
}
