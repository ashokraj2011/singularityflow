/**
 * Translate the deterministic kernel's review checkpoint into the one legal human action.
 *
 * Both draft-check and recovery consume this projection. Keeping it shared prevents one surface
 * from saying "adjudicate" while another sends the user back through deterministic preparation
 * with no state change.
 */
export function convergenceReviewRoute(error, workflow) {
  if (error?.code !== 'CONVERGENCE_REVIEW_REQUIRED') return null;
  const allowed = Array.isArray(error.details?.allowedNext) ? error.details.allowedNext : [];
  const undisposed = Array.isArray(error.details?.undisposedItemIds)
    ? error.details.undisposedItemIds.filter((id) => typeof id === 'string' && id.trim())
    : [];
  if (allowed.includes('adjudicate')) {
    const itemId = undisposed[0] ?? '<ITEM-ID>';
    return Object.freeze({
      kind: 'adjudicate',
      class: 'human-input',
      guidance: `Human convergence review is required. Record a disposition for ${itemId}; then regenerate the deterministic convergence artifact. Never hand-edit it.`,
      command: `singularity-flow story adjudicate ${itemId} --disposition <rework|update-intent|accepted-deviation|dismissed|deferred> --reason <reason> [--clause <CLAUSE-ID> ...]`,
      skill: '/sf-converge'
    });
  }
  if (allowed.includes('create-rework')) return Object.freeze({
    kind: 'rework',
    class: 'human-input',
    guidance: 'Human review selected rework. Preview and confirm the bounded return to implementation; never hand-edit the deterministic convergence artifact.',
    command: `singularity-flow story rework --work-id ${workflow.workItem.id}`,
    skill: '/sf-converge'
  });
  if (allowed.includes('propose-intent-amendment')) return Object.freeze({
    kind: 'intent-amendment',
    class: 'human-input',
    guidance: 'Human review selected an intent change. Propose the reviewed specification amendment through the governed amendment path.',
    command: `singularity-flow story intent-amendment propose --work-id ${workflow.workItem.id} --file <AMENDED-SPEC.md> --reason <reason>`,
    skill: '/sf-converge'
  });
  return Object.freeze({
    kind: 'inspect',
    class: 'human-input',
    guidance: 'The deterministic convergence projection needs a human decision before it can be regenerated or published. Inspect its exact allowed actions.',
    command: `singularity-flow story converge --work-id ${workflow.workItem.id} --json`,
    skill: '/sf-converge'
  });
}
