/**
 * The two rules a specification split must keep (SPEC-SPA v1.3 §7, SPA:REQ-025), with no I/O.
 *
 * - Every clause of the revision is allocated at least once, to a child specification or a Story
 *   slice, or is listed as not delivered here. This is stricter than Epic planning, which requires
 *   only acceptance criteria to be allocated (epic-traceability.mjs); that check reads files and
 *   cannot be shared (S0 inventory).
 * - The Story slices' dependencies have no cycle. A cycle is returned as the path that closes it, so
 *   the refusal can name every step.
 */

/** The clauses no allocation names and no "not delivered here" entry lists, in the revision's order. */
export function unallocatedClauses(clauses, allocations, leftOut = []) {
  const covered = new Set([...allocations.flatMap((entry) => entry.clauses), ...leftOut.map((entry) => entry.clause)]);
  return clauses.filter((clause) => !covered.has(clause));
}

/** The clauses both allocated and listed as not delivered here. */
export function contradictedClauses(allocations, leftOut = []) {
  const allocated = new Set(allocations.flatMap((entry) => entry.clauses));
  return [...new Set(leftOut.map((entry) => entry.clause).filter((clause) => allocated.has(clause)))];
}

/**
 * The first dependency cycle among `nodes` (`edges` maps a node to the nodes it depends on), as the
 * path from a node back to itself (`['S1', 'S2', 'S1']`), or null when there is none. Nodes are
 * visited in the order given, so the same plan always names the same cycle.
 */
export function dependencyCycle(nodes, edges) {
  const state = new Map();
  const stack = [];
  const visit = (node) => {
    state.set(node, 'open');
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (state.get(next) === 'open') return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  };
  for (const node of nodes) {
    if (state.has(node)) continue;
    const found = visit(node);
    if (found) return found;
  }
  return null;
}

/** The nodes in an order where each comes after everything it depends on (only when acyclic). */
export function dependencyOrder(nodes, edges) {
  const placed = new Set();
  const order = [];
  const place = (node) => {
    if (placed.has(node)) return;
    placed.add(node);
    for (const next of edges.get(node) ?? []) place(next);
    order.push(node);
  };
  for (const node of nodes) place(node);
  return order;
}
