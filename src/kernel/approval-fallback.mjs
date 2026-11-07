/** Who decides for a step that has no approval group of its own. Pure; reads approval policies only. */

/** Technical correction is always same-phase. Business send-back targets remain as configured. */
export function phaseCorrectionTargets(phase) {
  const policy = phase?.approvalPolicy ?? phase?.approval;
  if (!phase?.id || policy?.mode === 'none') return [];
  return [...new Set([phase.id, ...(policy?.rejectTo ?? [])])];
}

/** A step's approval groups: those that may approve it and those it requires. */
export const stepGroups = (workflow, id) => {
  const policy = workflow?.phases?.[id]?.approvalPolicy ?? {};
  return [...(policy.authorities ?? []), ...(policy.requiredAuthorities ?? [])];
};

/**
 * The approval groups of the nearest step that has them, for work whose own `steps` have none: the
 * steps after the last of them first (they review that work), then the steps before it; with no
 * steps, the last step that has approvers. A quick-fix or poc-lite code step, or a criterion no
 * test is tied to, left nobody who could witness, accept a risk, decide scope or correct the plan
 * (2026-10-28). It reads approval policies only, so a record made under it verifies the same later.
 */
export function fallbackAuthorities(workflow, steps = []) {
  const order = workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {});
  const last = Math.max(-1, ...steps.map((id) => order.indexOf(id)));
  const candidates = last < 0 ? [...order].reverse() : [...order.slice(last + 1), ...order.slice(0, last + 1).reverse()];
  const found = candidates.find((id) => stepGroups(workflow, id).length);
  return found ? [...new Set(stepGroups(workflow, found))].sort() : [];
}

/**
 * Who may accept the risk of a step's test commands: the step's approval groups. A step nobody
 * approves (quick-fix's implement) is answered for by the next step on the route that has
 * approvers, since they review its evidence.
 */
export function testRunRiskAuthorities(workflow, phaseId) {
  const groups = (id) => {
    const policy = workflow?.phases?.[id]?.approvalPolicy ?? {};
    return [...new Set([...(policy.authorities ?? []), ...(policy.requiredAuthorities ?? [])])].sort();
  };
  const own = groups(phaseId);
  if (own.length) return own;
  const order = workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {});
  for (const id of order.slice(order.indexOf(phaseId) + 1)) {
    const next = groups(id);
    if (next.length) return next;
  }
  return [];
}

/**
 * Who may reuse evidence for a step: the groups that approve the step consuming it, exactly as
 * for a test-run risk (a step nobody approves is answered for by the next approving step).
 */
export function evidenceReuseAuthorities(workflow, phaseId) {
  return testRunRiskAuthorities(workflow, phaseId);
}

/**
 * Who may decide a visual step's profiles: the groups that approve that step, exactly as for a
 * test-run risk (a step nobody approves is answered for by the next approving step).
 */
export function visualProfileAuthorities(workflow, phaseId) {
  return testRunRiskAuthorities(workflow, phaseId);
}

/** The step whose approvers decide: the step itself, else the next one on the route that has approvers. */
export function testCommandDecisionPhase(workflow, phaseId) {
  const approved = (id) => {
    const policy = workflow.phases?.[id]?.approvalPolicy ?? {};
    return (policy.authorities ?? []).length + (policy.requiredAuthorities ?? []).length > 0;
  };
  if (approved(phaseId)) return phaseId;
  const order = workflow.phaseOrder ?? Object.keys(workflow.phases ?? {});
  return order.slice(order.indexOf(phaseId) + 1).find(approved) ?? phaseId;
}
