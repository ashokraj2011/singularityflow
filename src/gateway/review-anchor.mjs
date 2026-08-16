/**
 * What a reviewer should be shown a diff *against*. `[UXH:REQ-080]`
 *
 * The spec asks for a diff against the previous *relevant* generation. Screen B asks for something
 * stronger and more useful: the diff is anchored to **your last decision** — "vs g2 (your last
 * approval)" — and when that decision was a rejection it quotes your own words back at you:
 * *"Changed because you sent g2 back: 'idempotency unclear on retry path'"*.
 *
 * The difference matters on the second pass. "Previous relevant generation" is a fact about the
 * artifact; "since you last looked" is a fact about the reviewer, and it is the one that decides
 * whether they can skim or must read again. A reviewer who approved g2, was away while g3 and g4
 * happened, and is now asked about g5, is served by a diff against g2 and misled by one against g4.
 *
 * Everything here is derived from records already written at decision time — `actor`, `decision`,
 * `generation`, `reason` are all on the approval entry. Nothing is inferred, and where there is no
 * prior decision that is reported rather than smoothed into "since the beginning".
 */

/** Why a reviewer is being shown this comparison, and never a guess. */
export const ANCHOR_KINDS = Object.freeze(['your-approval', 'your-rejection', 'first-review', 'unknown-reviewer']);

/**
 * Decisions this reviewer made on this phase, newest first.
 *
 * Invalidated decisions are excluded: `invalidatedAt` marks a decision the lifecycle has already
 * annulled, and anchoring a diff to one would show a reviewer a comparison against a judgement that
 * no longer counts — worse than no anchor, because it looks authoritative.
 */
function decisionsBy(phase, actorId) {
  return (phase?.approvals ?? [])
    .filter((entry) => entry && !entry.invalidatedAt && entry.actor === actorId)
    .slice()
    .sort((left, right) => String(right.at ?? '').localeCompare(String(left.at ?? '')));
}

/**
 * The generation to diff against, and why.
 *
 * `actorId` is required and unmatched actors are reported as `unknown-reviewer` rather than falling
 * back to the newest decision by anybody. Showing one reviewer a diff anchored to a *different*
 * reviewer's approval, labelled "your last approval", is the kind of confident wrongness that gets
 * a change approved on the strength of somebody else's reading.
 */
export function reviewAnchor(phase, { actorId = null } = {}) {
  const current = phase?.generation ?? 0;

  if (!actorId) {
    return { kind: 'unknown-reviewer', generation: null, current, reason: null, at: null, decisions: 0 };
  }

  const mine = decisionsBy(phase, actorId);
  if (!mine.length) {
    /**
     * A first look, said as one.
     *
     * The alternative — anchoring to generation 0 and calling it a diff — presents the entire
     * artifact as "what changed", which trains reviewers to skim exactly when they should not.
     */
    return { kind: 'first-review', generation: null, current, reason: null, at: null, decisions: 0 };
  }

  const last = mine[0];
  return {
    kind: last.decision === 'rejected' ? 'your-rejection' : 'your-approval',
    generation: last.generation ?? null,
    current,
    /**
     * The reviewer's own words, carried back to them. `[UXH:REQ-080]`
     *
     * Only for a rejection: an approval has no complaint to answer, and inventing one would be
     * putting words in their mouth. Null is the honest value for an approval and for a rejection
     * recorded without a comment.
     */
    reason: last.decision === 'rejected' ? (last.reason ?? null) : null,
    at: last.at ?? null,
    decisions: mine.length
  };
}

/**
 * Whether this anchor still describes the artifact in front of the reviewer.
 *
 * A diff against a generation that *is* the current one has nothing to show, and saying "since your
 * last approval" over an empty diff reads as "nothing changed" when the truth is "you are looking
 * at the thing you already approved".
 */
export function anchorIsStale(anchor) {
  return Boolean(anchor?.generation !== null && anchor?.generation === anchor?.current);
}
