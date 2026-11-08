export { normalizeReworkLoops, normalizeRepairBudget } from './kernel/configuration-policy.mjs';
import { SingularityFlowError } from './util.mjs';

/**
 * The reachable way past an exhausted budget: a return to the phase whose new approved generation
 * resets it, when the submitted phase may return there. Otherwise only people can decide. An
 * upstream issue's return usually comes from a step still in progress, and `reject` refuses a step
 * that is not submitted, so the route was named where it could not run (2026-10-28).
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
    const route = budgetResetRoute(workflow, policy, sourcePhase, targetPhase);
    const submitted = sourcePhase?.status === 'awaiting_approval';
    const resetCommand = submitted ? route : null;
    throw new SingularityFlowError(
      `Phase '${phase.id}' repair budget is exhausted (${state.attempts.length}/${policy.maxAttempts}). `
      + (resetCommand
        ? `Return the submission to '${policy.resetOnPhase}' instead, which resets the budget once it has a new approved generation: ${resetCommand}. Otherwise ask the approvers for direction.`
        : route ? `Once '${sourcePhase.id}' is submitted, its approvers may return it to '${policy.resetOnPhase}', which resets the budget once it has a new approved generation; a return is refused before then. Otherwise ask the approvers for direction.`
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
