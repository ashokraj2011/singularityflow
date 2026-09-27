/** Pure aggregate transitions shared by the governed owner and structural simulation.
 * These helpers grant no permission, verify no evidence and perform no I/O. The runtime
 * owner must finish its existing publication/reviewer/receipt checks before calling them.
 */
import { SingularityFlowError } from './util.mjs';

function phaseIndex(workflow, phaseId) {
  const order = workflow.phaseOrder;
  const index = Array.isArray(order) ? order.indexOf(phaseId) : -1;
  if (index < 0 || new Set(order).size !== order.length
      || order.some((id) => !workflow.phases?.[id] || workflow.phases[id].id !== id)) {
    throw new SingularityFlowError('Lifecycle transition requires an existing selected phase.',
      { code: 'LIFECYCLE_TRANSITION_INVALID' });
  }
  return index;
}

export function nextPhaseAfterSkillAmendment(workflow, phase) {
  const start = phaseIndex(workflow, phase.id);
  const amendment = [...(workflow.skillVersionAmendments ?? [])].reverse().find((entry) =>
    entry.status === 'approved' && entry.affectedPhaseIds.includes(phase.id));
  for (let index = start + 1; index < workflow.phaseOrder.length; index += 1) {
    const candidate = workflow.phases[workflow.phaseOrder[index]];
    // Only an accepted amendment's verified independence proof preserves existing approval.
    if (amendment?.preservedPhaseIds.includes(candidate.id) && candidate.status === 'approved') continue;
    return candidate;
  }
  return null;
}

/** Called only after the owner has established the source phase's completion. */
export function advanceCompletedPhase(workflow, phase, at) {
  const upcoming = nextPhaseAfterSkillAmendment(workflow, phase);
  if (upcoming) {
    upcoming.status = 'in_progress'; upcoming.startedAt = at; workflow.currentPhase = upcoming.id;
  } else { workflow.currentPhase = null; workflow.status = 'complete'; }
  return upcoming;
}

/** The existing rejection owner resets the entire range, not just dependency descendants. */
export function reopenPhaseRange(workflow, { targetId, at, actor, reason }) {
  const targetIndex = phaseIndex(workflow, targetId);
  const affectedIds = workflow.phaseOrder.slice(targetIndex);
  if (affectedIds.some((id) => !Array.isArray(workflow.phases[id].approvals)
      || workflow.phases[id].approvals.some((approval) => !approval || typeof approval !== 'object'))) {
    throw new SingularityFlowError('Lifecycle rework requires an existing decision collection.',
      { code: 'LIFECYCLE_TRANSITION_INVALID' });
  }
  for (const [index, id] of affectedIds.entries()) {
    const affected = workflow.phases[id];
    affected.approvals.forEach((approval) => { if (!approval.invalidatedAt) approval.invalidatedAt = at; });
    affected.status = index === 0 ? 'in_progress' : 'not_started';
    affected.submittedAt = null; affected.approvedAt = null; affected.approvedBy = null;
    affected.submissionArchitectureDecision = null;
    if (index === 0) { affected.rejectedAt = at; affected.rejectedBy = actor; affected.rejectionReason = reason; }
  }
  workflow.currentPhase = targetId; workflow.status = 'in_progress';
  return affectedIds;
}
