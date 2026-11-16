/**
 * SPEC-OSA v1.1 §4.3: the publication predicates and version arithmetic, one owner [OSA:REQ-002]. Pure, no imports. Input:
 * a step's version facts (phase-generation-need.mjs versionFactsOf); the old helpers are wrappers over these.
 */
// An absent counter is 0; any other must be a nonnegative safe integer or its decimal string (null is not absent).
const counter = (value) => value === undefined ? 0 : typeof value === 'string' && /^(0|[1-9]\d*)$/u.test(value) ? Number(value) : value;

/**
 * `published`, `writing` (the applicable opening's, or null), `highWatermark`, and `proposedNext` while nothing is open.
 * An opening applies only at max(published, recorded watermark, released reservation) + 1: numbers are never reused, and
 * a later one is impossible. Bad counters give `{ ok: false, code }`, never a plausible number.
 */
export function versionNumbers(facts) {
  const published = counter(facts?.published), recorded = counter(facts?.recordedHighWatermark), reserved = counter(facts?.reservedHighWatermark);
  if (![published, recorded, reserved].every((value) => Number.isSafeInteger(value) && value >= 0)
      || Math.max(published, recorded, reserved) >= Number.MAX_SAFE_INTEGER) return { ok: false, code: 'GENERATION_COUNTER_INVALID' };
  const open = facts?.opening?.status === 'open' ? counter(facts.opening.version) : null;
  // A reservation (§7.2) the live (or amendment-carried) opening holds is its own number; any other is a used one.
  const held = reserved > 0 && ['open', 'superseded'].includes(facts?.opening?.status) && counter(facts.opening.version) === reserved;
  const base = Math.max(published, recorded, held ? 0 : reserved);
  const opening = open === null ? 'none' : !Number.isSafeInteger(open) || open < 1 ? 'invalid'
    : open === base + 1 ? 'applicable' : open <= base ? 'superseded' : 'ahead';
  const writing = opening === 'applicable' ? open : null;
  return { ok: true, published, writing, highWatermark: Math.max(base, reserved, writing ?? 0),
    proposedNext: writing === null ? base + 1 : null, next: base + 1, opening };
}

/** History holds a published version. */
export const hasPublishedVersion = (facts) => versionNumbers(facts).published >= 1;
/** An applicable opening authorizes a version not yet published. */
export const hasOpenVersion = (facts) => versionNumbers(facts).writing != null;
/** The last publication is the current candidate: no applicable successor is open. */
export const currentVersionPublished = (facts) => { const numbers = versionNumbers(facts); return numbers.published >= 1 && numbers.writing === null; };

/** Why the step needs a version, or null (the old phaseNeedsGeneration, with the record's own comparisons). */
export function versionNeed(facts) {
  if (!facts) return 'NO_STEP';
  if (facts.authorConflict) return 'AUTHOR_CONFLICT';
  const baseline = facts.amendment?.baseline;
  if (facts.amendment && (!Number.isSafeInteger(baseline) || baseline < 0 || !Number.isSafeInteger(facts.published)
    || facts.published <= baseline)) return 'AMENDMENT';
  if (facts.versionRequired === false) return null;
  if (facts.published < 1) return 'INITIAL_VERSION';
  if (facts.rework && facts.published <= facts.rework.version) return 'REWORK';
  return facts.rejection && !facts.rejection.rewritten ? 'REJECTED' : null;
}
export const needsVersion = (facts) => versionNeed(facts) !== null;

/**
 * Being written: in progress, needing a version or with one open. Invalid counters, or an opening past the next number,
 * are not [§12.1]; an opening at a used number opens nothing (a restored checkpoint leaves one) but needs no repair.
 */
export function beingWritten(facts) {
  const numbers = facts?.status === 'in_progress' ? versionNumbers(facts) : null;
  return Boolean(numbers?.ok && numbers.opening !== 'ahead' && (needsVersion(facts) || numbers.writing !== null));
}

/** A consumed opening that is the published version's receipt (a return for rework leaves this). */
export const consumedByPublishedVersion = (facts) => facts?.opening?.status === 'consumed' && Number(facts.published) > 0
  && Number(facts.opening.version) === Number(facts.published);

/** Positive damage: a step that needs a version holds a consumed opening that is not its published version's receipt. */
export const consumedOpeningMismatch = (facts) => facts?.status === 'in_progress' && facts.opening?.status === 'consumed'
  && needsVersion(facts) && !consumedByPublishedVersion(facts);

/** Published and recorded with nothing open past it (the old hasPublishedPhaseGeneration; it asks for the record). */
export function publishedVersionRecorded(facts) {
  const published = Number(facts?.published);
  if (!Number.isSafeInteger(published) || published < 1 || facts.opening?.status === 'open') return false;
  return consumedByPublishedVersion(facts) || facts.publicationRecorded === true;
}

/** A person's return or rejection authorized the successor: it opens from the publication, not by a new preview. */
export const reopenedByReturn = (facts) => explicitlyReopened(facts) || Boolean(facts?.rejection && !facts.rejection.rewritten);

/** Reopened by a person's return (change request, rework, affected amendment, unrevalidated intent amendment). */
export function explicitlyReopened(facts) {
  return Boolean(facts?.changeRequestOpen || (facts?.rework && needsVersion(facts))
    || (facts?.amendment && needsVersion(facts)) || facts?.intentAmendmentPending);
}
