/**
 * A person's dispute of the reviewer's blocking finding (owner, 2026-11-20: "yes add a dispute this finding choice"), in the
 * words every surface shows it. Pure: the VS Code bundles read it too.
 *
 * The dispute is the review's own human disposition `dispute:<finding ID>`, recorded beside the review it answers, under the
 * step's approval rules (source-review-lifecycle.mjs). A disputed finding stays in the review with the person's reason; it
 * blocks neither the next version SFlow would start for it nor the step's submission, and the step's approvers see it.
 */
export const DISPUTE_PREFIX = 'dispute:';

/** "The reviewer's finding F-2 is disputed by Ana: the clause asks for a count, not a list." */
export function disputedFindingWords(id, { by = null, reason = '' } = {}) {
  const why = String(reason ?? '').replace(/\s+/gu, ' ').trim().replace(/[.!?]*$/u, '');
  return `The reviewer's finding ${id} is disputed by ${by || 'a person'}: ${why}.`;
}
