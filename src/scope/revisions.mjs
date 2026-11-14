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
// Recorded on a Story whose pinned spec policy turns observed dependencies on [CIC:REQ-002, D3]: the v1
// fields, plus the stale set it makes with each clause's reason and the dependency edges that reason used.
export const SCOPE_REVISION_V2 = 'scope-revision/v2';

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
 * The revision the accepted clause set would make, or null when it matches the latest one; nothing is
 * appended. `origin` names what changed it: `{ kind: 'approval' | 'intent-amendment', phase, generation, id? }`.
 * Only steps after the origin step can have consumed the change, so only their generations are
 * recorded as dependents. An intent amendment's effect reads it before approval records it [CIC:CON-007].
 */
export function nextScopeRevision(workflow, { clauses, origin, at, dependencies = null }) {
  const identity = clauses.map(({ id, bodySha256 }) => ({ id, bodySha256 }));
  const clausesSha256 = `sha256:${recordSha256(identity)}`;
  const latest = latestScopeRevision(workflow);
  if (latest?.clausesSha256 === clausesSha256) return null;
  const diff = latest ? clauseDiff(latest.clauses, identity) : null;
  const order = workflow.phaseOrder ?? [];
  const start = order.indexOf(origin.phase);
  const changes = diff ? { added: [...diff.added], revised: [...diff.revised], removed: [...diff.removed] } : null;
  const core = {
    schema: dependencies ? SCOPE_REVISION_V2 : SCOPE_REVISION_VERSION,
    revision: (latest?.revision ?? 0) + 1,
    clauses,
    clausesSha256,
    changes,
    origin,
    dependentGenerations: Object.fromEntries(order.slice(start + 1).map((id) => [id, Number(workflow.phases?.[id]?.generation ?? 0)])),
    previousRevisionSha256: latest?.revisionSha256 ?? null,
    at,
    ...(dependencies ? staleReasons(changes, dependencies, { held: identity.map((clause) => clause.id) }) : {})
  };
  return { ...core, revisionSha256: `sha256:${recordSha256(core)}` };
}

/**
 * A v2 revision's stale set with each clause's reason, and the edges the reasons used: what staleClausesOf
 * computes under switch 1, said per clause (`added`, `revised`, `depends` on the clauses in `via`, removed ones
 * included, or `unrecorded` for every clause `held` by a revision that recorded no changes). `clauses` are the
 * current clauses with their declared `dependsOn` [CIC:REQ-002, REQ-006].
 */
export function staleReasons(changes, clauses = [], { held = [] } = {}) {
  const reasons = new Map(changes ? [...(changes.added ?? []).map((id) => [id, { clause: id, reason: 'added' }]),
    ...(changes.revised ?? []).map((id) => [id, { clause: id, reason: 'revised' }])]
    : held.map((id) => [String(id).toUpperCase(), { clause: String(id).toUpperCase(), reason: 'unrecorded' }]));
  const removed = new Set((changes?.removed ?? []).map((id) => String(id).toUpperCase()));
  const edges = [];
  let grew = reasons.size + removed.size > 0;
  while (grew) {
    grew = false;
    for (const clause of clauses) {
      const id = String(clause.id).toUpperCase();
      const via = reasons.has(id) ? [] : [...new Set((clause.dependsOn ?? []).map((dependency) => String(dependency).toUpperCase()))]
        .filter((dependency) => reasons.has(dependency) || removed.has(dependency)).sort();
      if (!via.length) continue;
      reasons.set(id, { clause: id, reason: 'depends', via });
      edges.push(...via.map((dependency) => ({ kind: 'declared', clause: id, dependsOn: dependency })));
      grew = true;
    }
  }
  return { stale: [...reasons.values()].sort((left, right) => left.clause.localeCompare(right.clause)), edges };
}

/** Append the revision nextScopeRevision makes, or return null when the clause set did not change. */
export function recordScopeRevision(workflow, change) {
  const revision = nextScopeRevision(workflow, change);
  if (!revision) return null;
  workflow.scopeRevisions ??= [];
  workflow.scopeRevisions.push(revision);
  return revision;
}

/** Whether the Story's pinned spec policy turns SPEC-CIC switch 1 on: read from the pinned raw field [CIC:REQ-018]. */
export const observedDependencies = (workflow) => workflow?.resolution?.spec?.observedDependencies === 'on';

/**
 * The clauses whose evidence a revision makes stale: every clause it added or revised, and every
 * current clause that depends on one of them, directly or through another. With `observed` (switch 1,
 * CIC:REQ-006), nothing unknown narrows it: a clause depending on one the revision removed is stale, and a
 * revision that recorded no changes (`changes: null`, the first revision, or one from before E6) makes every
 * clause it holds stale.
 */
