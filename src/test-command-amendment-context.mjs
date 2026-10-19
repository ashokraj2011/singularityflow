/** One prospective aggregate token shared by amendment validation and its locked writer. */
export const prospectiveTestCommandAmendments = new WeakMap();
export function prospectiveTestCommandAmendment(workflow) { return prospectiveTestCommandAmendments.get(workflow) ?? null; }
