/**
 * Governed risk acceptance on obligations [E2G-025, E2G-026, decisions D4 and D5].
 *
 * A person in the group that approves the step owning an obligation may accept the risk of one
 * that failed, is missing or is inconclusive: for a closed category, for the transitions it names,
 * until an expiry, with a reason. The decision binds the observation it accepted, so evidence that
 * changes afterwards (including tampered evidence) is not covered by it. The obligation then reads
 * `excepted`; what was observed stays visible. An expired, revoked, out-of-scope or overtaken
 * decision counts for nothing and the matrix says to renew it. Some failures are never waivable:
 * stale evidence (rerun it), untrusted records (integrity), a review that did not happen, and the
 * scope, which has its own decisions. Decisions and revocations are append-only. Pure.
 */
import { recordSha256 } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';

export const RISK_CATEGORIES = Object.freeze(['external-dependency', 'known-failure', 'assurance-shortfall', 'deferred-verification', 'accepted-deviation']);
export const RISK_TRANSITIONS = Object.freeze(['terminal']);
export const MAX_RISK_DAYS = 90;
const RISK_ELIGIBLE_STATUSES = new Set(['failed', 'missing', 'inconclusive', 'partial']);
const DAY = 24 * 60 * 60 * 1000;

/**
 * What a decision accepted: the obligation's outcome, its observed facets and, for a criterion's
 * tests, how each test is tied and the exact attempts it ran in, never its review or exception. A
 * rerun is a new attempt, so a failure observed again is accepted again rather than inherited
 * [E2G-020].
 */
export function observationDigest(obligation) {
  const { coverage = null, execution = null, assurance = null } = obligation?.facets ?? {};
  return `sha256:${recordSha256({
    id: obligation?.id ?? null, status: obligation?.status ?? null, coverage, execution, assurance,
    ...(obligation?.assuranceFacets ? { assuranceFacets: obligation.assuranceFacets } : {}),
    ...(obligation?.attempts ? { attempts: obligation.attempts } : {})
  })}`;
}

/** Whether a person may accept the risk of this obligation now, and why not when they may not. */
export function riskEligibility(obligation, { untrusted = false } = {}) {
  if (!obligation) return { eligible: false, reason: 'unknown-obligation' };
  if (untrusted) return { eligible: false, reason: 'integrity', message: 'the records behind it do not verify; repair them, never accept them' };
  if (obligation.facets?.freshness === 'stale') return { eligible: false, reason: 'stale', message: 'its evidence is stale; run its step again' };
  if (obligation.responsibility === 'review') return { eligible: false, reason: 'unreviewed', message: 'a review is given by approving the step, never by accepting a risk' };
  if (obligation.responsibility === 'scope') return { eligible: false, reason: 'scope', message: 'the scope is decided with decision scope' };
  if (!RISK_ELIGIBLE_STATUSES.has(obligation.status)) {
    return { eligible: false, reason: 'not-open', message: obligation.status === 'pending' ? 'its step has not delivered yet' : `it is ${obligation.status}` };
  }
  return { eligible: true };
}

/** Who may accept: the approval groups of the steps that own the obligation. */
export function riskAuthorities(workflow, obligation) {
  const groups = new Set();
  for (const step of obligation?.owningSteps ?? []) {
    const policy = workflow?.phases?.[step]?.approvalPolicy ?? {};
    for (const group of [...(policy.authorities ?? []), ...(policy.requiredAuthorities ?? [])]) groups.add(group);
  }
  return [...groups].sort();
}

