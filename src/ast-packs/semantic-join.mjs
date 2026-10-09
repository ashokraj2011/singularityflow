/**
 * Compiler answers joined to the structural preview's declaration IDs.
 *
 * The Java and Python syntax skeletons come from the bundled structural preview on every machine.
 * A semantic pack asks a compiler (the JDK's javac, Pyright) which declaration each call resolves
 * to and names both ends by path, name and the line of that name. This module turns those answers
 * into relationships between the preview's declaration IDs, so semantic edges join the skeleton
 * without changing it. An end the preview did not record contributes no edge: an edge never points
 * at an identity the skeleton does not have.
 */

/** Index a file's skeleton declarations by name and the line of that name. */
export function declarationIndex(facts) {
  const index = new Map();
  for (const fact of facts) {
    if (fact.kind !== 'symbol' || !fact.id) continue;
    const key = `${fact.name}\0${fact.line ?? fact.span?.startLine}`;
    if (!index.has(key)) index.set(key, fact.id);
  }
  return index;
}

/**
 * `calls` and `overrides` relationships for the requested files, one per pair of declarations.
 * Each edge is `{ type, caller: {path, name, line}, target: {path, name, line}, span }`, where the
 * caller of an `overrides` edge is the overriding method. `skeletonFor(path)` returns the syntax
 * skeleton facts of any repository file (or null). Returns `{ byPath, unjoined }`, where unjoined
 * counts edges whose ends the skeleton lacks.
 */
export async function joinSemanticEdges(edges, requestedPaths, skeletonFor) {
  const requested = new Set(requestedPaths);
  const indexes = new Map();
  const idFor = async (end) => {
    if (!indexes.has(end.path)) {
      const facts = await skeletonFor(end.path);
      indexes.set(end.path, facts ? declarationIndex(facts) : new Map());
    }
    return indexes.get(end.path).get(`${end.name}\0${end.line}`) ?? null;
  };
  const byPath = new Map();
  const seen = new Set();
  let unjoined = 0;
  for (const edge of edges) {
    if (!requested.has(edge.caller.path)) continue;
    const sourceId = await idFor(edge.caller);
    const target = await idFor(edge.target);
    if (!sourceId || !target) { unjoined += 1; continue; }
    const type = edge.type ?? 'calls';
    const key = `${type}:${sourceId}>${target}`;
    if (sourceId === target || seen.has(key)) continue;
    seen.add(key);
    const facts = byPath.get(edge.caller.path) ?? [];
    facts.push({ kind: 'relationship', type, sourceId, target, span: edge.span, assurance: 'semantic' });
    byPath.set(edge.caller.path, facts);
  }
  return { byPath, unjoined };
}
