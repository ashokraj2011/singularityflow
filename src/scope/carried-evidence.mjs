/**
 * Evidence carried across an intent amendment's scope revision on a step's approvers' word [SCS:REQ-022,
 * owner decision 12]. An amendment that updated the spec to what the code does lists the steps that read
 * the scope; each one's own approvers answer "still holds" or return the Story to it. Read by the
 * evidence evaluation (scope/revisions.mjs scopeStaleness), the approval, its history check and every
 * place the approval evidence is shown. Pure: no I/O. Kept out of the eager graph: only those readers load it.
 */
import { countedRecords } from '../presence/counted.mjs';

/**
 * The "still holds" answers that carry a step's evidence across the scope revision of an intent
 * amendment that updated the spec to what the code does [SCS:REQ-022, owner decision 12], keyed by
 * amendment, step and generation. One counts only when the amendment listed that step at that
 * generation (it settled conformance differences and reset nothing), the answer is `unchanged`, it
 * binds the amended scope generation, and it was recorded under one of that step's own approval groups.
 * Any other amendment carries nothing, as before.
 */
export function revalidationCarriers(workflow) {
  const carriers = new Map();
  const answers = countedRecords(workflow, workflow?.amendmentRevalidations);
  for (const amendment of (workflow?.intentAmendments ?? []).filter((entry) => ['approved', 'revalidated'].includes(entry?.status) && entry.producer)) {
    for (const listed of amendment.revalidate ?? []) {
      const policy = workflow?.phases?.[listed.phase]?.approvalPolicy ?? {};
      const groups = [...(policy.authorities ?? []), ...(policy.requiredAuthorities ?? [])];
      const answer = answers.findLast((entry) => entry?.amendment === amendment.id && entry.phase === listed.phase
        && Number(entry.generation) === Number(listed.generation) && entry.outcome === 'unchanged'
        && entry.binding?.producer === amendment.producer && groups.includes(entry.authorityGroup));
      if (answer) carriers.set(`${amendment.id}\u0000${listed.phase}\u0000${Number(listed.generation)}`, { ...answer, clauses: amendment.staleClauses ?? amendment.changedClauses ?? [] });
    }
  }
  return carriers;
}

/**
 * Who said it still holds, as a person reads it: the name a v2 answer keeps beside its actor key, else
 * the key itself (a v1 answer, written before names were kept, has none).
 */
export function revalidatorName(answer) {
  const name = typeof answer?.actorName === 'string' ? answer.actorName.trim() : '';
  if (name) return name;
  if (typeof answer?.actor === 'string') return answer.actor;
  return answer?.actor?.name ?? answer?.actor?.email ?? answer?.actor?.login ?? 'a person';
}

/**
 * What was carried, in words, for each place a person reads it before approving and for the approval
 * itself [SCS:REQ-022]: each "still holds" answer still in force (its step at the generation it
 * answered for), with the amended clauses, the amendment, and who said it (by name) under which group.
 */
export function carriedEvidence(workflow) {
  return [...revalidationCarriers(workflow).values()]
    .filter((answer) => Number(workflow?.phases?.[answer.phase]?.generation) === Number(answer.generation))
    .map((answer) => {
      const step = workflow.phases[answer.phase]?.label ?? answer.phase;
      const by = revalidatorName(answer);
      return { amendment: answer.amendment, phase: answer.phase, generation: Number(answer.generation), clauses: [...answer.clauses],
        by, authorityGroup: answer.authorityGroup, at: answer.at ?? null,
        words: `${answer.clauses.join(', ') || 'The amended clauses'}: ${step}'s evidence predates ${answer.amendment}'s wording; ${by}, for the ${step} approvers (${answer.authorityGroup}), said it still holds.` };
    });
}
