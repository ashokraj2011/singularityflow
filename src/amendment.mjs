/**
 * What an amendment changed, and who it reaches. `[AMD:REQ-011]` `[AMD:REQ-020]` `[AMD:REQ-021]`
 *
 * Specifications change while implementation is in flight. The pieces to handle that already
 * existed — clauses with body hashes, planned and observed claim maps, generations — and nothing
 * joined them, so "the spec moved, what does that break?" had no answer a machine could give.
 *
 * Two computations, both deterministic and both `model: never`:
 *
 *   - the **clause diff** between two generations: added, revised, removed, unchanged
 *   - the **blast radius**: the closure over the claim map of everything that cited a changed clause
 *
 * Neither decides anything. The kernel computes and people advance `[AMD:CON-003]`; nothing here
 * reopens a phase, stales an approval, or disposes of a finding.
 *
 * `[AMD:REQ-021]` is the reason the report carries the complement as loudly as the radius. Told only
 * what broke, a reader has to prove the silence means safety; told "two of your nine claims are
 * affected and the other seven stand", they can act. Reassurance is half the feature, and it is the
 * half that gets dropped when a report is written as a list of problems.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from './specifications.mjs';
import { SingularityFlowError } from './util.mjs';

/** How a clause changed between two generations. */
export const CLAUSE_CHANGES = Object.freeze(['added', 'revised', 'removed', 'unchanged']);

/**
 * A clause's own statement, hashed.
 *
 * NOT `clause.body`. The extractor defines a body as the text *following* the anchor, and the
 * shipped specification template puts anchors at the end of the sentence they identify — so
 * `REQ-001`'s body is `REQ-002`'s sentence, and the last clause's body is empty. Diffing bodies
 * would report a clause as revised when its *successor* was edited, miss the edit to the clause
 * itself, and point the blast radius one claim away from the truth every time.
 *
 * The statement is the line the anchor sits on, which is the text a reader would say the clause is.
 */
function statementHash(clause, markdown) {
  const line = Number(clause?.source?.line ?? 0);
  const text = line > 0 ? (String(markdown ?? '').split('\n')[line - 1] ?? '') : String(clause?.body ?? '');
  return createHash('sha256').update(text.trim()).digest('hex');
}

function clauseIndex(clauses, markdown, label) {
  if (!Array.isArray(clauses)) throw new SingularityFlowError(`${label} must be an array of clauses.`, { code: 'AMENDMENT_INVALID' });
  const index = new Map();
  for (const clause of clauses) {
    const id = String(clause?.id ?? '').toUpperCase();
    if (!id) throw new SingularityFlowError(`${label} contains a clause with no id.`, { code: 'AMENDMENT_INVALID' });
    index.set(id, statementHash(clause, markdown));
  }
  return index;
}

/**
 * The clause diff between two generations of the same specification. `[AMD:REQ-011]`
 *
 * Removal is reported rather than inferred from absence, because a coverage report that quietly
 * stops mentioning a clause reads as a clause that was satisfied (D1: a tombstone beats a silent
 * disappearance).
 */
export function clauseDiff(before, after, { beforeMarkdown = null, afterMarkdown = null } = {}) {
  const from = clauseIndex(before ?? [], beforeMarkdown, 'Prior generation');
  const to = clauseIndex(after ?? [], afterMarkdown, 'Amended generation');
  const added = [];
  const revised = [];
  const removed = [];
  const unchanged = [];
  for (const [id, hash] of to) {
    if (!from.has(id)) added.push(id);
    else if (from.get(id) !== hash) revised.push(id);
    else unchanged.push(id);
  }
  for (const id of from.keys()) if (!to.has(id)) removed.push(id);
  const changed = [...added, ...revised, ...removed].sort();
  return Object.freeze({
    added: Object.freeze(added.sort()),
    revised: Object.freeze(revised.sort()),
    removed: Object.freeze(removed.sort()),
    unchanged: Object.freeze(unchanged.sort()),
    changed: Object.freeze(changed),
    // Content-addressed so an amendment record can be compared without re-diffing.
    sha256: createHash('sha256').update(canonicalJson({ added, revised, removed })).digest('hex')
  });
}

