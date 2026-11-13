/**
 * While an intent amendment proposed from a step waits for its scope approvers, that step pauses, so the
 * proposal stays bound to the step as it was proposed against; a person decides it, and acknowledges an
 * approved one, on the decisions card, which /sf-decide opens [owner, 2026-11-13]. A leaf the guard, the
 * engine and the planners read; the session projection loads none of it.
 */
import { intentAmendmentSource } from './phase-roles.mjs';

/**
 * The amendment waiting for a decision that was proposed from this step while it is still the current one,
 * or null. The step is read from the proposal's own history entry; an older proposal with none pauses nothing.
 */
export function intentAmendmentPause(workflow, phaseId = workflow?.currentPhase) {
  const pending = phaseId && phaseId === workflow?.currentPhase
    ? (workflow.intentAmendments ?? []).find((entry) => entry?.status === 'proposed') : null;
  return pending && (workflow.history ?? []).findLast((entry) => entry?.event === 'intent_amendment_proposed'
    && String(entry.detail ?? '').startsWith(`${pending.id} `))?.phase === phaseId ? pending : null;
}

/** Why that step waits, and the person's route: the decisions card, which also refreshes a stale proposal. */
export const intentAmendmentPauseReason = (workflow, pending) => `${pending.id} waits for the requirements approvers; this step pauses until it is decided. `
  + `Decide it on the decisions card: /sf-decide ${workflow.workItem.id} (a stale one is refreshed there)`;

/** The decisions card as an action: where a person decides an amendment and acknowledges an approved one. */
export const decisionsCardAction = (workflow, detail = null) => ({ command: `singularity-flow decisions ${workflow.workItem.id}`, skill: '/sf-decide', ...(detail ? { detail } : {}) });

/** A step may propose an amendment that can succeed: none waits for a decision or for an acknowledgement. */
export function intentAmendmentProposable(workflow, phaseId = workflow?.currentPhase) {
  return intentAmendmentSource(workflow, phaseId) && !(workflow.intentAmendments ?? []).some((entry) => entry?.status === 'proposed'
    || (entry?.status === 'approved' && entry.acknowledgementRequired !== false && !entry.acknowledgedAt));
}
