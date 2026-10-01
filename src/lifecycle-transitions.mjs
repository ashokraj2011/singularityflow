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

/**
 * Called only after the owner has established the source phase's completion.
 *
 * `outcome` is what the phase's decision chose (workflow-decisions.mjs), or null where no decision
 * follows it, which keeps the linear path. A loop is not applied here: going back is rework, and
 * the rework owner records it with its change request and invalidations.
 */
export function advanceCompletedPhase(workflow, phase, at, outcome = null) {
  if (outcome?.kind === 'loop') {
    throw new SingularityFlowError('A decision that goes back is applied as rework, not as an advance.',
      { code: 'LIFECYCLE_TRANSITION_INVALID' });
  }
  if (outcome?.kind === 'pause') {
    if (!outcome.pending) {
      throw new SingularityFlowError('A paused decision needs its pending record.', { code: 'LIFECYCLE_TRANSITION_INVALID' });
    }
    // The phase stays current and approved; nothing is active until a person chooses.
    workflow.pendingDecision = outcome.pending; workflow.currentPhase = phase.id; workflow.status = 'in_progress';
    return null;
  }
  // Absent unless a decision is waiting, so Stories that never use one keep their exact shape.
  delete workflow.pendingDecision;
  if (outcome?.kind === 'forward' || outcome?.kind === 'end') {
    skipPhaseRange(workflow, outcome.skipped ?? [], { at, decision: outcome.decision, route: outcome.route });
    const target = outcome.kind === 'forward' ? workflow.phases[outcome.target] : null;
    if (outcome.kind === 'forward' && (!target || workflow.phaseOrder.indexOf(target.id) <= phaseIndex(workflow, phase.id))) {
      throw new SingularityFlowError('A decision may only skip ahead to a later phase.', { code: 'LIFECYCLE_TRANSITION_INVALID' });
    }
    if (target) {
      target.status = 'in_progress'; target.startedAt = at; workflow.currentPhase = target.id;
    } else { workflow.currentPhase = null; workflow.status = 'complete'; }
    return target;
  }
  const upcoming = nextPhaseAfterSkillAmendment(workflow, phase);
  if (upcoming) {
    upcoming.status = 'in_progress'; upcoming.startedAt = at; workflow.currentPhase = upcoming.id;
  } else { workflow.currentPhase = null; workflow.status = 'complete'; }
  return upcoming;
}

/**
 * Mark phases a decision passed over. Only phases that have not started are skipped: a phase an
 * accepted skill amendment preserved as approved keeps its approval rather than being downgraded.
 */
export function skipPhaseRange(workflow, phaseIds, { at, decision, route }) {
  const skipped = [];
  for (const id of phaseIds) {
    const target = workflow.phases?.[id];
    if (!target || target.status !== 'not_started') continue;
    target.status = 'skipped'; target.skippedAt = at; target.skippedBy = { decision, route };
    skipped.push(id);
  }
  return skipped;
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
    clearDecisionState(affected);
    if (index === 0) { affected.rejectedAt = at; affected.rejectedBy = actor; affected.rejectionReason = reason; }
  }
  // Reopened phases run again, so their decisions are taken again; a question still waiting
  // after one of them no longer describes the Story.
  if (workflow.pendingDecision && affectedIds.includes(workflow.pendingDecision.after)) delete workflow.pendingDecision;
  workflow.currentPhase = targetId; workflow.status = 'in_progress';
  return affectedIds;
}

/** A phase that runs again records its decision values again and is no longer skipped. */
export function clearDecisionState(phase) {
  delete phase.skippedAt; delete phase.skippedBy; delete phase.decisionInputs;
}
