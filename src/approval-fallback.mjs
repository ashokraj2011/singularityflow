/** Who decides for a step that has no approval group of its own. Pure; reads approval policies only. */

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
