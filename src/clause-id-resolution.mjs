/**
 * A clause ID as a person or an agent types it, read against the clauses a Story has. The full ID
 * (`RTY-1:REQ-001`) is itself; a short one (`REQ-001`) is the one clause whose ID ends with it, from the
 * Work ID's namespace or the specification's (`spec.namespace`). A short ID that names none, or more than
 * one, is not guessed: the caller refuses it, naming the full IDs it could mean (paid run, 2026-11-15:
 * `intent-amendment draft --clause REQ-001` was refused with "no clause REQ-001", costing a call).
 * Loaded only by the commands that take --clause.
 */

const short = (id) => String(id).split(':').at(-1).toUpperCase();

/** `{ resolved, unresolved }`: each typed ID as the clause it names, or with the full IDs it could mean. */
export function resolveClauseIds(typed, known) {
  const ids = [...new Set(known.map(String))];
  const resolved = [];
  const unresolved = [];
  for (const raw of typed) {
    const id = String(raw).trim();
    const exact = ids.find((candidate) => candidate.toUpperCase() === id.toUpperCase());
    if (exact) { resolved.push(exact); continue; }
    const candidates = ids.filter((candidate) => candidate.includes(':') && short(candidate) === short(id));
    if (!id.includes(':') && candidates.length === 1) resolved.push(candidates[0]);
    else unresolved.push({ id, candidates });
  }
  return { resolved: [...new Set(resolved)], unresolved };
}

/** One sentence for the clauses that did not resolve: what each could mean, or the clauses there are. */
export function unresolvedClauseWords(unresolved, known, { what = 'the approved scope' } = {}) {
  const sentences = unresolved.map(({ id, candidates }) => (candidates.length
    ? `${id} could mean ${candidates.join(' or ')}; name it in full`
    : `${id} is not a clause of ${what}`));
  const listed = [...new Set(known)].slice(0, 12);
  return `${sentences.join('. ')}.${unresolved.some((entry) => !entry.candidates.length) && listed.length
    ? ` Its clauses: ${listed.join(', ')}${known.length > listed.length ? ', …' : ''}.` : ''}`;
}
