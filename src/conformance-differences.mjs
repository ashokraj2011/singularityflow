/**
 * Spec–code sync [SCS:REQ-010]: the conformance verdicts that say the code differs from its clause, and
 * whether a Story decides them. Import-free, so approval, the gates and the decision list can ask it
 * from any path without loading the report reader.
 */

/** Verdicts saying the code differs from the clause, rather than falls short of it. */
export const DIFFERENCE_VERDICTS = Object.freeze(['deviated', 'unplanned']);

/**
 * Whether this Story decides deviated and unplanned rows like partial and missing ones: its pinned spec
 * policy says `decide`. Read from the pinned raw field, never a normalized default, so a Story started
 * before the field existed keeps the rule its report was approved under.
 */
export function decidesConformanceDifferences(workflow) {
  return workflow?.resolution?.spec?.conformanceDifferences === 'decide';
}
