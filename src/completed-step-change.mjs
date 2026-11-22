/**
 * A change the person asks for in a code step that already finished (daily run, 2026-11-22).
 *
 * Since a ready version is submitted in the turn that wrote it (ceremony cut 2, owner 2026-11-19), a code step its workflow
 * asks no approval for completes in that turn, and the Story moves on to the next step. A person who then typed
 * `/sf-code <what to change>` had no route: /sf-code entered the next step (a verify step SFlow builds), which dropped their
 * words; `/sf-code implement <what to change>` said there was nothing to implement; and `phase rollover implement` refused
 * with "no changed consumed generation", naming the next step's approval. Three dead ends for one plain request.
 *
 * Now the change goes back to that code step, on the person's one yes: "Start version 2 of Implement for this change? The
 * Story goes back to Implement: …". SFlow returns the Story to the code step, as a return at approval would, with their words as the change request,
 * and starts its next version for them (completed-step-change-opening.mjs). The later steps' versions are set aside and run
 * again once the code step's new version completes.
 *
 * Only while nothing a person approved is undone by it: the code step completed without a person's approval, every step
 * after it up to the current one did too, the current step has no person's approval, and its workflow lets it return to
 * that code step (its `rejectTo`). Otherwise the change is the current step's approvers' to send back, as before.
 *
 * This module holds the rules only, pure, so every bundle that reads an entry or a prompt may take it.
 */
import { phaseCorrectionTargets } from './approval-fallback.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';

export const PERSON_CHANGE = 'person-change';

/** Whether a person approved `phase` (an approval that still stands, of any generation). Pure. */
const personApproved = (phase) => (phase?.approvals ?? []).some((entry) => !entry?.invalidatedAt && entry?.decision === 'approved');

/** A step finished without a person's approval: completed by its workflow (no approval asked) or approved by SFlow. Pure. */
const finishedWithoutPerson = (phase) => ['approved', 'skipped'].includes(phase?.status) && !personApproved(phase);

/**
 * The finished code step a change the person asks for goes back to, or null. `named` is the step they named (after /sf-code,
 * or to `phase rollover`); without it, the nearest finished code step before the current one. Pure.
 */
export function completedCodeStepForChange(workflow, { named = null } = {}) {
  if (workflow?.status !== 'in_progress' || workflow.resolution?.presence) return null;
  const order = workflow.phaseOrder ?? [];
  const current = workflow.phases?.[workflow.currentPhase];
  if (!current || phaseRequiresCodeDelivery(current) || !['in_progress', 'awaiting_approval', 'pending'].includes(current.status) || personApproved(current)) return null;
  const at = order.indexOf(current.id);
  if (at < 0) return null;
  const before = order.slice(0, at).reverse();
  const id = named ?? before.find((candidate) => phaseRequiresCodeDelivery(workflow.phases?.[candidate]) && workflow.phases[candidate].status !== 'skipped');
  const code = id ? workflow.phases?.[id] : null;
  if (!code || !before.includes(code.id) || !phaseRequiresCodeDelivery(code) || code.status !== 'approved' || personApproved(code)
      || !(Number(code.generation) >= 1)) return null;
  // Every step between them finished without a person's approval too: going back undoes nothing a person approved.
  const between = order.slice(order.indexOf(code.id) + 1, at).map((candidate) => workflow.phases?.[candidate]);
  if (!between.every(finishedWithoutPerson)) return null;
  return phaseCorrectionTargets(current).includes(code.id) ? code : null;
}

/** The step as a person reads it. */
export const stepName = (phase) => String(phase?.label ?? phase?.id ?? 'the step');

/**
 * The question the person answers, with the real numbers: the code step's next version, what stays as published and what
 * runs again. Pure.
 */
export function completedChangeQuestion(workflow, code, version) {
  const current = workflow.phases[workflow.currentPhase];
  const later = Number(current.generation) >= 1 ? `${stepName(current)} version ${current.generation} is set aside and runs again after it`
    : `${stepName(current)} runs after it`;
  return `Start version ${version} of ${stepName(code)} for this change? The Story goes back to ${stepName(code)}: version ${code.generation} and its tests stay as published, and ${later}.`;
}
