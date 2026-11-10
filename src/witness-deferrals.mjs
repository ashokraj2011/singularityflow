/**
 * A person's decision that a later step gives a criterion's inspection or visual sign-off [PHR:REQ-007],
 * owner decision 2 (2026-11-10).
 *
 * The step that delivers a criterion answers for its sign-off at its own approval (finding 12). One of its
 * approvers may instead name a later step, in their own terminal, with a reason. The deferral is allowed
 * only to a step that can itself perform the sign-off and repair what it finds there: a later step that
 * delivers code (it can change the file the sign-off reads), or, for a visual slot, the visual verification
 * step (it captures the screens). That step then holds the sign-off as its own check, and its approvers
 * may give it. Recorded like a dated risk: append-only on the Story, a later decision on the same slot
 * replacing an earlier one. Pure: no I/O.
 */
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { isVisualVerificationPhase, ownerStepChecks, visualVerificationPhaseOf } from './phase-roles.mjs';
import { countedRecords } from './presence/counted.mjs';
import { SingularityFlowError } from './util.mjs';

const refused = (message, details = undefined) => {
  throw new SingularityFlowError(message, { code: 'WITNESS_DEFERRAL_INVALID', ...(details ? { details } : {}) });
};

/** The deferral in force for one criterion's slot, or null. */
export function activeWitnessDeferral(workflow, clauseId, slot) {
  const id = String(clauseId ?? '').toUpperCase();
  return [...countedRecords(workflow, workflow?.witnessDeferrals)].reverse()
    .find((entry) => entry.clauseId === id && entry.slot === slot && !entry.withdrawnAt) ?? null;
}

/**
 * The later step that gives a sign-off besides the steps that deliver its criterion, or null: the one a person
 * deferred it to, or, for a visual sign-off on a Story that pinned the owner-step checks, the visual verification
 * step, which captures the screens and holds it at its approval [PHR:REQ-007].
 */
export function signOffStep(workflow, clauseId, slot, method) {
  const deferral = activeWitnessDeferral(workflow, clauseId, slot);
  if (deferral) return deferral.to;
  return method === 'visual' && ownerStepChecks(workflow) ? visualVerificationPhaseOf(workflow, null)?.id ?? null : null;
}

/** The steps a deferral of this Story names: each holds the sign-offs deferred to it. */
export function witnessDeferralTargets(workflow) {
  return new Set(countedRecords(workflow, workflow?.witnessDeferrals).filter((entry) => !entry.withdrawnAt).map((entry) => entry.to));
}

/** Why `toStep` cannot take a sign-off deferred from `fromStep`, or null when it can perform and repair it. */
export function witnessDeferralBar(workflow, { from, to, method }) {
  const order = workflow?.phaseOrder ?? [];
  const target = workflow?.phases?.[to];
  if (!target || !order.includes(to)) return `${to} is not a step of this Story`;
  if (order.indexOf(to) <= order.indexOf(from)) return `${to} does not come after ${from}`;
  if (target.status === 'skipped') return `${to} is skipped on this route`;
  if (target.status === 'approved') return `${to} is already approved`;
  if (!(target.approvalPolicy?.authorities ?? []).length) return `${to} has no approvers to give the sign-off`;
  if (phaseRequiresCodeDelivery(target)) return null;
  if (method === 'visual' && isVisualVerificationPhase(target)) return null;
  return `${to} can neither change the file the sign-off reads nor capture the screens it shows, so it could not repair what it finds`;
}

/** The later steps this sign-off may be deferred to. */
export function witnessDeferralCandidates(workflow, { from, method }) {
  return (workflow?.phaseOrder ?? []).filter((id) => id !== from && !witnessDeferralBar(workflow, { from, to: id, method }));
}

/** Record a deferral on the aggregate; the caller checked the person's authority over `from`. */
export function recordWitnessDeferral(workflow, { clauseId, slot, method, from, to, reason, actor, authorityGroup, identityAssurance = null, at }) {
  const workId = workflow?.workItem?.id;
  const defer = (step) => `singularity-flow decision witness-defer ${workId} --criterion ${clauseId} --slot ${slot} --to ${step} --reason <why>`;
  // Where a refused deferral leaves the sign-off: given at its step, from the decision list [PHR:REQ-006].
  const giveHere = { command: `singularity-flow decisions ${workId}`, skill: '/sf-decide', label: `Give the sign-off at ${from}, from the decision list.` };
  if (!['inspection', 'visual'].includes(method)) refused(`${clauseId}'s slot ${slot} is proven by ${method}, not by an inspection or a visual sign-off.`, { nextAction: giveHere });
  const bar = witnessDeferralBar(workflow, { from, to, method });
  if (bar) {
    const candidates = witnessDeferralCandidates(workflow, { from, method });
    refused(`The sign-off of ${clauseId}'s slot ${slot} cannot be deferred to ${to}: ${bar}.`, {
      clauseId, slot, from, to, candidates,
      nextAction: candidates.length ? { command: defer(candidates[0]), label: `Defer it to ${candidates[0]}, which can perform and repair it.` } : giveHere,
      ...(candidates.length ? { recoveryCommands: [giveHere] } : {}) });
  }
  const text = String(reason ?? '').trim();
  if (text.length < 20 || text.length > 1000) refused('Say why in 20 to 1000 characters with --reason.', { nextAction: { command: defer(to), label: 'Say why in 20 to 1000 characters.' } });
  workflow.witnessDeferrals ??= [];
  const id = String(clauseId).toUpperCase();
  for (const entry of workflow.witnessDeferrals) if (entry.clauseId === id && entry.slot === slot && !entry.withdrawnAt) entry.withdrawnAt = at;
  const record = { id: `WDF-${String(workflow.witnessDeferrals.length + 1).padStart(3, '0')}`, clauseId: id, slot, method, from, to,
    reason: text, actor, authorityGroup, identityAssurance, at };
  workflow.witnessDeferrals.push(record);
  return record;
}
