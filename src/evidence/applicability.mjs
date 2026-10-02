/**
 * Applicability decisions for the responsibilities a route declares it omits [E2G-005, D18].
 *
 * A workflow may end a Story without a responsibility only where it declared `omits` with an
 * approval group; a person in that group then records why the responsibility does not apply to
 * this Story. Pure: these helpers read and change the aggregate and perform no I/O.
 */
import { SingularityFlowError } from '../util.mjs';

/**
 * The end a Story reached, or will reach if nothing changes: the decision route that finished it,
 * otherwise the natural end after its last step.
 */
export function endpointTaken(workflow) {
  const endpoints = workflow?.resolution?.obligationGraph?.endpoints ?? [];
  // The most recent routing decides: rework that re-runs a decision logs it again.
  const latest = workflow?.decisionLog?.at(-1) ?? null;
  if (latest?.kind === 'end') {
    const exact = endpoints.find((endpoint) => endpoint.decision === latest.decision && endpoint.route === latest.route);
    if (exact) return exact;
    const anyStep = endpoints.find((endpoint) => endpoint.decision === latest.decision && endpoint.route === 'any-step:end');
    if (anyStep) return anyStep;
  }
  const last = workflow?.phaseOrder?.at(-1) ?? null;
  const fromLast = endpoints.filter((endpoint) => endpoint.from === last);
  return fromLast.find((endpoint) => endpoint.decision === null) ?? fromLast[0] ?? null;
}

/** Every omission any end of the pinned graph declares for a responsibility, keyed by group. */
export function omissionAuthorities(workflow, responsibility) {
  const groups = new Set();
  for (const endpoint of workflow?.resolution?.obligationGraph?.endpoints ?? []) {
    for (const entry of endpoint.omits ?? []) if (entry.responsibility === responsibility && entry.authority) groups.add(entry.authority);
  }
  return [...groups].sort();
}

/** The current applicability decision for a responsibility, if one was recorded. */
export function applicabilityDecision(workflow, responsibility) {
  return [...(workflow?.applicability ?? [])].reverse().find((entry) => entry.responsibility === responsibility && !entry.withdrawnAt) ?? null;
}

/**
 * What the end a Story reached still needs: each omitted responsibility with its decision, if any,
 * and whether that decision was made by the group the omission names.
 */
export function applicabilityStatus(workflow, endpoint = endpointTaken(workflow)) {
  return (endpoint?.omits ?? []).map((entry) => {
    const decision = applicabilityDecision(workflow, entry.responsibility);
    const authorized = Boolean(decision) && decision.authorityGroup === entry.authority;
    return {
      responsibility: entry.responsibility,
      authority: entry.authority,
      declaredReason: entry.reason,
      decision: decision ? { reason: decision.reason, actor: decision.actor, authorityGroup: decision.authorityGroup, at: decision.at } : null,
      satisfied: authorized
    };
  });
}

/** Record a person's applicability decision on the aggregate. The caller has checked authority. */
export function recordApplicabilityDecision(workflow, { responsibility, reason, actor, authorityGroup, identityAssurance = null, at }) {
  const groups = omissionAuthorities(workflow, responsibility);
  if (!groups.length) {
    throw new SingularityFlowError(
      `No end of this Story's workflow omits ${responsibility}, so there is nothing to decide about it.`,
      { code: 'APPLICABILITY_NOT_OMITTED', details: { responsibility } }
    );
  }
  if (!groups.includes(authorityGroup)) {
    throw new SingularityFlowError(
      `Only ${groups.join(' or ')} may decide whether ${responsibility} applies to this Story.`,
      { code: 'APPLICABILITY_AUTHORITY_REQUIRED', details: { responsibility, authorities: groups } }
    );
  }
  const text = String(reason ?? '').trim();
  if (text.length < 20 || text.length > 1000) {
    throw new SingularityFlowError('Say why it does not apply in 20 to 1000 characters with --reason.', { code: 'APPLICABILITY_REASON_REQUIRED' });
  }
  workflow.applicability ??= [];
  for (const entry of workflow.applicability) {
    if (entry.responsibility === responsibility && !entry.withdrawnAt) entry.withdrawnAt = at;
  }
  const decision = { responsibility, reason: text, actor, authorityGroup, identityAssurance, at };
  workflow.applicability.push(decision);
  return decision;
}