/** Record a decision on the aggregate; the caller found the obligation in the current evaluation and checked authority. */
export function recordRiskDecision(workflow, { obligation, untrusted = false, category, transitions = ['terminal'], expires, reason, actor, authorityGroup, identityAssurance = null, at }) {
  const eligibility = riskEligibility(obligation, { untrusted });
  if (!eligibility.eligible) {
    throw new SingularityFlowError(`The risk of ${obligation?.id ?? 'this obligation'} cannot be accepted: ${eligibility.message ?? eligibility.reason}.`, {
      code: 'RISK_NOT_WAIVABLE', details: { obligation: obligation?.id ?? null, reason: eligibility.reason }
    });
  }
  if (!RISK_CATEGORIES.includes(category)) {
    throw new SingularityFlowError(`--category must be one of ${RISK_CATEGORIES.join(', ')}.`, { code: 'RISK_DECISION_INVALID' });
  }
  const scope = [...new Set(transitions)];
  if (!scope.length || scope.some((entry) => !RISK_TRANSITIONS.includes(entry))) {
    throw new SingularityFlowError(`--transition must be one of ${RISK_TRANSITIONS.join(', ')}.`, { code: 'RISK_DECISION_INVALID' });
  }
  const expiry = /^\d{4}-\d{2}-\d{2}$/u.test(String(expires ?? '')) ? new Date(`${expires}T23:59:59.999Z`) : null;
  const now = new Date(at);
  if (!expiry || Number.isNaN(expiry.getTime()) || expiry <= now || expiry - now > MAX_RISK_DAYS * DAY) {
    throw new SingularityFlowError(`--expires must be a date after today and at most ${MAX_RISK_DAYS} days ahead (YYYY-MM-DD).`, { code: 'RISK_DECISION_INVALID' });
  }
  const text = String(reason ?? '').trim();
  if (text.length < 20 || text.length > 1000) {
    throw new SingularityFlowError('Say why the risk is acceptable in 20 to 1000 characters with --reason.', { code: 'RISK_DECISION_REASON_REQUIRED' });
  }
  workflow.riskDecisions ??= [];
  const decision = {
    id: `RISK-${String(workflow.riskDecisions.filter((entry) => !entry.revokes).length + 1).padStart(3, '0')}`,
    obligationId: obligation.id, category, transitions: scope.sort(), expiresAt: expiry.toISOString(),
    observation: { status: obligation.status, sha256: observationDigest(obligation) },
    reason: text, actor, authorityGroup, identityAssurance, at
  };
  workflow.riskDecisions.push(decision);
  return decision;
}

/** Revoke a decision; the record stays, and so does the revocation. */
export function recordRiskRevocation(workflow, { riskId, reason, actor, authorityGroup, identityAssurance = null, at }) {
  const target = (workflow.riskDecisions ?? []).find((entry) => !entry.revokes && entry.id === riskId);
  if (!target) throw new SingularityFlowError(`This Story has no risk decision ${riskId}.`, { code: 'RISK_DECISION_UNKNOWN' });
  if ((workflow.riskDecisions ?? []).some((entry) => entry.revokes === riskId)) {
    throw new SingularityFlowError(`${riskId} is already revoked.`, { code: 'RISK_DECISION_REVOKED' });
  }
  const text = String(reason ?? '').trim();
  if (text.length < 20 || text.length > 1000) {
    throw new SingularityFlowError('Say why the decision is revoked in 20 to 1000 characters with --reason.', { code: 'RISK_DECISION_REASON_REQUIRED' });
  }
  const revocation = { revokes: riskId, obligationId: target.obligationId, reason: text, actor, authorityGroup, identityAssurance, at };
  workflow.riskDecisions.push(revocation);
  return revocation;
}

/**
 * The latest decision on an obligation and whether it carries it at `at` for `transition`:
 * `active`, or why not: `revoked`, `expired`, `out-of-scope`, `overtaken` (the observation changed).
 * Null when nobody decided.
 */
export function riskDecisionState(workflow, obligation, { at, transition = 'terminal' } = {}) {
  const entries = workflow?.riskDecisions ?? [];
  const decision = [...entries].reverse().find((entry) => !entry.revokes && entry.obligationId === obligation?.id) ?? null;
  if (!decision) return null;
  if (entries.some((entry) => entry.revokes === decision.id)) return { decision, state: 'revoked' };
  if (new Date(decision.expiresAt) <= new Date(at ?? Date.now())) return { decision, state: 'expired' };
  if (!decision.transitions.includes(transition)) return { decision, state: 'out-of-scope' };
  if (decision.observation?.sha256 !== observationDigest(obligation)) return { decision, state: 'overtaken' };
  return { decision, state: 'active' };
}
