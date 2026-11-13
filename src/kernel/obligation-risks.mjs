/** Risk rules over admitted obligation observations. No record loading, presence registry or clock. */
import {canonicalJson,textDigestCapability} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {fallbackAuthorities,stepGroups} from './approval-fallback.mjs';
export {fallbackAuthorities};
/** Namespace records have their own wire; the native risk collection and IDs keep their meaning. */
export function planNamespaceObligationRisk(workflow,request,facts,source,rules){
  const proposed=structuredClone(workflow),rows=structuredClone(workflow.namespaceObligationRisks??[]),native={riskDecisions:structuredClone(rows)};
  let record;
  if(request.revoke)record=rules.recordRiskRevocation(native,{riskId:request.revoke,reason:request.reason,
    actor:facts.actorId,authorityGroup:facts.authorityGroup,at:facts.at},rows);
  else record=rules.recordRiskDecision(native,{obligation:source.obligation,category:request.category,transitions:request.transitions,
    expires:request.expires,reason:request.reason,actor:facts.actorId,authorityGroup:facts.authorityGroup,at:facts.at});
  record={schemaVersion:1,profile:'sflow-namespace-obligation-risk/v1',...record};
  proposed.namespaceObligationRisks=[...rows,record];
  proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:request.revoke?'obligation_risk_revoked':'obligation_risk_accepted',
    phase:request.phaseId,detail:record.id??record.revokes});
  return {workflow:proposed,outcome:{currentPhase:workflow.currentPhase,record}};
}
export function obligationRiskPolicies(digests) {
  const hashing=textDigestCapability(digests),recordSha256=value=>hashing.sha256Utf8(canonicalJson(value));
const RISK_CATEGORIES = Object.freeze(['external-dependency', 'known-failure', 'assurance-shortfall', 'deferred-verification', 'accepted-deviation']);
const RISK_TRANSITIONS = Object.freeze(['terminal']);
const MAX_RISK_DAYS = 90;
const RISK_ELIGIBLE_STATUSES = new Set(['failed', 'missing', 'inconclusive', 'partial']);
const DAY = 24 * 60 * 60 * 1000;

/**
 * What a decision accepted: the obligation's outcome, its observed facets and, for a criterion's
 * tests, how each test is tied and the exact attempts it ran in, never its review or exception. A
 * rerun is a new attempt, so a failure observed again is accepted again rather than inherited
 * [E2G-020].
 */
function observationDigest(obligation) {
  const { coverage = null, execution = null, assurance = null } = obligation?.facets ?? {};
  return `sha256:${recordSha256({
    id: obligation?.id ?? null, status: obligation?.status ?? null, coverage, execution, assurance,
    ...(obligation?.assuranceFacets ? { assuranceFacets: obligation.assuranceFacets } : {}),
    ...(obligation?.attempts ? { attempts: obligation.attempts } : {})
  })}`;
}

/** Whether a person may accept the risk of this obligation now, and why not when they may not. */
function riskEligibility(obligation, { untrusted = false } = {}) {
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


/** Who may accept: the approval groups of the steps that own the obligation, else the nearest step's. */
function riskAuthorities(workflow, obligation) {
  const steps = obligation?.owningSteps ?? [];
  const groups = new Set(steps.flatMap((step) => stepGroups(workflow, step)));
  return groups.size ? [...groups].sort() : fallbackAuthorities(workflow, steps);
}

/** Record a decision on the aggregate; the caller found the obligation in the current evaluation and checked authority. */
function recordRiskDecision(workflow, { obligation, untrusted = false, category, transitions = ['terminal'], expires, reason, actor, authorityGroup, identityAssurance = null, at }) {
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
function recordRiskRevocation(workflow, { riskId, reason, actor, authorityGroup, identityAssurance = null, at }, observed = workflow.riskDecisions ?? []) {
  const target = observed.find((entry) => !entry.revokes && entry.id === riskId);
  if (!target) throw new SingularityFlowError(`This Story has no risk decision ${riskId}.`, { code: 'RISK_DECISION_UNKNOWN' });
  if (observed.some((entry) => entry.revokes === riskId)) {
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
function riskDecisionState(workflow, obligation, { at, transition = 'terminal' } = {}, observed = workflow?.riskDecisions ?? []) {
  if(typeof at!=='string'||!Number.isFinite(Date.parse(at)))throw new SingularityFlowError('Risk evaluation requires an explicit observation timestamp.',{code:'ENGINE_INPUT_INVALID'});
  const entries = observed;
  const decision = [...entries].reverse().find((entry) => !entry.revokes && entry.obligationId === obligation?.id) ?? null;
  if (!decision) return null;
  if (entries.some((entry) => entry.revokes === decision.id)) return { decision, state: 'revoked' };
  if (new Date(decision.expiresAt) <= new Date(at)) return { decision, state: 'expired' };
  if (!decision.transitions.includes(transition)) return { decision, state: 'out-of-scope' };
  if (decision.observation?.sha256 !== observationDigest(obligation)) return { decision, state: 'overtaken' };
  return { decision, state: 'active' };
}

/**
 * Clauses whose missing or partial implementation a person accepted for this transition, by full
 * clause ID. The final gate's clause coverage carries these as the evidence evaluation does; that
 * the accepted observation still holds is the evaluation's own check at the same transition, so
 * here only the latest decision per obligation, unrevoked, unexpired and naming the transition, counts.
 */
function acceptedImplementationClauses(workflow, { at, transition = 'terminal' } = {}, observed = workflow?.riskDecisions ?? []) {
  if(typeof at!=='string'||!Number.isFinite(Date.parse(at)))throw new SingularityFlowError('Risk evaluation requires an explicit observation timestamp.',{code:'ENGINE_INPUT_INVALID'});
  const workId = workflow?.workItem?.id;
  const prefix = `OBL:${workId}:implement:`;
  const entries = observed;
  const latest = new Map();
  for (const entry of entries) if (!entry.revokes && String(entry.obligationId ?? '').startsWith(prefix)) latest.set(entry.obligationId, entry);
  const clauses = new Set();
  for (const decision of latest.values()) {
    if (entries.some((entry) => entry.revokes === decision.id)) continue;
    if (new Date(decision.expiresAt) <= new Date(at) || !(decision.transitions ?? []).includes(transition)) continue;
    const local = decision.obligationId.slice(prefix.length);
    clauses.add(local.includes(':') ? local : `${workId}:${local}`);
  }
  return clauses;
}

return Object.freeze({RISK_CATEGORIES,RISK_TRANSITIONS,MAX_RISK_DAYS,observationDigest,riskEligibility,riskAuthorities,recordRiskDecision,recordRiskRevocation,riskDecisionState,acceptedImplementationClauses});
}
