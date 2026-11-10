/** Pinned omission authorities and applicability records. No ambient identity or presence registry. */
import {SingularityFlowError} from '../foundation/failures.mjs';

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
