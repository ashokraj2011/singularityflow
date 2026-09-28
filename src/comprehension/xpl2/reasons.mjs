/**
 * Closed XPL2 reason vocabulary.
 *
 * Unknown, not recorded, disabled, inaccessible, stale, incomplete, corrupt and not applicable are
 * different facts [XPL2-LAW-002]. Every availability, observation and diagnostic in an XPL2 view
 * uses exactly one of these codes so a consumer can tell "nothing was recorded here" from "this
 * reader could not look". Adapter-owned detail codes may be nested beside them; they are never the
 * canonical identity.
 */
export const XPL2_REASONS = Object.freeze({
  'subject-ambiguous': 'More than one exact subject matched; choose one explicitly.',
  'subject-unknown': 'The requested explanation subject is not one of the six XPL2 subjects.',
  'subject-not-found': 'No exact subject matched inside the selected authorized scope.',
  'source-moved': 'The repository changed while this view was being captured.',
  'source-inaccessible': 'The source exists but this reader could not read it.',
  'source-not-recorded': 'The captured authorized scope contains no record of this kind.',
  'recording-disabled': 'Recording for this source is disabled by its owner.',
  'source-expired': 'The source was recorded but is no longer retained.',
  'snapshot-kind-mismatch': 'The source belongs to a different kind of subject than this view.',
  'evaluation-unavailable': 'No evaluation owner produced a result for this exact subject.',
  'evaluation-incomplete': 'The evaluation owner reported an incomplete required set.',
  'source-scope-mismatch': 'The source describes a different subject, revision or scope.',
  'region-only-association': 'The association is recorded for the whole change region, not an exact hunk.',
  'origin-unestablished': 'No admitted record establishes who or what produced this content.',
  'narrative-semantic-support-unverified': 'Citation syntax does not establish semantic support.',
  'unsupported-source-version': 'The source uses a record version this reader does not support.',
  'partial-inventory': 'Enumeration stopped at a declared bound; totals are lower bounds.',
  'access-view-changed': 'The access view changed after this projection was built.',
  'revalidation-unestablished': 'No qualified owner established that earlier evidence still applies.',
  'adapter-unavailable': 'This release has no admitted reader for that source.',
  'feature-disabled': 'The optional feature that produces this source is not enabled.',
  'integrity-failed': 'The source failed its identity or integrity check and contributes no facts.',
  'not-applicable': 'This source does not apply to the selected subject.',
  'complete-empty': 'The owner reported a complete set with no entries.',
  'opaque-content': 'The change is counted but its content is not represented as text.',
  'text-projection-unavailable': 'The captured diff was not projected into text hunks for this snapshot; the change is counted but not shown as text.',
  'untracked-content-excluded': 'New untracked file bodies are excluded from automatic projection.',
  'no-active-story': 'No Story is bound to this repository view.',
  'outside-change-set': 'The location is not inside any change unit of the captured interval.',
  'bounded-delivery': 'The response was bounded; omitted members remain counted.',
  'owner-reported-failure': 'The source owner recorded a failing or unfinished result.',
  'owner-reported-gap': 'The source owner reported this gap in its own record.',
  'conflicting-sources': 'Admitted sources disagree; all of them are shown and none is preferred.',
  'navigation-hint-only': 'Cached declarations help navigation; they do not establish ownership, coverage or behavior.'
});

export const XPL2_REASON_CODES = Object.freeze(Object.keys(XPL2_REASONS));

const KNOWN = new Set(XPL2_REASON_CODES);

/** Return the closed code, refusing an unregistered one rather than inventing vocabulary. */
export function xpl2Reason(code) {
  if (!KNOWN.has(code)) {
    throw new TypeError(`Unregistered XPL2 reason '${String(code)}'.`);
  }
  return code;
}

export function xpl2ReasonText(code) {
  return XPL2_REASONS[xpl2Reason(code)];
}

/** Availability states are a closed set too; a missing source is never silently `available`. */
export const XPL2_AVAILABILITY = Object.freeze([
  'available', 'partial', 'unavailable', 'not-applicable', 'disabled'
]);