/**
 * Everything a set of changed clauses reaches, through the claim map. `[AMD:REQ-020]`
 *
 * The closure is one hop by construction: a claim names the paths expected to satisfy its clause and
 * the tests bound to it, so a changed clause reaches exactly its own claim's artifacts and tests.
 * Deliberately not transitive — "this file also contains an unrelated claim" is not a reason to
 * reopen that claim, and a radius that grows by file adjacency stops being believable at the size
 * where believing it matters.
 */
export function blastRadius(diff, claims, { observed = null } = {}) {
  if (!diff?.changed) throw new SingularityFlowError('Blast radius needs a clause diff.', { code: 'AMENDMENT_INVALID' });
  const planned = claims?.claims ?? claims ?? {};
  const changed = new Set(diff.changed);
  const affected = [];
  const untouched = [];

  for (const [rawId, claim] of Object.entries(planned)) {
    const id = rawId.toUpperCase();
    const entry = {
      clauseId: id,
      change: diff.added.includes(id) ? 'added'
        : diff.revised.includes(id) ? 'revised'
          : diff.removed.includes(id) ? 'removed' : 'unchanged',
      artifacts: Object.freeze([...(claim?.expectedPaths ?? [])]),
      tests: Object.freeze([...(claim?.tests ?? [])]),
      // What the last reconciliation said about this clause, so a reader can tell a claim that was
      // already satisfied from one still in flight.
      verdict: observed?.claims?.[id]?.verdict ?? observed?.[id]?.verdict ?? null
    };
    (changed.has(id) ? affected : untouched).push(Object.freeze(entry));
  }

  /**
   * A clause that changed and that nobody claims. Not an error — a specification may add a clause
   * before any work claims it — but it must be named, because it is the one part of the radius the
   * claim map cannot account for.
   */
  const unclaimed = diff.changed.filter((id) => !Object.keys(planned).some((key) => key.toUpperCase() === id));

  const artifacts = new Set(affected.flatMap((entry) => entry.artifacts));
  const tests = new Set(affected.flatMap((entry) => entry.tests));

  return Object.freeze({
    resultType: 'amendment-blast-radius',
    schemaVersion: 1,
    changed: diff.changed,
    affected: Object.freeze(affected.sort((left, right) => left.clauseId.localeCompare(right.clauseId))),
    untouched: Object.freeze(untouched.sort((left, right) => left.clauseId.localeCompare(right.clauseId))),
    unclaimed: Object.freeze([...unclaimed].sort()),
    artifacts: Object.freeze([...artifacts].sort()),
    tests: Object.freeze([...tests].sort()),
    // The complement, precomputed, so no surface has to derive reassurance for itself.
    totals: Object.freeze({
      claims: affected.length + untouched.length,
      affected: affected.length,
      untouched: untouched.length
    })
  });
}

/**
 * The sentence `[AMD:REQ-021]` asks for.
 *
 * Deliberately leads with the complement. "Two of nine affected" and "seven stand" are the same
 * arithmetic, and only the second tells a reader they can keep working.
 */
export function radiusSummary(radius) {
  const { claims, affected, untouched } = radius.totals;
  if (!claims) return 'No claims are recorded yet, so nothing can be shown as affected or safe.';
  if (!affected) return `None of your ${claims} claim${claims === 1 ? '' : 's'} are affected; all of them stand.`;
  const parts = [`${affected} of your ${claims} claims affected; the other ${untouched} stand.`];
  if (radius.artifacts.length) parts.push(`${radius.artifacts.length} artifact path(s) and ${radius.tests.length} bound test(s) are in scope.`);
  if (radius.unclaimed.length) parts.push(`${radius.unclaimed.length} changed clause(s) are claimed by nobody yet: ${radius.unclaimed.join(', ')}.`);
  return parts.join(' ');
}
