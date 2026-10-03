/**
 * Scope revisions [E2G-008].
 *
 * Every time the Story's accepted clause set changes (a step that defines clauses is approved with
 * different clauses, or an intent amendment is approved), the Story records a new revision: the
 * clauses with their statement hashes, what changed since the previous revision, and the generation
 * each later step had reached at that moment. Revisions are append-only and hash-chained, so the
 * history of the scope stays intact.
 *
 * Evidence becomes stale through its dependencies, never wholesale: a plan, mapping, result or
 * review of a clause is stale only when a revision added or revised that clause (or a clause it
 * depends on) after the step that produced the evidence had reached its generation. Every other
 * clause keeps its evidence. A step re-run after the revision publishes a later generation, and its
 * evidence is current again. Pure: no I/O.
 */
import { clauseDiff } from '../amendment.mjs';
import { recordSha256 } from '../records.mjs';

export const SCOPE_REVISION_VERSION = 'scope-revision/v1';

/** The accepted clauses of the Story's current specification indexes, in a stable order. */
export function acceptedClauses(indexes = []) {
  const byId = new Map();
  for (const index of indexes) {
    for (const clause of index?.clauses ?? []) {
      const id = String(clause?.id ?? '').toUpperCase();
      if (!id || byId.has(id)) continue;
      byId.set(id, { id, bodySha256: clause.bodySha256 ?? null, definedIn: index.phase ?? null, generation: Number(index.generation ?? 0) });
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function latestScopeRevision(workflow) {
  return workflow?.scopeRevisions?.at(-1) ?? null;
}

/**
 * Append a revision when the accepted clause set differs from the latest one; otherwise return
 * null. `origin` names what changed it: `{ kind: 'approval' | 'intent-amendment', phase, generation, id? }`.
 * Only steps after the origin step can have consumed the change, so only their generations are
 * recorded as dependents.
 */
export function recordScopeRevision(workflow, { clauses, origin, at }) {
  const identity = clauses.map(({ id, bodySha256 }) => ({ id, bodySha256 }));
  const clausesSha256 = `sha256:${recordSha256(identity)}`;
  const latest = latestScopeRevision(workflow);
  if (latest?.clausesSha256 === clausesSha256) return null;
  const diff = latest ? clauseDiff(latest.clauses, identity) : null;
  const order = workflow.phaseOrder ?? [];
  const start = order.indexOf(origin.phase);
  const core = {
    schema: SCOPE_REVISION_VERSION,
    revision: (latest?.revision ?? 0) + 1,
    clauses,
    clausesSha256,
    changes: diff ? { added: [...diff.added], revised: [...diff.revised], removed: [...diff.removed] } : null,
    origin,
    dependentGenerations: Object.fromEntries(order.slice(start + 1).map((id) => [id, Number(workflow.phases?.[id]?.generation ?? 0)])),
    previousRevisionSha256: latest?.revisionSha256 ?? null,
    at
  };
  const revision = { ...core, revisionSha256: `sha256:${recordSha256(core)}` };
  workflow.scopeRevisions ??= [];
  workflow.scopeRevisions.push(revision);
  return revision;
}

/**
 * The clauses whose evidence a revision makes stale: every clause it added or revised, and every
 * current clause that depends on one of them, directly or through another.
 */
export function staleClausesOf(revision, clauses = []) {
  const stale = new Set([...(revision?.changes?.added ?? []), ...(revision?.changes?.revised ?? [])]);
  let grew = stale.size > 0;
  while (grew) {
    grew = false;
    for (const clause of clauses) {
      const id = String(clause.id).toUpperCase();
      if (stale.has(id)) continue;
      if ((clause.dependsOn ?? []).some((dependency) => stale.has(String(dependency).toUpperCase()))) {
        stale.add(id);
        grew = true;
      }
    }
  }
  return stale;
}

/**
 * A reader for one evaluation: `staleBy(clauseId, phaseId, generation)` returns the latest revision
 * that makes that step's evidence of that clause stale, or null when the evidence is current.
 */
export function scopeStaleness(workflow, clauses = []) {
  const revisions = (workflow?.scopeRevisions ?? []).filter((revision) => revision.changes)
    .map((revision) => ({ revision, stale: staleClausesOf(revision, clauses) }));
  return {
    revisions: revisions.map((entry) => entry.revision),
    staleBy(clauseId, phaseId, generation) {
      const id = String(clauseId).toUpperCase();
      // A step that has not published anything yet has no evidence to be stale.
      if (!(Number(generation ?? 0) > 0)) return null;
      for (let index = revisions.length - 1; index >= 0; index -= 1) {
        const { revision, stale } = revisions[index];
        if (!stale.has(id) || !Object.hasOwn(revision.dependentGenerations ?? {}, phaseId)) continue;
        if (Number(generation ?? 0) <= Number(revision.dependentGenerations[phaseId])) return revision;
      }
      return null;
    }
  };
}

/** Every clause any revision removed: its earlier evidence is history, not a broken record. */
export function removedClauseIds(workflow) {
  return [...new Set((workflow?.scopeRevisions ?? []).flatMap((revision) => revision.changes?.removed ?? []))].sort();
}
