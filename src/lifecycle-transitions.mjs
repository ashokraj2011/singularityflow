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
    // A phase whose approval rework retained by rule [E2G-021] is already complete.
    if (candidate.status === 'approved' && candidate.retention?.generation === candidate.generation) continue;
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
    } else { workflow.currentPhase = null; workflow.status = 'closed'; }
    return target;
  }
  const upcoming = nextPhaseAfterSkillAmendment(workflow, phase);
  if (upcoming) {
    upcoming.status = 'in_progress'; upcoming.startedAt = at; workflow.currentPhase = upcoming.id;
  } else { workflow.currentPhase = null; workflow.status = 'closed'; }
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

/**
 * Send one phase back for rework. Every path that reopens a phase (a rejection or a decision's
 * loop, reopening completed work, promoting a design source, detaching a document its work used)
 * applies exactly this: its decisions are invalidated, its review and approval are cleared, it
 * needs a new generation, and nothing recorded about its previous completion carries over. The
 * caller adds what only it records, such as who rejected the phase or which decision invalidated it.
 *
 * `retainable` marks an approved phase whose approval may be retained when the Story reaches it
 * again and nothing it decided over changed (src/phase-retention.mjs).
 */
export function resetPhaseForRework(phase, { at, status, invalidation = {}, retainable = false }) {
  const approved = phase.status === 'approved';
  for (const approval of phase.approvals ?? []) {
    if (!approval.invalidatedAt) Object.assign(approval, { invalidatedAt: at, ...invalidation });
  }
  phase.status = status;
  phase.submittedAt = null; phase.approvedAt = null; phase.approvedBy = null;
  phase.submissionArchitectureDecision = null;
  phase.reworkRevalidation = { generation: phase.generation, invalidatedAt: at, ...(retainable && approved ? { retainable: true } : {}) };
  delete phase.retention;
  clearDecisionState(phase);
  clearApprovalDisposition(phase);
}

/**
 * Reset the target and every phase after it for rework, and make the target current. The whole
 * range is reset, not just dependency descendants: what a later phase depends on is known only once
 * the phases before it complete again. With `retain`, approved phases after the target may keep
 * their approval then, when nothing they decided over changed. Nothing changes when any phase in
 * the range is malformed.
 */
export function resetPhaseRangeForRework(workflow, { targetId, at, invalidation = {}, retain = false }) {
  const targetIndex = phaseIndex(workflow, targetId);
  const affectedIds = workflow.phaseOrder.slice(targetIndex);
  if (affectedIds.some((id) => !Array.isArray(workflow.phases[id].approvals)
      || workflow.phases[id].approvals.some((approval) => !approval || typeof approval !== 'object'))) {
    throw new SingularityFlowError('Lifecycle rework requires an existing decision collection.',
      { code: 'LIFECYCLE_TRANSITION_INVALID' });
  }
  for (const [index, id] of affectedIds.entries()) {
    resetPhaseForRework(workflow.phases[id], { at, status: index === 0 ? 'in_progress' : 'not_started', invalidation, retainable: retain && index > 0 });
  }
  // Reopened phases run again, so their decisions are taken again; a question still waiting
  // after one of them no longer describes the Story.
  if (workflow.pendingDecision && affectedIds.includes(workflow.pendingDecision.after)) delete workflow.pendingDecision;
  // A reopened Story finishes again, and its final evaluation is made again over the new evidence.
  delete workflow.completion;
  workflow.currentPhase = targetId; workflow.status = 'in_progress';
  return affectedIds;
}

/**
 * A rejection, a reopen or a decision's loop: the range is reset and the target records who sent it
 * back and why. A loop passes no `retain`: each round gets its own evidence [E2G-023].
 */
export function reopenPhaseRange(workflow, { targetId, at, actor, reason, retain = false }) {
  const affectedIds = resetPhaseRangeForRework(workflow, { targetId, at, retain });
  const target = workflow.phases[targetId];
  target.rejectedAt = at; target.rejectedBy = actor; target.rejectionReason = reason;
  return affectedIds;
}

/** A phase that runs again records its decision values again and is no longer skipped. */
export function clearDecisionState(phase) {
  delete phase.skippedAt; delete phase.skippedBy; delete phase.decisionInputs;
}

/**
 * Only an automatic completion records a disposition ('policy_waived' or 'not_required') and a
 * policy waiver. Once the phase is sent back, submitted for people to review, or approved by one,
 * the record describes an earlier completion. Kept, the governance gate would replay an earlier
 * round's waiver against the current generation.
 */
export function clearApprovalDisposition(phase) {
  delete phase.approvalDisposition; delete phase.approvalWaiver;
}

/**
 * The automatic disposition of the phase's current completion, or null. Older builds never cleared
 * the record, so a phase reopened, or approved by people, after an automatic completion may still
 * carry one that no longer describes it; a current human approval wins.
 */
export function automaticApprovalDisposition(phase) {
  if (phase?.status !== 'approved') return null;
  if ((phase.approvals ?? []).some((item) => !item.invalidatedAt && item.decision === 'approved')) return null;
  return phase.approvalDisposition ?? null;
}

/**
 * The phase that completed a Story: its last phase, unless a decision finished the Story early or
 * skipped its tail, in which case the last phase that actually ran.
 */
export function completionPhaseOf(workflow) {
  const id = [...(workflow.phaseOrder ?? [])].reverse().find((phaseId) => workflow.phases?.[phaseId]?.status !== 'skipped')
    ?? workflow.phaseOrder?.at(-1);
  return id ? workflow.phases?.[id] ?? null : null;
}