export function staleClausesOf(revision, clauses = [], { observed = false } = {}) {
  const stale = new Set(observed && !revision?.changes ? (revision?.clauses ?? []).map((clause) => String(clause.id).toUpperCase())
    : [...(revision?.changes?.added ?? []), ...(revision?.changes?.revised ?? [])]);
  const sources = new Set([...stale, ...(observed ? revision?.changes?.removed ?? [] : [])].map((id) => String(id).toUpperCase()));
  let grew = sources.size > 0;
  while (grew) {
    grew = false;
    for (const clause of clauses) {
      const id = String(clause.id).toUpperCase();
      if (stale.has(id)) continue;
      if ((clause.dependsOn ?? []).some((dependency) => sources.has(String(dependency).toUpperCase()))) {
        stale.add(id);
        sources.add(id);
        grew = true;
      }
    }
  }
  return stale;
}

/**
 * A reader for one evaluation: `staleBy(clauseId, phaseId, generation)` returns the latest revision
 * that makes that step's evidence of that clause stale, or null when the evidence is current.
 * `carriedBy` returns the "still holds" answers that kept it current across an intent amendment's
 * revision (`carriers`, from scope/carried-evidence.mjs): the answer must name that revision's
 * amendment and the scope generation it made, for that step at that generation. Without `carriers`
 * nothing is carried.
 */
export function scopeStaleness(workflow, clauses = [], { carriers = new Map(), rowCarriers = new Map() } = {}) {
  const observed = observedDependencies(workflow);
  const revisions = (workflow?.scopeRevisions ?? []).filter((revision) => observed || revision.changes)
    .map((revision) => ({ revision, stale: staleClausesOf(revision, clauses, { observed }) }));
  // Whether a revision reaches a step's evidence at a generation. A step it lists is reached at or below the generation
  // it had then. Under switch 1 [CIC:REQ-006] a step it does not list is not exempt: the step that made it is reached by
  // its earlier generations, and any other by every generation not published after the revision.
  const reaches = (revision, phaseId, generation) => {
    const listed = revision.dependentGenerations ?? {};
    if (Object.hasOwn(listed, phaseId)) return Number(generation ?? 0) <= Number(listed[phaseId]);
    if (!observed) return false;
    if (revision.origin?.phase === phaseId) return Number(generation ?? 0) < Number(revision.origin.generation ?? 0);
    const published = (workflow?.phases?.[phaseId]?.generationPublications ?? []).find((entry) => Number(entry.generation) === Number(generation))?.publishedAt;
    return !(published && Date.parse(published) > Date.parse(revision.at));
  };
  const carrierOf = (revision, phaseId, generation) => {
    const origin = revision.origin ?? {};
    if (origin.kind !== 'intent-amendment') return null;
    const answer = carriers.get(`${origin.id}\u0000${phaseId}\u0000${Number(generation)}`);
    return answer && answer.binding.producer === origin.phase && Number(answer.binding.producerGeneration) === Number(origin.generation) ? answer : null;
  };
  // A plan's row the amendment itself carried for this clause, signed by the plan's approvers (scope/carried-evidence.mjs) [PHR:REQ-008].
  const rowCarrierOf = (revision, phaseId, generation, clauseId) => (revision.origin?.kind === 'intent-amendment'
    ? rowCarriers.get(`${revision.origin.id}\u0000${phaseId}\u0000${Number(generation)}\u0000${clauseId}`) ?? null : null);
  const walk = (clauseId, phaseId, generation) => {
    const id = String(clauseId).toUpperCase();
    const carried = [];
    // A step that has not published anything yet has no evidence to be stale; under switch 1 evidence that exists at
    // generation 0 is read like any other [CIC:REQ-006].
    if (!observed && !(Number(generation ?? 0) > 0)) return { revision: null, carried };
    for (let index = revisions.length - 1; index >= 0; index -= 1) {
      const { revision, stale } = revisions[index];
      if (!stale.has(id) || !reaches(revision, phaseId, generation)) continue;
      const answer = carrierOf(revision, phaseId, generation) ?? rowCarrierOf(revision, phaseId, generation, id);
      if (!answer) return { revision, carried };
      carried.push({ revision: revision.revision, amendment: answer.amendment, phase: phaseId, generation: Number(generation),
        actor: answer.actor ?? null, actorName: answer.actorName ?? null, authorityGroup: answer.authorityGroup, at: answer.at ?? null });
    }
    return { revision: null, carried };
  };
  return {
    revisions: revisions.map((entry) => entry.revision),
    staleBy: (clauseId, phaseId, generation) => walk(clauseId, phaseId, generation).revision,
    carriedBy: (clauseId, phaseId, generation) => walk(clauseId, phaseId, generation).carried
  };
}

/** Every clause any revision removed: its earlier evidence is history, not a broken record. */
export function removedClauseIds(workflow) {
  return [...new Set((workflow?.scopeRevisions ?? []).flatMap((revision) => revision.changes?.removed ?? []))].sort();
}
