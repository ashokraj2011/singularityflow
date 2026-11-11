/**
 * A test witness as a person names it [no hashes shown]: its criterion, with its number among that
 * criterion's witnesses when it has several (`QF-1:AC-001`, `QF-1:AC-001#2`). The review shows this name
 * and `approve --witness-mapping <name>=...` takes it; the CLI turns it back into the mapping's digest from
 * the submitted packet the approval is bound to, so the decision binds exactly the mapping it did when a
 * person typed the digest. Leaf module: it imports nothing.
 */
export const WITNESS_NAME = /^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}(?:#[1-9]\d{0,3})?$/u;

const order = (mapping) => [mapping?.sourcePath ?? '', mapping?.test ?? '', mapping?.slot ?? '', mapping?.mappingSha256 ?? ''].join('\u0000');

/** Each mapping's digest to its name, over the whole submitted set (the same set gives the same names). */
export function witnessNames(mappings) {
  const byClause = new Map();
  for (const mapping of mappings ?? []) {
    if (typeof mapping?.mappingSha256 !== 'string' || typeof mapping?.clauseId !== 'string') continue;
    byClause.set(mapping.clauseId, [...(byClause.get(mapping.clauseId) ?? []), mapping]);
  }
  const names = new Map();
  for (const [clauseId, list] of byClause) {
    const ordered = [...list].sort((left, right) => order(left).localeCompare(order(right)));
    ordered.forEach((mapping, index) => names.set(mapping.mappingSha256, list.length === 1 ? clauseId : `${clauseId}#${index + 1}`));
  }
  return names;
}

/** Decisions that name a witness, turned into the digest of the submitted mapping that name stands for. */
export function resolveWitnessNames(decisions, mappings) {
  const digests = new Map([...witnessNames(mappings)].map(([digest, name]) => [name, digest]));
  return (decisions ?? []).map((decision) => (WITNESS_NAME.test(decision?.mappingSha256 ?? '') && digests.has(decision.mappingSha256)
    ? { ...decision, mappingSha256: digests.get(decision.mappingSha256) } : decision));
}

/** A text with each mapping digest it holds said as that witness's name. */
export function namedWitnessText(text, mappings) {
  let said = String(text ?? '');
  for (const [digest, name] of witnessNames(mappings)) said = said.split(digest).join(name);
  return said;
}
