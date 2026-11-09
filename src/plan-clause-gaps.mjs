/**
 * Where an approved plan and the specification's clauses part, after an intent amendment [PHR:REQ-002, finding 15]:
 * each approved clause the plan has no row for, each row for a clause the specification no longer
 * holds, and the plan correction its approvers make for each (--add-row, --remove-row). Pure; loaded
 * only where an amendment is proposed, approved or revalidated.
 */
export function planClauseGaps(workflow, ownerPhase, claims, clauseIds) {
  const active = new Set((clauseIds ?? []).map((id) => String(id).toUpperCase()));
  const planned = new Set(Object.keys(claims ?? {}).map((id) => id.toUpperCase()));
  const unplanned = [...active].filter((id) => !planned.has(id)).sort();
  const removed = [...planned].filter((id) => !active.has(id)).sort();
  const workId = workflow?.workItem?.id;
  const routes = [
    ...unplanned.slice(0, 3).map((id) => ({ command: `singularity-flow decision plan ${workId} --owner ${ownerPhase} --add-row ${id}=<PATH> --test <TEST> --reason <why>`,
      label: `An approver of ${ownerPhase} plans ${id}, which the specification now holds, in their own terminal.` })),
    ...removed.slice(0, 3).map((id) => ({ command: `singularity-flow decision plan ${workId} --owner ${ownerPhase} --remove-row ${id} --reason <why>`,
      label: `An approver of ${ownerPhase} removes the row for ${id}, which the specification no longer holds, in their own terminal.` }))
  ];
  return { phase: ownerPhase, unplanned, removed, routes };
}
